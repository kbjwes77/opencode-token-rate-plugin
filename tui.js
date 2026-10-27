import { effect as _$effect } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
import { Plugin } from "@opencode/plugin/tui";
import { createSignal, onCleanup } from "solid-js";
import { WINDOW, cycleViewIndex, emptyTotals, formatValue, minuteOf, perMinuteSeries, pruneMinutes, segmentAt, segmentLabel, sparkline, summarize, viewAt } from "./src/metrics.ts";

/** In-memory, per-session record of completed-step speeds and per-minute token usage. */

/** Fallback column budget used until the footer has been measured. */
const DEFAULT_WIDTH = 24;

/** How often the usage window re-slides while idle (the store only changes on activity). */
const TICK_MS = 15_000;

/** Default keybind for cycling the footer view; override with the `keybind` plugin option. */
const DEFAULT_KEYBIND = "ctrl+alt+t";
export default Plugin.define({
  id: "opencode.tps-sparkline",
  setup(context) {
    const [state, update] = context.storage.memory("opencode.tps-sparkline", {
      initial: {
        sessions: {},
        view: 0
      }
    });

    // The memory store is shared across plugin hot reloads, so a reload can hand
    // us state written by an older generation: sessions with no `minutes` (usage
    // was added later) and a missing `view`. Migrate it in place once, up front.
    update(draft => {
      if (!Number.isFinite(draft.view)) draft.view = 0;
      for (const id of Object.keys(draft.sessions)) {
        const session = draft.sessions[id];
        if (!session) continue;
        if (!session.points) session.points = [];
        if (!session.minutes) session.minutes = {};
      }
    });

    // Timing scratch space for the step currently streaming, keyed by message id.
    const pending = new Map();
    // Message ids already recorded, so a replayed event cannot double-count.
    // Points and usage are tracked separately: a step that could not resolve its
    // timing on the first pass may still contribute a point on a later replay.
    const recordedPoints = new Set();
    const recordedUsage = new Set();
    const MAX_TRACKED = 256;
    const track = (seen, id) => {
      seen.add(id);
      if (seen.size > MAX_TRACKED) {
        const oldest = seen.values().next().value;
        if (oldest !== undefined) seen.delete(oldest);
      }
    };

    // Returns the session, backfilling fields a pre-usage generation may not have
    // written, so a hot reload can never leave us dereferencing `undefined`.
    const ensureSession = (draft, sessionID) => {
      const existing = draft.sessions[sessionID];
      if (!existing) return draft.sessions[sessionID] = {
        points: [],
        minutes: {}
      };
      if (!existing.points) existing.points = [];
      if (!existing.minutes) existing.minutes = {};
      return existing;
    };
    const recordPoint = (sessionID, point) => {
      update(draft => {
        const session = ensureSession(draft, sessionID);
        session.points.push(point);
        if (session.points.length > WINDOW) {
          session.points.splice(0, session.points.length - WINDOW);
        }
      });
    };

    // Fold one step's tokens into its wall-clock minute, then drop minutes that
    // have aged out of the rolling window so per-session memory stays bounded.
    const recordUsage = (sessionID, at, totals) => {
      const key = String(minuteOf(at));
      update(draft => {
        const session = ensureSession(draft, sessionID);
        const bucket = session.minutes[key] ?? (session.minutes[key] = emptyTotals());
        bucket.output += totals.output;
        bucket.reasoning += totals.reasoning;
        bucket.input += totals.input;
        bucket.cache += totals.cache;
        pruneMinutes(session.minutes);
      });
    };
    const cycleView = delta => {
      update(draft => {
        draft.view = cycleViewIndex(draft.view, delta);
      });
    };

    // A "step" is one model generation and maps 1:1 to an assistant message.
    const offStarted = context.data.on("session.step.started", event => {
      pending.set(event.data.assistantMessageID, {
        started: event.data.started
      });
    });
    const offStreamed = context.data.on("session.step.streamed", event => {
      const entry = pending.get(event.data.assistantMessageID) ?? {};
      entry.streamed = event.created;
      pending.set(event.data.assistantMessageID, entry);
    });
    const offEnded = context.data.on("session.step.ended", event => {
      const messageID = event.data.assistantMessageID;
      const entry = pending.get(messageID);
      pending.delete(messageID);
      const tokens = event.data.tokens;
      const usage = {
        output: tokens.output ?? 0,
        reasoning: tokens.reasoning ?? 0,
        input: tokens.input ?? 0,
        cache: (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0)
      };
      let started = entry?.started;
      let streamed = entry?.streamed;

      // Fall back to the persisted message if we missed an event (e.g. reload).
      if (started === undefined || streamed === undefined) {
        const message = context.data.session.message.get(event.data.sessionID, messageID);
        if (message?.type === "assistant") {
          started ??= message.time.created;
          streamed ??= message.time.streamed;
        }
      }

      // Usage is counted whenever tokens were consumed, even if timing is missing.
      const consumed = usage.output + usage.reasoning + usage.input + usage.cache;
      if (consumed > 0 && !recordedUsage.has(messageID)) {
        track(recordedUsage, messageID);
        recordUsage(event.data.sessionID, streamed ?? event.created ?? Date.now(), usage);
      }
      const count = usage.output + usage.reasoning;
      if (started === undefined || streamed === undefined) return;
      const seconds = (streamed - started) / 1000;
      if (count <= 0 || seconds <= 0) return;
      if (recordedPoints.has(messageID)) return;
      track(recordedPoints, messageID);
      recordPoint(event.data.sessionID, count / seconds);
    });
    const disposeSlot = context.ui.slot({
      append: "sidebar.footer",
      render: input => _$createComponent(SparklineFooter, {
        get theme() {
          return context.theme;
        },
        state: state,
        get sessionID() {
          return input.sessionID;
        },
        onCycle: cycleView
      })
    });

    // Keyboard cycling. Optional: if the host has no keymap, the footer toggle
    // (and the command's absence) is harmless, so never let registration break setup.
    try {
      const keymap = context.keymap;
      if (keymap && typeof keymap.layer === "function") {
        const keybind = context.options?.keybind ?? DEFAULT_KEYBIND;
        keymap.layer(() => ({
          mode: "global",
          commands: [{
            id: "opencode.tps-sparkline.cycle",
            title: "Token rate: cycle sparkline view",
            description: "Switch the sidebar sparkline between throughput and per-minute token usage views.",
            bind: keybind,
            run: () => {
              cycleView(1);
            }
          }]
        }));
      }
    } catch (error) {
      // Keyboard cycling is a progressive enhancement over the toggle, so never
      // let registration break setup — but leave a breadcrumb if it fails.
      globalThis.console?.warn?.("opencode.tps-sparkline: keymap registration failed", error);
    }
    return () => {
      offStarted();
      offStreamed();
      offEnded();
      disposeSlot();
    };
  }
});
export function SparklineFooter(props) {
  const [width, setWidth] = createSignal(DEFAULT_WIDTH);
  const [now, setNow] = createSignal(Date.now());
  // The sparkline column under the cursor, or null when the cursor is elsewhere.
  const [hover, setHover] = createSignal(null);

  // The store only changes on activity, so tick to slide the usage window while idle.
  const timer = setInterval(() => setNow(Date.now()), TICK_MS);
  timer.unref?.();
  onCleanup(() => clearInterval(timer));
  const session = () => props.state.sessions[props.sessionID];
  const view = () => viewAt(props.state.view);
  const series = () => {
    const active = view();
    if (active.field === null) return session()?.points ?? [];
    return perMinuteSeries(session()?.minutes, active.field, now());
  };
  const summary = () => summarize(series());
  const bars = () => sparkline(series(), width());
  const cycle = delta => props.onCycle?.(delta);

  // Stats for the point under the cursor, or "" when nothing is hovered.
  const hoverText = () => {
    const column = hover();
    if (column === null) return "";
    const segment = segmentAt(series(), width(), column);
    return segment ? segmentLabel(view(), segment) : "";
  };
  return (() => {
    var _el$ = _$createElement("box"),
      _el$2 = _$createElement("box"),
      _el$3 = _$createElement("box"),
      _el$4 = _$createElement("text"),
      _el$5 = _$createElement("text"),
      _el$6 = _$createElement("box"),
      _el$7 = _$createElement("text"),
      _el$8 = _$createTextNode(`avg `),
      _el$9 = _$createElement("text"),
      _el$0 = _$createTextNode(`max `),
      _el$1 = _$createElement("text"),
      _el$10 = _$createElement("box"),
      _el$11 = _$createElement("box"),
      _el$12 = _$createElement("text"),
      _el$14 = _$createElement("text"),
      _el$15 = _$createElement("text"),
      _el$17 = _$createElement("text");
    _$insertNode(_el$, _el$2);
    _$insertNode(_el$, _el$1);
    _$insertNode(_el$, _el$10);
    _$setProp(_el$, "flexDirection", "column");
    _$setProp(_el$, "width", "100%");
    _$setProp(_el$, "flexShrink", 0);
    _$setProp(_el$, "onSizeChange", function () {
      if (this.width > 0) setWidth(this.width);
    });
    _$insertNode(_el$2, _el$3);
    _$insertNode(_el$2, _el$6);
    _$setProp(_el$2, "flexDirection", "row");
    _$setProp(_el$2, "width", "100%");
    _$setProp(_el$2, "justifyContent", "space-between");
    _$setProp(_el$2, "gap", 2);
    _$insertNode(_el$3, _el$4);
    _$insertNode(_el$3, _el$5);
    _$setProp(_el$3, "flexDirection", "row");
    _$setProp(_el$3, "gap", 1);
    _$setProp(_el$4, "wrapMode", "none");
    _$insert(_el$4, () => formatValue(summary().current));
    _$setProp(_el$5, "wrapMode", "none");
    _$insert(_el$5, () => view().unit);
    _$insertNode(_el$6, _el$7);
    _$insertNode(_el$6, _el$9);
    _$setProp(_el$6, "flexDirection", "row");
    _$setProp(_el$6, "gap", 1);
    _$insertNode(_el$7, _el$8);
    _$setProp(_el$7, "wrapMode", "none");
    _$insert(_el$7, () => formatValue(summary().average), null);
    _$insertNode(_el$9, _el$0);
    _$setProp(_el$9, "wrapMode", "none");
    _$insert(_el$9, () => formatValue(summary().max), null);
    _$setProp(_el$1, "wrapMode", "none");
    _$setProp(_el$1, "onMouseMove", function (event) {
      // Columns are absolute; subtract the sparkline's own origin to index it.
      setHover(event.x - this.screenX);
    });
    _$setProp(_el$1, "onMouseOut", () => setHover(null));
    _$insert(_el$1, bars);
    _$insertNode(_el$10, _el$11);
    _$insertNode(_el$10, _el$17);
    _$setProp(_el$10, "flexDirection", "row");
    _$setProp(_el$10, "width", "100%");
    _$setProp(_el$10, "justifyContent", "space-between");
    _$setProp(_el$10, "gap", 2);
    _$insertNode(_el$11, _el$12);
    _$insertNode(_el$11, _el$14);
    _$insertNode(_el$11, _el$15);
    _$setProp(_el$11, "flexDirection", "row");
    _$setProp(_el$11, "gap", 1);
    _$setProp(_el$11, "flexShrink", 0);
    _$insertNode(_el$12, _$createTextNode(`‹`));
    _$setProp(_el$12, "wrapMode", "none");
    _$setProp(_el$12, "onMouseDown", () => cycle(-1));
    _$setProp(_el$14, "wrapMode", "none");
    _$setProp(_el$14, "onMouseDown", () => cycle(1));
    _$insert(_el$14, () => view().label);
    _$insertNode(_el$15, _$createTextNode(`›`));
    _$setProp(_el$15, "wrapMode", "none");
    _$setProp(_el$15, "onMouseDown", () => cycle(1));
    _$setProp(_el$17, "wrapMode", "none");
    _$insert(_el$17, hoverText);
    _$effect(_p$ => {
      var _v$ = summary().current === undefined ? props.theme.text.faint : props.theme.text.base,
        _v$2 = props.theme.text.muted,
        _v$3 = props.theme.text.muted,
        _v$4 = props.theme.text.muted,
        _v$5 = props.theme.hue.accent[500],
        _v$6 = props.theme.text.muted,
        _v$7 = props.theme.hue.accent[500],
        _v$8 = props.theme.text.muted,
        _v$9 = props.theme.text.base;
      _v$ !== _p$.e && (_p$.e = _$setProp(_el$4, "fg", _v$, _p$.e));
      _v$2 !== _p$.t && (_p$.t = _$setProp(_el$5, "fg", _v$2, _p$.t));
      _v$3 !== _p$.a && (_p$.a = _$setProp(_el$7, "fg", _v$3, _p$.a));
      _v$4 !== _p$.o && (_p$.o = _$setProp(_el$9, "fg", _v$4, _p$.o));
      _v$5 !== _p$.i && (_p$.i = _$setProp(_el$1, "fg", _v$5, _p$.i));
      _v$6 !== _p$.n && (_p$.n = _$setProp(_el$12, "fg", _v$6, _p$.n));
      _v$7 !== _p$.s && (_p$.s = _$setProp(_el$14, "fg", _v$7, _p$.s));
      _v$8 !== _p$.h && (_p$.h = _$setProp(_el$15, "fg", _v$8, _p$.h));
      _v$9 !== _p$.r && (_p$.r = _$setProp(_el$17, "fg", _v$9, _p$.r));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined,
      o: undefined,
      i: undefined,
      n: undefined,
      s: undefined,
      h: undefined,
      r: undefined
    });
    return _el$;
  })();
}
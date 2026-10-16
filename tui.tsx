import { Plugin } from "@opencode/plugin/tui"
import type { ResolvedTheme } from "@opencode/theme/tui"
import { createSignal, onCleanup } from "solid-js"
import type { Store } from "solid-js/store"
import {
  WINDOW,
  cycleViewIndex,
  emptyTotals,
  formatValue,
  minuteOf,
  perMinuteSeries,
  pruneMinutes,
  segmentAt,
  segmentLabel,
  sparkline,
  summarize,
  viewAt,
  type UsageTotals,
} from "./src/metrics.ts"

/** In-memory, per-session record of completed-step speeds and per-minute token usage. */
type SessionData = {
  /** Tokens/second, one point per completed step (throughput view). */
  points: number[]
  /** Epoch-minute keyed token totals, split by category (usage views). */
  minutes: Record<string, UsageTotals>
}

type TpsState = {
  sessions: Record<string, SessionData>
  /** Index into VIEWS; shared across sessions so the toggle is global. */
  view: number
}

/** Fallback column budget used until the footer has been measured. */
const DEFAULT_WIDTH = 24

/** How often the usage window re-slides while idle (the store only changes on activity). */
const TICK_MS = 15_000

/** Default keybind for cycling the footer view; override with the `keybind` plugin option. */
const DEFAULT_KEYBIND = "ctrl+alt+t"

export default Plugin.define({
  id: "opencode.tps-sparkline",
  setup(context) {
    const [state, update] = context.storage.memory<TpsState>("opencode.tps-sparkline", {
      initial: { sessions: {}, view: 0 },
    })

    // The memory store is shared across plugin hot reloads, so a reload can hand
    // us state written by an older generation: sessions with no `minutes` (usage
    // was added later) and a missing `view`. Migrate it in place once, up front.
    update((draft) => {
      if (!Number.isFinite(draft.view)) draft.view = 0
      for (const id of Object.keys(draft.sessions)) {
        const session = draft.sessions[id]
        if (!session) continue
        if (!session.points) session.points = []
        if (!session.minutes) session.minutes = {}
      }
    })

    // Timing scratch space for the step currently streaming, keyed by message id.
    const pending = new Map<string, { started?: number; streamed?: number }>()
    // Message ids already recorded, so a replayed event cannot double-count.
    // Points and usage are tracked separately: a step that could not resolve its
    // timing on the first pass may still contribute a point on a later replay.
    const recordedPoints = new Set<string>()
    const recordedUsage = new Set<string>()
    const MAX_TRACKED = 256

    const track = (seen: Set<string>, id: string) => {
      seen.add(id)
      if (seen.size > MAX_TRACKED) {
        const oldest = seen.values().next().value
        if (oldest !== undefined) seen.delete(oldest)
      }
    }

    // Returns the session, backfilling fields a pre-usage generation may not have
    // written, so a hot reload can never leave us dereferencing `undefined`.
    const ensureSession = (draft: TpsState, sessionID: string): SessionData => {
      const existing = draft.sessions[sessionID]
      if (!existing) return (draft.sessions[sessionID] = { points: [], minutes: {} })
      if (!existing.points) existing.points = []
      if (!existing.minutes) existing.minutes = {}
      return existing
    }

    const recordPoint = (sessionID: string, point: number) => {
      update((draft) => {
        const session = ensureSession(draft, sessionID)
        session.points.push(point)
        if (session.points.length > WINDOW) {
          session.points.splice(0, session.points.length - WINDOW)
        }
      })
    }

    // Fold one step's tokens into its wall-clock minute, then drop minutes that
    // have aged out of the rolling window so per-session memory stays bounded.
    const recordUsage = (sessionID: string, at: number, totals: UsageTotals) => {
      const key = String(minuteOf(at))
      update((draft) => {
        const session = ensureSession(draft, sessionID)
        const bucket = session.minutes[key] ?? (session.minutes[key] = emptyTotals())
        bucket.output += totals.output
        bucket.reasoning += totals.reasoning
        bucket.input += totals.input
        bucket.cache += totals.cache
        pruneMinutes(session.minutes)
      })
    }

    const cycleView = (delta: number) => {
      update((draft) => {
        draft.view = cycleViewIndex(draft.view, delta)
      })
    }

    // A "step" is one model generation and maps 1:1 to an assistant message.
    const offStarted = context.data.on("session.step.started", (event) => {
      pending.set(event.data.assistantMessageID, { started: event.data.started })
    })

    const offStreamed = context.data.on("session.step.streamed", (event) => {
      const entry = pending.get(event.data.assistantMessageID) ?? {}
      entry.streamed = event.created
      pending.set(event.data.assistantMessageID, entry)
    })

    const offEnded = context.data.on("session.step.ended", (event) => {
      const messageID = event.data.assistantMessageID
      const entry = pending.get(messageID)
      pending.delete(messageID)

      const tokens = event.data.tokens
      const usage: UsageTotals = {
        output: tokens.output ?? 0,
        reasoning: tokens.reasoning ?? 0,
        input: tokens.input ?? 0,
        cache: (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0),
      }

      let started = entry?.started
      let streamed = entry?.streamed

      // Fall back to the persisted message if we missed an event (e.g. reload).
      if (started === undefined || streamed === undefined) {
        const message = context.data.session.message.get(event.data.sessionID, messageID)
        if (message?.type === "assistant") {
          started ??= message.time.created
          streamed ??= message.time.streamed
        }
      }

      // Usage is counted whenever tokens were consumed, even if timing is missing.
      const consumed = usage.output + usage.reasoning + usage.input + usage.cache
      if (consumed > 0 && !recordedUsage.has(messageID)) {
        track(recordedUsage, messageID)
        recordUsage(event.data.sessionID, streamed ?? event.created ?? Date.now(), usage)
      }

      const count = usage.output + usage.reasoning
      if (started === undefined || streamed === undefined) return
      const seconds = (streamed - started) / 1000
      if (count <= 0 || seconds <= 0) return
      if (recordedPoints.has(messageID)) return

      track(recordedPoints, messageID)
      recordPoint(event.data.sessionID, count / seconds)
    })

    const disposeSlot = context.ui.slot({
      append: "sidebar.footer",
      render: (input) => (
        <SparklineFooter
          theme={context.theme}
          state={state}
          sessionID={input.sessionID}
          onCycle={cycleView}
        />
      ),
    })

    // Keyboard cycling. Optional: if the host has no keymap, the footer toggle
    // (and the command's absence) is harmless, so never let registration break setup.
    try {
      const keymap = context.keymap
      if (keymap && typeof keymap.layer === "function") {
        const keybind = context.options?.keybind ?? DEFAULT_KEYBIND
        keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "opencode.tps-sparkline.cycle",
              title: "Token rate: cycle sparkline view",
              description: "Switch the sidebar sparkline between throughput and per-minute token usage views.",
              bind: keybind,
              run: () => {
                cycleView(1)
              },
            },
          ],
        }))
      }
    } catch (error) {
      // Keyboard cycling is a progressive enhancement over the toggle, so never
      // let registration break setup — but leave a breadcrumb if it fails.
      globalThis.console?.warn?.("opencode.tps-sparkline: keymap registration failed", error)
    }

    return () => {
      offStarted()
      offStreamed()
      offEnded()
      disposeSlot()
    }
  },
})

export function SparklineFooter(props: {
  theme: ResolvedTheme
  state: Store<TpsState>
  sessionID: string
  /** Advance the shared view index; supplied by the plugin, optional for standalone renders. */
  onCycle?: (delta: number) => void
}) {
  const [width, setWidth] = createSignal(DEFAULT_WIDTH)
  const [now, setNow] = createSignal(Date.now())
  // The sparkline column under the cursor, or null when the cursor is elsewhere.
  const [hover, setHover] = createSignal<number | null>(null)

  // The store only changes on activity, so tick to slide the usage window while idle.
  const timer = setInterval(() => setNow(Date.now()), TICK_MS)
  timer.unref?.()
  onCleanup(() => clearInterval(timer))

  const session = () => props.state.sessions[props.sessionID]
  const view = () => viewAt(props.state.view)

  const series = () => {
    const active = view()
    if (active.field === null) return session()?.points ?? []
    return perMinuteSeries(session()?.minutes, active.field, now())
  }

  const summary = () => summarize(series())
  const bars = () => sparkline(series(), width())
  const cycle = (delta: number) => props.onCycle?.(delta)

  // Stats for the point under the cursor, or "" when nothing is hovered.
  const hoverText = () => {
    const column = hover()
    if (column === null) return ""
    const segment = segmentAt(series(), width(), column)
    return segment ? segmentLabel(view(), segment) : ""
  }

  return (
    <box
      flexDirection="column"
      width="100%"
      flexShrink={0}
      onSizeChange={function () {
        if (this.width > 0) setWidth(this.width)
      }}
    >
      <box flexDirection="row" width="100%" justifyContent="space-between" gap={2}>
        <box flexDirection="row" gap={1}>
          <text wrapMode="none" fg={summary().current === undefined ? props.theme.text.faint : props.theme.text.base}>
            {formatValue(summary().current)}
          </text>
          <text wrapMode="none" fg={props.theme.text.muted}>
            {view().unit}
          </text>
        </box>
        <box flexDirection="row" gap={1}>
          <text wrapMode="none" fg={props.theme.text.muted}>
            avg {formatValue(summary().average)}
          </text>
          <text wrapMode="none" fg={props.theme.text.muted}>
            max {formatValue(summary().max)}
          </text>
        </box>
      </box>
      <text
        wrapMode="none"
        fg={props.theme.hue.accent[500]}
        onMouseMove={function (event) {
          // Columns are absolute; subtract the sparkline's own origin to index it.
          setHover(event.x - this.screenX)
        }}
        onMouseOut={() => setHover(null)}
      >
        {bars()}
      </text>
      <box flexDirection="row" width="100%" justifyContent="space-between" gap={2}>
        {/* The toggle is the interactive control, so it keeps its width and the
            hover readout is what clips when the sidebar is too narrow. */}
        <box flexDirection="row" gap={1} flexShrink={0}>
          <text wrapMode="none" fg={props.theme.text.muted} onMouseDown={() => cycle(-1)}>
            {"\u2039"}
          </text>
          <text wrapMode="none" fg={props.theme.hue.accent[500]} onMouseDown={() => cycle(1)}>
            {view().label}
          </text>
          <text wrapMode="none" fg={props.theme.text.muted} onMouseDown={() => cycle(1)}>
            {"\u203a"}
          </text>
        </box>
        <text wrapMode="none" fg={props.theme.text.base}>
          {hoverText()}
        </text>
      </box>
    </box>
  )
}

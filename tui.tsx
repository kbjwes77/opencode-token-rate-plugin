import { Plugin } from "@opencode/plugin/tui"
import type { ResolvedTheme } from "@opencode/theme/tui"
import { createSignal } from "solid-js"
import type { Store } from "solid-js/store"
import { UNIT, WINDOW, formatValue, sparkline, summarize } from "./src/metrics.ts"

/** In-memory, per-session record of completed-step token speeds (tok/s). */
type TpsState = {
  sessions: Record<string, { points: number[] }>
}

/** Fallback column budget used until the footer has been measured. */
const DEFAULT_WIDTH = 24

export default Plugin.define({
  id: "opencode.tps-sparkline",
  setup(context) {
    const [state, update] = context.storage.memory<TpsState>("opencode.tps-sparkline", {
      initial: { sessions: {} },
    })

    // Timing scratch space for the step currently streaming, keyed by message id.
    const pending = new Map<string, { started?: number; streamed?: number }>()
    // Message ids already recorded, so a replayed event cannot double-count.
    const recorded = new Set<string>()
    const MAX_TRACKED = 256

    const record = (sessionID: string, point: number) => {
      update((draft) => {
        const session = draft.sessions[sessionID] ?? (draft.sessions[sessionID] = { points: [] })
        session.points.push(point)
        if (session.points.length > WINDOW) {
          session.points.splice(0, session.points.length - WINDOW)
        }
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
      if (started === undefined || streamed === undefined) return

      const tokens = event.data.tokens
      const count = (tokens.output ?? 0) + (tokens.reasoning ?? 0)
      const seconds = (streamed - started) / 1000
      if (count <= 0 || seconds <= 0) return

      if (recorded.has(messageID)) return
      recorded.add(messageID)
      if (recorded.size > MAX_TRACKED) {
        const oldest = recorded.values().next().value
        if (oldest !== undefined) recorded.delete(oldest)
      }

      record(event.data.sessionID, count / seconds)
    })

    const disposeSlot = context.ui.slot({
      append: "sidebar.footer",
      render: (input) => <SparklineFooter theme={context.theme} state={state} sessionID={input.sessionID} />,
    })

    return () => {
      offStarted()
      offStreamed()
      offEnded()
      disposeSlot()
    }
  },
})

export function SparklineFooter(props: { theme: ResolvedTheme; state: Store<TpsState>; sessionID: string }) {
  const [width, setWidth] = createSignal(DEFAULT_WIDTH)

  const points = () => props.state.sessions[props.sessionID]?.points ?? []
  const bars = () => sparkline(points(), width())
  const current = () => summarize(points()).current

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
          <text wrapMode="none" fg={current() === undefined ? props.theme.text.faint : props.theme.text.base}>
            {formatValue(current())}
          </text>
          <text wrapMode="none" fg={props.theme.text.muted}>
            {UNIT}
          </text>
        </box>
        <box flexDirection="row" gap={1}>
          <text wrapMode="none" fg={props.theme.text.muted}>
            avg {formatValue(summarize(points()).average)}
          </text>
          <text wrapMode="none" fg={props.theme.text.muted}>
            max {formatValue(summarize(points()).max)}
          </text>
        </box>
      </box>
      <text wrapMode="none" fg={props.theme.hue.accent[500]}>
        {bars()}
      </text>
    </box>
  )
}

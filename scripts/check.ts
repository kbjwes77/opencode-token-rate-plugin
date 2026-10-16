/**
 * Dev-only harness: drives the TUI plugin's data path with a fake OpenCode
 * context so the event -> tok/s and per-minute usage logic can be checked
 * without launching the TUI.
 *
 * Run with: bun run scripts/check.ts
 */
import { createStore, produce } from "solid-js/store"
import plugin from "../tui.tsx"
import { USAGE_WINDOW_MINUTES, WINDOW, minuteOf, perMinuteSeries, pruneMinutes, segmentAt, segmentLabel, viewAt } from "../src/metrics.ts"

type UsageTotals = { output: number; reasoning: number; input: number; cache: number }
type SessionData = { points: number[]; minutes: Record<string, UsageTotals> }
type State = { sessions: Record<string, SessionData>; view: number }

type Handler = (event: unknown) => void

const handlers = new Map<string, Handler>()
const captured: Array<{
  store: State
  update: (mutation: (draft: State) => void) => void
}> = []
let render: ((input: { sessionID: string }) => unknown) | undefined
let fallbackMessage: unknown

type KeymapLayerLike = { mode?: string; commands?: ReadonlyArray<{ id?: string; bind?: string | false; run: () => void }> }
let layerFactory: (() => KeymapLayerLike) | undefined

const context = {
  options: {},
  location: undefined,
  app: { version: "test", channel: "test" },
  theme: {
    text: { base: 0, muted: 0, faint: 0 },
    hue: { accent: { 500: 0 } },
  },
  storage: {
    memory(_key: string, options: { initial: State }) {
      const [store, set] = createStore(structuredClone(options.initial))
      const update = (mutation: (draft: State) => void) => set(produce(mutation))
      const entry = { store: store as unknown as State, update }
      captured.push(entry)
      return [store, update] as const
    },
  },
  data: {
    on(type: string, handler: Handler) {
      handlers.set(type, handler)
      return () => handlers.delete(type)
    },
    session: {
      message: { get: () => fallbackMessage },
    },
  },
  keymap: {
    layer(factory: () => KeymapLayerLike) {
      layerFactory = factory
    },
  },
  ui: {
    slot(claim: { render: (input: { sessionID: string }) => unknown }) {
      render = claim.render
      return () => {
        render = undefined
      }
    },
  },
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cleanup = plugin.setup(context as any)

const fire = (type: string, event: unknown) => handlers.get(type)?.(event)
const session = (id: string) => captured[0]?.store.sessions[id]
const points = (id: string) => session(id)?.points ?? []
const minute = (id: string, at: number) => session(id)?.minutes[String(minuteOf(at))]

let failures = 0
const check = (label: string, condition: boolean, detail?: unknown) => {
  console.log(`${condition ? "ok  " : "FAIL"} ${label}${condition || detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`)
  if (!condition) failures++
}

const step = (input: {
  session: string
  id: string
  started?: number
  streamed?: number
  ended?: number
  tokens: Omit<Partial<UsageTotals>, "cache"> & { cache?: { read: number; write: number } }
}) => {
  if (input.started !== undefined) {
    fire("session.step.started", { created: input.started, data: { sessionID: input.session, assistantMessageID: input.id, started: input.started } })
  }
  if (input.streamed !== undefined) {
    fire("session.step.streamed", { created: input.streamed, data: { sessionID: input.session, assistantMessageID: input.id } })
  }
  const cache = input.tokens.cache ?? { read: 0, write: 0 }
  fire("session.step.ended", {
    created: input.ended ?? input.streamed ?? 0,
    data: {
      sessionID: input.session,
      assistantMessageID: input.id,
      tokens: { input: input.tokens.input ?? 0, output: input.tokens.output ?? 0, reasoning: input.tokens.reasoning ?? 0, cache },
    },
  })
}

// 1. A normal streamed step: (100 output + 0 reasoning) / ((3000 - 1000) / 1000) = 50 tok/s
step({ session: "s1", id: "m1", started: 1000, streamed: 3000, ended: 9000, tokens: { input: 5, output: 100, reasoning: 0 } })
check("normal step records one point", points("s1").length === 1, points("s1"))
check("normal step value is 50 tok/s", Math.round(points("s1")[0] ?? 0) === 50, points("s1")[0])
check("normal step lands in its minute bucket", minute("s1", 3000)?.output === 100, minute("s1", 3000))
check("input tokens are tracked separately", minute("s1", 3000)?.input === 5, minute("s1", 3000))

// 2. Zero-token step is ignored.
step({ session: "s1", id: "m2", started: 10000, streamed: 11000, tokens: { output: 0, reasoning: 0 } })
check("empty step is skipped", points("s1").length === 1, points("s1"))

// 3. Reasoning counts, and a missing streamed event falls back to the message.
fallbackMessage = { type: "assistant", time: { created: 0, streamed: 2000 } }
step({ session: "s1", id: "m3", ended: 2000, tokens: { output: 30, reasoning: 10 } })
check("reasoning tokens count and message fallback works", Math.round(points("s1")[1] ?? 0) === 20, points("s1"))
check("reasoning tokens are tracked per category", minute("s1", 2000)?.reasoning === 10, minute("s1", 2000))

// 3b. Replaying the same step must not double-count.
step({ session: "s1", id: "m3", ended: 2000, tokens: { output: 30, reasoning: 10 } })
check("replayed step is not double-counted", points("s1").length === 2, points("s1"))
check("replayed step does not double-count usage", minute("s1", 2000)?.output === 130, minute("s1", 2000))

// 4. A step with no timing at all (no events, no message) is skipped for tok/s
//    but still counts toward token usage.
fallbackMessage = undefined
step({ session: "s1", id: "m4", ended: 0, tokens: { output: 99 } })
check("untimed step is skipped for tok/s", points("s1").length === 2, points("s1"))
check("untimed step still counts toward usage", minute("s1", 0)?.output === 229, minute("s1", 0))

// 4b. A step whose timing only becomes available on a later replay recovers its
//     point, without double-counting usage.
fallbackMessage = undefined
step({ session: "s7", id: "r1", ended: 60_000, tokens: { output: 42 } })
check("replay: usage counted on the first pass", minute("s7", 60_000)?.output === 42 && points("s7").length === 0, { usage: minute("s7", 60_000), points: points("s7") })
fallbackMessage = { type: "assistant", time: { created: 0, streamed: 2000 } }
step({ session: "s7", id: "r1", ended: 60_000, tokens: { output: 42 } })
check("replay: point recovered once timing is known", points("s7").length === 1 && Math.round(points("s7")[0] ?? 0) === 21, points("s7"))
check("replay: usage is not double-counted", minute("s7", 60_000)?.output === 42, minute("s7", 60_000))
fallbackMessage = undefined

// 5. Sessions are isolated.
step({ session: "s2", id: "x1", started: 0, streamed: 1000, tokens: { output: 10 } })
check("sessions stay isolated", points("s1").length === 2 && points("s2").length === 1, { s1: points("s1"), s2: points("s2") })
check("usage is isolated per session", minute("s1", 0)?.output === 229 && minute("s2", 0)?.output === 10, { s1: minute("s1", 0), s2: minute("s2", 0) })

// 5b. Cache usage counts read + write, tracked alongside output.
step({ session: "s5", id: "c1", started: 0, streamed: 1000, tokens: { output: 7, cache: { read: 5, write: 3 } } })
check("cache usage counts read + write", minute("s5", 1000)?.cache === 8, minute("s5", 1000))
check("cache tokens are tracked alongside output", minute("s5", 1000)?.output === 7, minute("s5", 1000))

// 6. Rolling window cap for tok/s points.
for (let index = 0; index < WINDOW + 10; index++) {
  step({ session: "s3", id: `cap${index}`, started: 0, streamed: 1000, tokens: { output: 10 } })
}
check(`window is capped at ${WINDOW}`, points("s3").length === WINDOW, points("s3").length)

// 7. Usage buckets by wall-clock minute.
const base = 5_000_000 * 60_000
step({ session: "s6", id: "a", started: base, streamed: base, tokens: { output: 1 } })
step({ session: "s6", id: "b", started: base + 60_000, streamed: base + 60_000, tokens: { output: 2 } })
step({ session: "s6", id: "c", started: base + 2 * 60_000, streamed: base + 2 * 60_000, tokens: { output: 4 } })
check("each minute gets its own bucket", session("s6")?.minutes[String(minuteOf(base))]?.output === 1 && session("s6")?.minutes[String(minuteOf(base) + 1)]?.output === 2 && session("s6")?.minutes[String(minuteOf(base) + 2)]?.output === 4, session("s6")?.minutes)

// 7b. History stays bounded by the rolling window, dropping the oldest minutes.
for (let index = 0; index < USAGE_WINDOW_MINUTES + 10; index++) {
  const at = base + index * 60_000
  step({ session: "s4", id: `u${index}`, started: at, streamed: at, tokens: { output: index + 1 } })
}
const usageBuckets = session("s4")?.minutes ?? {}
check(`usage keeps at most ${USAGE_WINDOW_MINUTES} minutes`, Object.keys(usageBuckets).length <= USAGE_WINDOW_MINUTES, Object.keys(usageBuckets).length)
check("usage keeps the newest minute", usageBuckets[String(minuteOf(base) + USAGE_WINDOW_MINUTES + 9)]?.output === USAGE_WINDOW_MINUTES + 10, usageBuckets)
check("usage drops the oldest minute", usageBuckets[String(minuteOf(base))] === undefined, Object.keys(usageBuckets))

// 8. Zero-fill helper keeps a true time axis.
const buckets = { "10": { output: 5, reasoning: 0, input: 0, cache: 0 }, "12": { output: 7, reasoning: 0, input: 0, cache: 0 } }
const series = perMinuteSeries(buckets, "output", 12 * 60_000 + 30_000)
check(`series is ${USAGE_WINDOW_MINUTES} minutes long`, series.length === USAGE_WINDOW_MINUTES, series.length)
check("series zero-fills idle minutes", series[series.length - 1] === 7 && series[series.length - 2] === 0 && series[series.length - 3] === 5, series.slice(-3))

// 8b. pruneMinutes is order-independent and bounded by the window.
const totals = (output: number): UsageTotals => ({ output, reasoning: 0, input: 0, cache: 0 })
const sparse: Record<string, UsageTotals> = { "5": totals(3), "10": totals(1), "300": totals(2) }
pruneMinutes(sparse, 60)
check("pruneMinutes keeps sparse buckets when within the count", Object.keys(sparse).length === 3, Object.keys(sparse))

const descending: Record<string, UsageTotals> = {}
for (let value = 120; value > 0; value--) descending[String(value)] = totals(value)
pruneMinutes(descending, 60)
check("pruneMinutes bounds out-of-order keys to the window", Object.keys(descending).length === 60 && descending["120"] !== undefined && descending["61"] !== undefined && descending["60"] === undefined, { count: Object.keys(descending).length, has60: descending["60"] !== undefined })

// 9. View cycling: the keymap layer cycles the shared view index both ways.
check("keymap layer registered", typeof layerFactory === "function")
const layer = layerFactory?.()
check("layer is global", layer?.mode === "global", layer?.mode)
check("cycle command is bound", layer?.commands?.[0]?.bind === "ctrl+alt+t", layer?.commands?.[0]?.bind)
const before = captured[0]?.store.view ?? 0
layer?.commands?.[0]?.run()
const afterNext = captured[0]?.store.view ?? 0
check("command advances the view", afterNext === (before + 1) % 5, { before, afterNext })
check("viewAt wraps past the last view", viewAt(-1).id === "cache" && viewAt(5).id === "throughput", { neg: viewAt(-1).id, wrap: viewAt(5).id })

// 9b. Hover mapping: a chart column resolves to the point it plots, and the
//     readout names the value, the unit, and how far back the point is.
const hoverSeries = [10, 20, 30, 40]
check("segmentAt maps a column to its point", segmentAt(hoverSeries, 40, 2)?.value === 30, segmentAt(hoverSeries, 40, 2))
check("segmentAt counts back from the newest point", segmentAt(hoverSeries, 40, 2)?.ago === 1, segmentAt(hoverSeries, 40, 2))
check("segmentAt matches the width-clipped sparkline", segmentAt(hoverSeries, 2, 0)?.value === 30 && segmentAt(hoverSeries, 2, 0)?.ago === 1, segmentAt(hoverSeries, 2, 0))
check("segmentAt rejects columns past the plotted points", segmentAt(hoverSeries, 40, 4) === undefined, segmentAt(hoverSeries, 40, 4))
check("segmentAt rejects negative columns", segmentAt(hoverSeries, 40, -1) === undefined, segmentAt(hoverSeries, 40, -1))
check("segmentAt rejects a non-integer column", segmentAt(hoverSeries, 40, 1.5) === undefined, segmentAt(hoverSeries, 40, 1.5))
check("segmentAt rejects a zero-width chart", segmentAt(hoverSeries, 0, 0) === undefined, segmentAt(hoverSeries, 0, 0))
check("segmentAt on an empty series is undefined", segmentAt([], 40, 0) === undefined, segmentAt([], 40, 0))

check("segmentLabel names the newest step", segmentLabel(viewAt(0), { value: 55, ago: 0 }) === "55.0 tok/s \u00b7 latest", segmentLabel(viewAt(0), { value: 55, ago: 0 }))
check("segmentLabel counts steps back", segmentLabel(viewAt(0), { value: 45, ago: 3 }) === "45.0 tok/s \u00b7 3 ago", segmentLabel(viewAt(0), { value: 45, ago: 3 }))
check("segmentLabel names the current minute", segmentLabel(viewAt(1), { value: 120, ago: 0 }) === "120 tok/min \u00b7 now", segmentLabel(viewAt(1), { value: 120, ago: 0 }))
check("segmentLabel counts minutes back", segmentLabel(viewAt(1), { value: 30, ago: 12 }) === "30.0 tok/min \u00b7 12m ago", segmentLabel(viewAt(1), { value: 30, ago: 12 }))
check("segmentLabel collapses large usage counts", segmentLabel(viewAt(1), { value: 12_400, ago: 1 }) === "12.4k tok/min \u00b7 1m ago", segmentLabel(viewAt(1), { value: 12_400, ago: 1 }))

// 10. The slot render function exists and does not throw.
check("slot render registered", typeof render === "function")
check("cleanup is a function", typeof cleanup === "function")

if (typeof cleanup === "function") cleanup()
check("cleanup unregisters the slot", render === undefined)

// 11. Option/guard branches: a `keybind` override, a host with no keymap, and a
//     store left behind by an older plugin generation (no `minutes`, no `view`).
const isolatedSetup = (options: Record<string, unknown>, withKeymap: boolean, seed?: unknown) => {
  let localLayer: (() => KeymapLayerLike) | undefined
  let localStore: State | undefined
  const localHandlers = new Map<string, Handler>()
  const ctx: Record<string, unknown> = {
    options,
    theme: { text: { base: 0, muted: 0, faint: 0 }, hue: { accent: { 500: 0 } } },
    storage: {
      memory(_key: string, opts: { initial: State }) {
        const [store, set] = createStore(structuredClone(seed ?? opts.initial) as State)
        localStore = store as unknown as State
        return [store, (mutation: (draft: State) => void) => set(produce(mutation))] as const
      },
    },
    data: {
      on(type: string, handler: Handler) {
        localHandlers.set(type, handler)
        return () => localHandlers.delete(type)
      },
      session: { message: { get: () => undefined } },
    },
    ui: { slot: () => () => {} },
  }
  if (withKeymap) ctx.keymap = { layer: (factory: () => KeymapLayerLike) => { localLayer = factory } }
  const teardown: unknown = plugin.setup(ctx as unknown as Parameters<typeof plugin.setup>[0])
  return {
    teardown,
    layer: () => localLayer?.(),
    view: () => localStore?.view,
    store: () => localStore,
    fire: (type: string, event: unknown) => localHandlers.get(type)?.(event),
  }
}

const override = isolatedSetup({ keybind: "ctrl+shift+y" }, true)
check("keybind option overrides the default", override.layer()?.commands?.[0]?.bind === "ctrl+shift+y", override.layer()?.commands?.[0]?.bind)
check("isolated setup starts on the first view", override.view() === 0, override.view())
if (typeof override.teardown === "function") override.teardown()

const noKeymap = isolatedSetup({}, false)
check("setup survives a host without a keymap", typeof noKeymap.teardown === "function")
if (typeof noKeymap.teardown === "function") noKeymap.teardown()

// A hot reload against a store from the pre-usage generation must migrate, not throw.
const legacy = isolatedSetup({}, false, { sessions: { s9: { points: [12, 34] } }, view: undefined })
check("legacy store: setup migrates the view index", legacy.view() === 0, legacy.view())
legacy.fire("session.step.ended", {
  created: 3_000_000,
  data: { sessionID: "s9", assistantMessageID: "L1", tokens: { input: 0, output: 40, reasoning: 0, cache: { read: 2, write: 0 } } },
})
check("legacy store: usage records instead of throwing", legacy.store()?.sessions.s9?.minutes[String(minuteOf(3_000_000))]?.output === 40, legacy.store()?.sessions.s9?.minutes)
check("legacy store: cache is folded too", legacy.store()?.sessions.s9?.minutes[String(minuteOf(3_000_000))]?.cache === 2, legacy.store()?.sessions.s9?.minutes)
check("legacy store: existing points are preserved", legacy.store()?.sessions.s9?.points.length === 2, legacy.store()?.sessions.s9?.points)
if (typeof legacy.teardown === "function") legacy.teardown()

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`)
if (failures > 0) process.exit(1)

/**
 * Dev-only harness: drives the TUI plugin's data path with a fake OpenCode
 * context so the event -> tok/s logic can be checked without launching the TUI.
 *
 * Run with: bun run scripts/check.ts
 */
import { createStore, produce } from "solid-js/store"
import plugin from "../tui.tsx"
import { WINDOW } from "../src/metrics.ts"

type Handler = (event: unknown) => void

const handlers = new Map<string, Handler>()
const captured: Array<{
  store: { sessions: Record<string, { points: number[] }> }
  update: (mutation: (draft: { sessions: Record<string, { points: number[] }> }) => void) => void
}> = []
let render: ((input: { sessionID: string }) => unknown) | undefined
let fallbackMessage: unknown

const context = {
  options: {},
  location: undefined,
  app: { version: "test", channel: "test" },
  theme: {
    text: { base: 0, muted: 0, faint: 0 },
    hue: { accent: { 500: 0 } },
  },
  storage: {
    memory(_key: string, options: { initial: { sessions: Record<string, { points: number[] }> } }) {
      const [store, set] = createStore(structuredClone(options.initial))
      const update = (mutation: (draft: typeof store) => void) => set(produce(mutation))
      const entry = { store: store as unknown as { sessions: Record<string, { points: number[] }> }, update }
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
const points = (session: string) => captured[0]?.store.sessions[session]?.points ?? []

let failures = 0
const check = (label: string, condition: boolean, detail?: unknown) => {
  console.log(`${condition ? "ok  " : "FAIL"} ${label}${condition || detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`)
  if (!condition) failures++
}

// 1. A normal streamed step: (100 output + 0 reasoning) / ((3000 - 1000) / 1000) = 50 tok/s
fire("session.step.started", { created: 1000, data: { sessionID: "s1", assistantMessageID: "m1", started: 1000 } })
fire("session.step.streamed", { created: 3000, data: { sessionID: "s1", assistantMessageID: "m1" } })
fire("session.step.ended", {
  created: 9000,
  data: { sessionID: "s1", assistantMessageID: "m1", tokens: { input: 5, output: 100, reasoning: 0, cache: { read: 0, write: 0 } } },
})
check("normal step records one point", points("s1").length === 1, points("s1"))
check("normal step value is 50 tok/s", Math.round(points("s1")[0] ?? 0) === 50, points("s1")[0])

// 2. Zero-token step is ignored.
fire("session.step.started", { created: 10000, data: { sessionID: "s1", assistantMessageID: "m2", started: 10000 } })
fire("session.step.streamed", { created: 11000, data: { sessionID: "s1", assistantMessageID: "m2" } })
fire("session.step.ended", {
  created: 11000,
  data: { sessionID: "s1", assistantMessageID: "m2", tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
})
check("empty step is skipped", points("s1").length === 1, points("s1"))

// 3. Reasoning counts, and a missing streamed event falls back to the message.
fallbackMessage = { type: "assistant", time: { created: 0, streamed: 2000 } }
fire("session.step.ended", {
  created: 2000,
  data: { sessionID: "s1", assistantMessageID: "m3", tokens: { input: 0, output: 30, reasoning: 10, cache: { read: 0, write: 0 } } },
})
check("reasoning tokens count and message fallback works", Math.round(points("s1")[1] ?? 0) === 20, points("s1"))

// 3b. Replaying the same step must not double-count.
fire("session.step.ended", {
  created: 2000,
  data: { sessionID: "s1", assistantMessageID: "m3", tokens: { input: 0, output: 30, reasoning: 10, cache: { read: 0, write: 0 } } },
})
check("replayed step is not double-counted", points("s1").length === 2, points("s1"))

// 4. A step with no timing at all (no events, no message) is skipped.
fallbackMessage = undefined
fire("session.step.ended", {
  created: 0,
  data: { sessionID: "s1", assistantMessageID: "m4", tokens: { input: 0, output: 99, reasoning: 0, cache: { read: 0, write: 0 } } },
})
check("untimed step is skipped", points("s1").length === 2, points("s1"))

// 5. Sessions are isolated.
fire("session.step.started", { created: 0, data: { sessionID: "s2", assistantMessageID: "x1", started: 0 } })
fire("session.step.streamed", { created: 1000, data: { sessionID: "s2", assistantMessageID: "x1" } })
fire("session.step.ended", {
  created: 1000,
  data: { sessionID: "s2", assistantMessageID: "x1", tokens: { input: 0, output: 10, reasoning: 0, cache: { read: 0, write: 0 } } },
})
check("sessions stay isolated", points("s1").length === 2 && points("s2").length === 1, { s1: points("s1"), s2: points("s2") })

// 6. Rolling window cap.
for (let index = 0; index < WINDOW + 10; index++) {
  const id = `cap${index}`
  fire("session.step.started", { created: 0, data: { sessionID: "s3", assistantMessageID: id, started: 0 } })
  fire("session.step.streamed", { created: 1000, data: { sessionID: "s3", assistantMessageID: id } })
  fire("session.step.ended", {
    created: 1000,
    data: { sessionID: "s3", assistantMessageID: id, tokens: { input: 0, output: 10, reasoning: 0, cache: { read: 0, write: 0 } } },
  })
}
check(`window is capped at ${WINDOW}`, points("s3").length === WINDOW, points("s3").length)

// 7. The slot render function exists and does not throw.
check("slot render registered", typeof render === "function")
check("cleanup is a function", typeof cleanup === "function")

if (typeof cleanup === "function") cleanup()
check("cleanup unregisters the slot", render === undefined)

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`)
if (failures > 0) process.exit(1)

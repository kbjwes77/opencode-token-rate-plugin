/**
 * Dev-only harness: renders the sidebar footer component with the real OpenTUI
 * test renderer and asserts the visible output.
 *
 * Run with: bun run --conditions=browser scripts/render.tsx
 */
import { testRender } from "@opentui/solid"
import { createStore } from "solid-js/store"
import type { ResolvedTheme } from "@opencode/theme/tui"
import { SparklineFooter } from "../tui.tsx"
import { cycleViewIndex, minuteOf } from "../src/metrics.ts"

const theme = {
  text: { base: "#ffffff", muted: "#888888", faint: "#555555" },
  hue: { accent: { 500: "#00ffff" } },
} as unknown as ResolvedTheme

type UsageTotals = { output: number; reasoning: number; input: number; cache: number }
type SessionData = { points: number[]; minutes: Record<string, UsageTotals> }
type State = { sessions: Record<string, SessionData>; view: number }

const totals = (partial: Partial<UsageTotals>): UsageTotals => ({
  output: 0,
  reasoning: 0,
  input: 0,
  cache: 0,
  ...partial,
})

let failures = 0
const check = (label: string, condition: boolean, detail?: unknown) => {
  console.log(`${condition ? "ok  " : "FAIL"} ${label}${condition || detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`)
  if (!condition) failures++
}

const glyph = /[\u2581-\u2588]/
const glyphCount = (frame: string) => {
  const row = frame.split("\n").find((line) => glyph.test(line)) ?? ""
  return [...row].filter((char) => glyph.test(char)).length
}

const render = async (state: State, sessionID = "s1") => {
  const [store] = createStore<State>(state)
  const setup = await testRender(() => <SparklineFooter theme={theme} state={store} sessionID={sessionID} />, {
    width: 40,
    height: 8,
    useMouse: true,
  })
  for (let pass = 0; pass < 4; pass++) await setup.renderOnce()
  return { setup, frame: setup.captureCharFrame() }
}

// --- Throughput view (default) ---------------------------------------------
const withPoints = createStore<State>({
  sessions: { s1: { points: [10, 20, 30, 40, 50, 60, 25, 35, 45, 55], minutes: {} } },
  view: 0,
})

const populated = await testRender(
  () => <SparklineFooter theme={theme} state={withPoints[0]} sessionID="s1" />,
  { width: 40, height: 8, useMouse: true },
)
for (let pass = 0; pass < 4; pass++) await populated.renderOnce()
const populatedFrame = populated.captureCharFrame()
console.log("--- populated frame (40 cols) ---")
console.log(populatedFrame)

check("renders the tok/s unit", populatedFrame.includes("tok/s"))
check("renders avg and max labels", populatedFrame.includes("avg") && populatedFrame.includes("max"))
check("renders the current value (55.0)", populatedFrame.includes("55.0"))
check("renders the max value (60.0)", populatedFrame.includes("60.0"))
check("renders the average (37.0)", populatedFrame.includes("37.0"))
check("renders block glyphs", glyph.test(populatedFrame))
check("sparkline draws all 10 points", glyphCount(populatedFrame) === 10, { count: glyphCount(populatedFrame) })
check("renders the throughput toggle label", populatedFrame.includes("Throughput"))

const statsLine = (populatedFrame.split("\n").find((line) => line.includes("tok/s")) ?? "").replace(/\s+$/, "")
check("current + unit stay left-aligned", statsLine.startsWith("55.0 tok/s"), statsLine)
check("avg + max sit at the right edge", statsLine.endsWith("max 60.0"), statsLine)

// Resizing should re-measure and clip the sparkline to the narrower width.
populated.resize(6, 8)
for (let pass = 0; pass < 4; pass++) await populated.renderOnce()
const narrowFrame = populated.captureCharFrame()
console.log("--- after resize to 6 cols ---")
console.log(narrowFrame)
check("sparkline re-fits after resize (<= 6)", glyphCount(narrowFrame) <= 6, { count: glyphCount(narrowFrame) })

// --- Usage view (Output Usage) ---------------------------------------------
const nowMinute = minuteOf(Date.now())
const usageState: State = {
  sessions: {
    s1: {
      points: [],
      minutes: {
        [String(nowMinute)]: totals({ output: 120 }),
        [String(nowMinute - 1)]: totals({ output: 30 }),
      },
    },
  },
  view: 1,
}
const usage = await render(usageState)
console.log("--- output usage frame (40 cols) ---")
console.log(usage.frame)
const usageStats = (usage.frame.split("\n").find((line) => line.includes("tok/min")) ?? "").replace(/\s+$/, "")
check("usage view shows its label", usage.frame.includes("Output Usage"))
check("usage view shows the tok/min unit", usage.frame.includes("tok/min"))
check("usage view's current value is the minute in progress", usageStats.startsWith("120 tok/min"), usageStats)
check("usage view zero-fills the window (avg 2.5)", usageStats.includes("avg 2.5"), usageStats)
check("usage view's max is the busiest minute", usageStats.endsWith("max 120"), usageStats)
check("usage view draws block glyphs", glyph.test(usage.frame))

// --- Usage view (Cache Usage = read + write) --------------------------------
const cacheState: State = {
  sessions: {
    s1: {
      points: [],
      minutes: {
        [String(nowMinute)]: totals({ cache: 40 }),
        [String(nowMinute - 2)]: totals({ cache: 90 }),
      },
    },
  },
  view: 4,
}
const cache = await render(cacheState)
console.log("--- cache usage frame (40 cols) ---")
console.log(cache.frame)
const cacheStats = (cache.frame.split("\n").find((line) => line.includes("tok/min")) ?? "").replace(/\s+$/, "")
check("cache view shows its label", cache.frame.includes("Cache Usage"))
check("cache view shows the tok/min unit", cache.frame.includes("tok/min"))
check("cache view shows the current minute total", cacheStats.startsWith("40.0 tok/min"), cacheStats)
check("cache view's max is the busiest minute", cacheStats.endsWith("max 90.0"), cacheStats)

// --- Empty state ------------------------------------------------------------
const empty = await render({ sessions: {}, view: 0 })
console.log("--- empty frame ---")
console.log(empty.frame)
check("empty state shows placeholders", empty.frame.includes("\u2014"))
check("empty state draws no block glyphs", !glyph.test(empty.frame))

// --- Clicking the toggle cycles the view ------------------------------------
const clickStore = createStore<State>({
  sessions: { s1: { points: [10, 20, 30], minutes: {} } },
  view: 0,
})
const [clickState, setClickState] = clickStore
const clickable = await testRender(
  () => (
    <SparklineFooter
      theme={theme}
      state={clickState}
      sessionID="s1"
      onCycle={(delta) => setClickState("view", (value) => cycleViewIndex(value, delta))}
    />
  ),
  { width: 40, height: 8, useMouse: true },
)
for (let pass = 0; pass < 4; pass++) await clickable.renderOnce()
const beforeClick = clickable.captureCharFrame()
check("starts on the throughput view", beforeClick.includes("Throughput"))

// The toggle row is the third line; click the label to advance.
await clickable.mockMouse.click(3, 2)
for (let pass = 0; pass < 4; pass++) await clickable.renderOnce()
const afterClick = clickable.captureCharFrame()
console.log("--- after clicking the toggle ---")
console.log(afterClick)
check("click advances to the next view", afterClick.includes("Output Usage") && !afterClick.includes("Throughput"), afterClick)

// --- Hovering the chart shows the point under the cursor --------------------
const bottomRow = (frame: string) => (frame.split("\n").find((line) => line.includes("\u2039")) ?? "").replace(/\s+$/, "")
const settle = async (setup: { renderOnce: () => Promise<void> }) => {
  for (let pass = 0; pass < 4; pass++) await setup.renderOnce()
}

const hoverStore = createStore<State>({
  sessions: { s1: { points: [10, 20, 30, 40, 50, 60, 25, 35, 45, 55], minutes: {} } },
  view: 0,
})
const hoverable = await testRender(() => <SparklineFooter theme={theme} state={hoverStore[0]} sessionID="s1" />, {
  width: 40,
  height: 8,
  useMouse: true,
})
await settle(hoverable)

// The chart is the second line; the newest point sits in its last column.
const lastColumn = glyphCount(hoverable.captureCharFrame()) - 1
await hoverable.mockMouse.moveTo(lastColumn, 1)
await settle(hoverable)
const latestFrame = hoverable.captureCharFrame()
console.log("--- after hovering the newest column ---")
console.log(latestFrame)
check("hover shows the newest point's value", bottomRow(latestFrame).includes("55.0 tok/s"), bottomRow(latestFrame))
check("hover names the newest point", bottomRow(latestFrame).includes("latest"), bottomRow(latestFrame))

await hoverable.mockMouse.moveTo(lastColumn - 1, 1)
await settle(hoverable)
const olderFrame = hoverable.captureCharFrame()
check("hover shows an older point's value", bottomRow(olderFrame).includes("45.0 tok/s"), bottomRow(olderFrame))
check("hover counts the older point back", bottomRow(olderFrame).includes("1 ago"), bottomRow(olderFrame))

// Moving off the chart (here: onto the toggle row) clears the readout.
await hoverable.mockMouse.moveTo(0, 2)
await settle(hoverable)
const clearedFrame = hoverable.captureCharFrame()
check("moving off the chart clears the readout", !bottomRow(clearedFrame).includes("tok/s"), bottomRow(clearedFrame))
check("the toggle survives clearing", bottomRow(clearedFrame).includes("Throughput"), bottomRow(clearedFrame))

// Usage views map columns to wall-clock minutes instead of steps.
const usageHoverStore = createStore<State>(usageState)
const usageHover = await testRender(() => <SparklineFooter theme={theme} state={usageHoverStore[0]} sessionID="s1" />, {
  width: 40,
  height: 8,
  useMouse: true,
})
await settle(usageHover)
const usageLast = glyphCount(usageHover.captureCharFrame()) - 1
await usageHover.mockMouse.moveTo(usageLast, 1)
await settle(usageHover)
const usageLatest = bottomRow(usageHover.captureCharFrame())
check("usage hover names the current minute", usageLatest.includes("120 tok/min") && usageLatest.includes("now"), usageLatest)

await usageHover.mockMouse.moveTo(usageLast - 1, 1)
await settle(usageHover)
const usageOlder = bottomRow(usageHover.captureCharFrame())
check("usage hover counts minutes back", usageOlder.includes("30.0 tok/min") && usageOlder.includes("1m ago"), usageOlder)

// The real host nests the footer inside a sidebar, so the chart does not start at
// column 0. Hovering must subtract the chart's own origin, not the terminal's.
const offsetStore = createStore<State>({
  sessions: { s1: { points: [10, 20, 30, 40, 50, 60, 25, 35, 45, 55], minutes: {} } },
  view: 0,
})
const offset = await testRender(
  () => (
    <box width="100%" paddingLeft={5}>
      <SparklineFooter theme={theme} state={offsetStore[0]} sessionID="s1" />
    </box>
  ),
  { width: 40, height: 8, useMouse: true },
)
await settle(offset)
const offsetGlyphs = glyphCount(offset.captureCharFrame())
check("offset: the chart really is indented", offsetGlyphs === 10, { offsetGlyphs })
// Glyphs start at column 5, so the newest one is at 5 + (offsetGlyphs - 1).
await offset.mockMouse.moveTo(4 + offsetGlyphs, 1)
await settle(offset)
const offsetRow = bottomRow(offset.captureCharFrame())
check("offset: hover maps the column despite the sidebar indent", offsetRow.includes("55.0 tok/s") && offsetRow.includes("latest"), offsetRow)

// Narrow sidebar: the readout is informational, so the toggle wins the width.
const narrowStore = createStore<State>({
  sessions: { s1: { points: [], minutes: { [String(nowMinute)]: totals({ reasoning: 400 }) } } },
  view: 2,
})
const narrow = await testRender(() => <SparklineFooter theme={theme} state={narrowStore[0]} sessionID="s1" />, {
  width: 24,
  height: 8,
  useMouse: true,
})
await settle(narrow)
await narrow.mockMouse.moveTo(glyphCount(narrow.captureCharFrame()) - 1, 1)
await settle(narrow)
const narrowRow = bottomRow(narrow.captureCharFrame())
console.log("--- narrow (24 cols) with hover ---")
console.log(narrow.captureCharFrame())
check("narrow: the toggle keeps its full label", narrowRow.includes("Reasoning Usage"), narrowRow)
check("narrow: the readout is still shown, just clipped", narrowRow.includes("400"), narrowRow)

console.log(failures === 0 ? "\nALL RENDER CHECKS PASSED" : `\n${failures} RENDER CHECK(S) FAILED`)
if (failures > 0) process.exit(1)

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

const theme = {
  text: { base: "#ffffff", muted: "#888888", faint: "#555555" },
  hue: { accent: { 500: "#00ffff" } },
} as unknown as ResolvedTheme

type State = { sessions: Record<string, { points: number[] }> }

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

const withPoints = createStore<State>({
  sessions: { s1: { points: [10, 20, 30, 40, 50, 60, 25, 35, 45, 55] } },
})
const empty = createStore<State>({ sessions: {} })

const populated = await testRender(
  () => <SparklineFooter theme={theme} state={withPoints[0]} sessionID="s1" />,
  { width: 40, height: 8 },
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

const blank = await testRender(
  () => <SparklineFooter theme={theme} state={empty[0]} sessionID="s1" />,
  { width: 40, height: 8 },
)
for (let pass = 0; pass < 4; pass++) await blank.renderOnce()
const blankFrame = blank.captureCharFrame()
console.log("--- empty frame ---")
console.log(blankFrame)
check("empty state shows placeholders", blankFrame.includes("\u2014"))
check("empty state draws no block glyphs", !glyph.test(blankFrame))

console.log(failures === 0 ? "\nALL RENDER CHECKS PASSED" : `\n${failures} RENDER CHECK(S) FAILED`)
if (failures > 0) process.exit(1)

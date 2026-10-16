/**
 * Pure helpers for the token rate / token usage sparklines.
 *
 * Kept free of any OpenCode/OpenTUI imports so the math can be reasoned about
 * and tested in isolation.
 */

/** Rolling window: how many recent completions the throughput stats and sparkline cover. */
export const WINDOW = 50

/** Milliseconds in one minute; usage is bucketed per wall-clock minute. */
export const MINUTE_MS = 60_000

/** Rolling window: how many recent minutes the usage views cover (zero-filled). */
export const USAGE_WINDOW_MINUTES = 60

/** Unicode block glyphs, shortest to tallest. */
export const BLOCKS = ["\u2581", "\u2582", "\u2583", "\u2584", "\u2585", "\u2586", "\u2587", "\u2588"] as const

/** Render the visible-window sparkline. `width` is the column budget (points kept = last `width`). */
export function sparkline(points: readonly number[], width: number): string {
  if (width <= 0 || points.length === 0) return ""
  const visible = points.slice(-width)
  const min = Math.min(...visible)
  const max = Math.max(...visible)
  const span = max - min
  const top = BLOCKS.length - 1
  const flat = Math.floor(BLOCKS.length / 2)
  let out = ""
  for (const value of visible) {
    const index = span <= 0 ? flat : Math.round(((value - min) / span) * top)
    out += BLOCKS[index] ?? BLOCKS[flat] ?? "\u2584"
  }
  return out
}

export type Summary = {
  readonly current: number | undefined
  readonly average: number | undefined
  readonly max: number | undefined
}

export function summarize(points: readonly number[]): Summary {
  if (points.length === 0) return { current: undefined, average: undefined, max: undefined }
  let total = 0
  let max = Number.NEGATIVE_INFINITY
  for (const value of points) {
    total += value
    if (value > max) max = value
  }
  return {
    current: points[points.length - 1],
    average: total / points.length,
    max,
  }
}

/** Unit label rendered once next to the current value (throughput view). */
export const UNIT = "tok/s"

/** Unit label for the per-minute usage views. */
export const USAGE_UNIT = "tok/min"

/**
 * Format a value for display, or an em dash when there is no value yet.
 * Large usage counts collapse to `k`/`M` so the footer stays narrow.
 */
export function formatValue(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "\u2014"
  const magnitude = Math.abs(value)
  if (magnitude >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (magnitude >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return value >= 100 ? value.toFixed(0) : value.toFixed(1)
}

/** The token categories a usage view can break down. */
export type UsageField = "output" | "reasoning" | "input" | "cache"

/** Tokens consumed within one minute, split by category. */
export type UsageTotals = {
  output: number
  reasoning: number
  input: number
  cache: number
}

export function emptyTotals(): UsageTotals {
  return { output: 0, reasoning: 0, input: 0, cache: 0 }
}

/** The wall-clock minute (epoch minutes) a timestamp falls in. */
export function minuteOf(timestamp: number): number {
  return Math.floor(timestamp / MINUTE_MS)
}

/**
 * Build the zero-filled per-minute series for one usage field, ending at `now`.
 *
 * Returns `minutes` values, oldest → newest. Minutes with no recorded activity
 * are 0, so the sparkline keeps a true time axis across idle gaps.
 */
export function perMinuteSeries(
  buckets: Readonly<Record<string, UsageTotals>> | undefined,
  field: UsageField,
  now: number,
  minutes: number = USAGE_WINDOW_MINUTES,
): number[] {
  const end = minuteOf(now)
  const start = end - minutes + 1
  const series: number[] = new Array(minutes)
  for (let index = 0; index < minutes; index++) {
    const bucket = buckets?.[start + index]
    series[index] = bucket ? bucket[field] : 0
  }
  return series
}

/**
 * Drop minute buckets older than the rolling window, measured from the newest
 * bucket present (not the newest write) so out-of-order or clock-skewed
 * timestamps cannot retain unbounded history.
 */
export function pruneMinutes(buckets: Record<string, UsageTotals>, window: number = USAGE_WINDOW_MINUTES): void {
  const keys = Object.keys(buckets)
  if (keys.length <= window) return
  let newest = Number.NEGATIVE_INFINITY
  for (const key of keys) {
    const value = Number(key)
    if (value > newest) newest = value
  }
  const cutoff = newest - window + 1
  for (const key of keys) {
    if (Number(key) < cutoff) delete buckets[key]
  }
}

/** The views the footer cycles through. `field === null` is the throughput view. */
export type View = {
  readonly id: string
  readonly label: string
  readonly unit: string
  readonly field: UsageField | null
}

export const THROUGHPUT_VIEW: View = { id: "throughput", label: "Throughput", unit: UNIT, field: null }

export const VIEWS: readonly View[] = [
  THROUGHPUT_VIEW,
  { id: "output", label: "Output Usage", unit: USAGE_UNIT, field: "output" },
  { id: "reasoning", label: "Reasoning Usage", unit: USAGE_UNIT, field: "reasoning" },
  { id: "input", label: "Input Usage", unit: USAGE_UNIT, field: "input" },
  { id: "cache", label: "Cache Usage", unit: USAGE_UNIT, field: "cache" },
]

/** Resolve a (possibly out-of-range, negative, or missing) index to a view, wrapping around. */
export function viewAt(index: number): View {
  if (!Number.isFinite(index)) return THROUGHPUT_VIEW
  const count = VIEWS.length
  const normalized = ((Math.trunc(index) % count) + count) % count
  return VIEWS[normalized] ?? THROUGHPUT_VIEW
}

/** Advance a view index by `delta`, wrapping in both directions. */
export function cycleViewIndex(index: number, delta: number): number {
  const count = VIEWS.length
  const current = Number.isFinite(index) ? Math.trunc(index) : 0
  const step = Number.isFinite(delta) ? Math.trunc(delta) : 0
  return ((current + step) % count + count) % count
}

/** A single plotted point picked out of a sparkline by the cursor. */
export type Segment = {
  /** The value plotted at the hovered column. */
  readonly value: number
  /** How many points back from the newest point this is (0 = newest). */
  readonly ago: number
}

/**
 * Resolve a sparkline column to the point it plots.
 *
 * `width` is the same column budget handed to `sparkline`, so the mapping lines up
 * with what is actually on screen. Columns past the plotted points — and negative
 * or non-integer columns — resolve to `undefined`.
 */
export function segmentAt(series: readonly number[], width: number, column: number): Segment | undefined {
  if (!Number.isInteger(column) || column < 0 || width <= 0) return undefined
  const visible = series.slice(-width)
  if (column >= visible.length) return undefined
  const value = visible[column]
  if (value === undefined) return undefined
  return { value, ago: visible.length - 1 - column }
}

/** How far back a hovered point is, in the units the active view plots. */
function ageLabel(view: View, ago: number): string {
  if (view.field === null) return ago === 0 ? "latest" : `${ago} ago`
  return ago === 0 ? "now" : `${ago}m ago`
}

/** Describe a hovered point for the footer: its value, unit, and how far back it is. */
export function segmentLabel(view: View, segment: Segment): string {
  return `${formatValue(segment.value)} ${view.unit} \u00b7 ${ageLabel(view, segment.ago)}`
}

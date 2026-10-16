/**
 * Pure helpers for the tokens-per-second sparkline.
 *
 * Kept free of any OpenCode/OpenTUI imports so the math can be reasoned about
 * and tested in isolation.
 */

/** Rolling window: how many recent completions the stats and sparkline cover. */
export const WINDOW = 50

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

/** Unit label rendered once next to the current value. */
export const UNIT = "tok/s"

/** Format a speed for display, or an em dash when there is no value yet. */
export function formatValue(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "\u2014"
  return value >= 100 ? value.toFixed(0) : value.toFixed(1)
}

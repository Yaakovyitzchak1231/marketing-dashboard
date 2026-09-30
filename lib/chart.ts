/**
 * Chart geometry.
 *
 * These are LAYOUT constants in SVG user units -- viewbox, padding, stroke
 * weight. None of them is a metric, and none of them is derived from data.
 *
 * They live here, not inline in the component, for two reasons:
 *   1. The "no numeric literals in the render path" test (AC3) exists to stop
 *      a human quietly typing a number into a component. A whitelist of
 *      "chart numbers" is exactly the loophole that lets a real number hide
 *      among them, so the component is kept literal-free instead.
 *   2. A reviewer can see every layout number in one place and argue with it
 *      without reading JSX.
 */

/** The SVG viewbox, in user units. The chart scales to its container width. */
export const CHART_GEOMETRY = {
  width: 640,
  height: 160,
  /** Breathing room so a point at the max or min is not clipped by the edge. */
  padX: 4,
  padY: 12,
  /** Stroke weight for the data line. A hairline-plus, not a thick ribbon. */
  strokeWidth: 1.5,
  /** The axis hairline, one notch finer than the data so it never competes. */
  axisStrokeWidth: 1,
  /** Radius of the single-point marker, for the one-day first-run state. */
  pointRadius: 3,
  /**
   * The viewbox origin. Always the top-left of the user-space box; the
   * `<svg>` element's own `min-x`/`min-y` cannot be reused here, so it lives
   * with the rest of the geometry.
   */
  originX: 0,
  originY: 0,
} as const

/**
 * The `viewBox` attribute value.
 *
 * Built here rather than inlined in the component so the render path stays
 * free of numeric literals -- which is what lets the AC3 test have no
 * exemptions at all.
 */
export function chartViewBox(): string {
  const { originX, originY, width, height } = CHART_GEOMETRY
  return `${originX} ${originY} ${width} ${height}`
}

/**
 * Horizontal position of the point at `index` of `total`.
 *
 * A single point returns the left edge rather than dividing by zero. The
 * one-day history case is a real first-run state (bug 4), and a NaN here
 * would blank the chart, which is precisely how "collecting history" ends up
 * looking like a crash.
 */
export function scaleX(index: number, total: number): number {
  const { width, padX } = CHART_GEOMETRY
  if (total <= 1) return padX
  const usable = width - padX * 2
  return padX + (index / (total - 1)) * usable
}

/**
 * Vertical position of `value` within the observed [min, max] of the series.
 *
 * The domain is the observed range of the data, never a hardcoded baseline: a
 * fixed axis would let the chart imply a magnitude the data does not support.
 *
 * A flat series (min === max) returns the vertical midpoint instead of
 * dividing by zero -- a constant series is real data that should render as a
 * centred flat line, not as an invisible one.
 */
export function scaleY(value: number, min: number, max: number): number {
  const { height, padY } = CHART_GEOMETRY
  const usable = height - padY * 2
  if (max === min) return padY + usable / 2
  return padY + usable - ((value - min) / (max - min)) * usable
}

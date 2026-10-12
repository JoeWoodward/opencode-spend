// Pure text formatting for the sidebar: money, tokens and the context bar.
import type { HydrationStatus } from "./hydration.ts"

const exact = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 })

/**
 * Money for the summary: cents under a dollar (`34c`), dollars and cents
 * from there on (`$19.29`).
 */
export function formatMoney(usd: number): string {
  const value = Math.max(0, usd)
  const cents = Math.round(value * 100)
  if (cents === 0 && value > 0) return "<1c"
  if (cents < 100) return `${cents}c`
  return exact.format(value)
}

/** Exact money for expanded rows: `$19.29`. */
export function formatExact(usd: number): string {
  return exact.format(Math.max(0, usd))
}

/** Compact token count: `950`, `172k`, `1.2M`. */
export function formatTokens(tokens: number): string {
  const value = Math.max(0, Math.round(tokens))
  if (value < 1_000) return String(value)
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`
  const millions = value / 1_000_000
  return `${millions < 10 ? millions.toFixed(1).replace(/\.0$/, "") : Math.round(millions)}M`
}

/** Full token count: `592,819`. */
export function formatCount(tokens: number): string {
  return integer.format(Math.max(0, Math.round(tokens)))
}

// While the family is still loading, or loading gave up, totals may be
// missing descendants, so they carry a subtle marker.
export const MARKERS: Record<HydrationStatus, string> = {
  ready: "",
  idle: " …",
  loading: " …",
  error: " ?",
}

const PARTIALS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"]
const FULL = "█"
const EMPTY = "░"
const MARKER = "│"

export type BarSegment = { text: string; kind: "fill" | "empty" | "marker" }

/**
 * A block progress bar, `width` cells wide, with eighth-cell precision.
 * `marker` (0..1) optionally draws a threshold line, e.g. auto-compaction.
 * Returned as segments so the renderer can colour each part.
 */
export function progressBar(width: number, ratio: number, marker?: number): BarSegment[] {
  const cells = Math.max(1, Math.floor(width))
  const clamped = Math.min(1, Math.max(0, Number.isFinite(ratio) ? ratio : 0))
  const eighths = Math.round(clamped * cells * 8)
  const full = Math.floor(eighths / 8)
  const partial = PARTIALS[eighths % 8]

  const chars: Array<BarSegment["kind"]> = []
  for (let i = 0; i < cells; i++) chars.push(i < full ? "fill" : "empty")
  const text: string[] = chars.map((kind) => (kind === "fill" ? FULL : EMPTY))
  if (partial && full < cells) {
    text[full] = partial
    chars[full] = "fill"
  }
  if (marker !== undefined && marker > 0 && marker < 1) {
    const at = Math.min(cells - 1, Math.round(marker * cells))
    // Only draw the marker on unfilled cells, so the fill stays readable.
    if (chars[at] === "empty") {
      text[at] = MARKER
      chars[at] = "marker"
    }
  }

  const segments: BarSegment[] = []
  for (let i = 0; i < cells; i++) {
    const last = segments[segments.length - 1]
    if (last && last.kind === chars[i]) last.text += text[i]
    else segments.push({ kind: chars[i], text: text[i] })
  }
  return segments
}

/** Approximate usable width of the sidebar content, in cells. */
export const SIDEBAR_WIDTH = 36

/** Truncate at the end with an ellipsis, so the start stays readable. */
export function fit(text: string, width: number): string {
  const max = Math.max(1, Math.floor(width))
  const chars = [...text]
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`
}

export function percent(ratio: number): string {
  return `${Math.round(Math.max(0, ratio) * 100)}%`
}

export type Pressure = "low" | "medium" | "high"

/** Bar colour band for context pressure. */
export function pressure(ratio: number): Pressure {
  if (ratio >= 0.9) return "high"
  if (ratio >= 0.7) return "medium"
  return "low"
}

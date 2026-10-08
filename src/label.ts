import type { HydrationStatus } from "./hydration.ts"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

export type SpendTotals = { total: number; subagents: number }

// A complete total renders as `$1.23 ($0.45)`. While the family is still
// loading, or loading gave up, the total may be missing descendants, so it
// carries a subtle marker instead of looking definitive.
const MARKERS: Record<HydrationStatus, string> = {
  ready: "",
  idle: " …",
  loading: " …",
  error: " ?",
}

export function formatLabel(spend: SpendTotals, status: HydrationStatus): string {
  return `${money.format(spend.total)} (${money.format(spend.subagents)})${MARKERS[status]}`
}

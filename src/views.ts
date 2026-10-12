// Pure view logic: totals and breakdown rows for a session family, and the
// live conditions shown below them while they hold. No Solid or TUI
// dependencies, so it is unit-testable.
import { modelKey, type LedgerEntry, type ModelRef, type TokenUsage } from "./ledger.ts"

export const VIEW_NAMES = ["agents", "agentTypes", "models"] as const
export type ViewName = (typeof VIEW_NAMES)[number]

export const VIEW_TITLES: Record<ViewName, string> = {
  agents: "By agent",
  agentTypes: "By agent type",
  models: "By model",
}

function isViewName(value: unknown): value is ViewName {
  return VIEW_NAMES.includes(value as ViewName)
}

/** Configured views, in order, without duplicates; all views when unset or invalid. */
export function resolveViews(value: unknown): ViewName[] {
  if (!Array.isArray(value)) return [...VIEW_NAMES]
  const views = [...new Set(value.filter(isViewName))]
  return views.length > 0 ? views : [...VIEW_NAMES]
}

export type Member = {
  id: string
  parentID?: string
  agent?: string
  model?: ModelRef
  title?: string
  cost: number
  tokens?: TokenUsage
  running: boolean
}

export type Family = {
  rootID: string
  members: Member[]
  /** Per-agent and per-model totals for the root, once read. */
  ledger?: LedgerEntry
}

export type Row = {
  amount: number
  label: string
  /** Nesting level under an expandable row. */
  depth?: number
  /** Set on rows that expand, with their current state. */
  toggle?: { id: "subagents"; open: boolean }
}

export type ViewOptions = {
  /** The agents view lists each subagent under its total. */
  subagentsOpen?: boolean
}

export type Totals = {
  total: number
  /** Token usage summed by type across every step of every family session. */
  usage: TokenUsage
  orchestrator: number
  subagents: number
  tokens: number
  /** cache.read / (input + cache.read + cache.write); undefined without input. */
  cacheHit?: number
  /** input + cache.read + cache.write */
  input: number
}

function root(family: Family): Member | undefined {
  return family.members.find((member) => member.id === family.rootID)
}

function children(family: Family): Member[] {
  return family.members.filter((member) => member.id !== family.rootID)
}

export function totals(family: Family): Totals {
  let total = 0
  const sum: TokenUsage = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
  for (const member of family.members) {
    total += member.cost
    const usage = member.tokens
    if (!usage) continue
    sum.input += usage.input
    sum.output += usage.output
    sum.reasoning += usage.reasoning
    sum.cache.read += usage.cache.read
    sum.cache.write += usage.cache.write
  }
  const tokens = sum.input + sum.output + sum.reasoning + sum.cache.read + sum.cache.write
  const read = sum.cache.read
  const input = sum.input + sum.cache.read + sum.cache.write
  const orchestrator = root(family)?.cost ?? 0
  return {
    total,
    usage: sum,
    orchestrator,
    subagents: Math.max(0, total - orchestrator),
    tokens,
    input,
    cacheHit: input > 0 ? read / input : undefined,
  }
}

const byAmount = (a: { amount: number }, b: { amount: number }) => b.amount - a.amount

// Spend the ledger cannot attribute to a message (title generation,
// compaction). Hidden while the root is running, when the server total can
// briefly run ahead of the ledger.
const OVERHEAD_MIN = 0.005

const OVERHEAD_LABEL = "other"

type Amount = { label: string; amount: number }

/**
 * The root's spend split by the ledger (`byAgent` or `byModel`), plus an
 * `other` row for overhead; `fallback` labels the whole root cost before
 * the ledger is read.
 */
function rootRows(family: Family, split: "byAgent" | "byModel", fallback: (member: Member) => string): Amount[] {
  const member = root(family)
  if (!member) return []
  const ledger = family.ledger
  if (!ledger || ledger.count === 0) {
    return member.cost > 0 ? [{ label: fallback(member), amount: member.cost }] : []
  }
  const rows = Object.entries(ledger[split])
    .filter(([, amount]) => amount > 0)
    .map(([label, amount]) => ({ label, amount }))
  const overhead = member.cost - ledger.cost
  if (!member.running && overhead >= OVERHEAD_MIN) rows.push({ label: OVERHEAD_LABEL, amount: overhead })
  return rows
}

/** Sum entries by key; `label` names each group (the key by default). */
function grouped(
  entries: Array<{ key: string; amount: number; sessions: number }>,
  label: (key: string) => string = (key) => key,
): Row[] {
  const groups = new Map<string, { amount: number; sessions: number }>()
  for (const entry of entries) {
    const group = groups.get(entry.key) ?? { amount: 0, sessions: 0 }
    group.amount += entry.amount
    group.sessions += entry.sessions
    groups.set(entry.key, group)
  }
  return [...groups]
    .map(([key, group]) => ({
      label: group.sessions > 1 ? `${label(key)} ×${group.sessions}` : label(key),
      amount: group.amount,
    }))
    .filter((row) => row.amount > 0)
    .sort(byAmount)
}

function modelID(key: string): string {
  const slash = key.indexOf("/")
  return slash >= 0 ? key.slice(slash + 1) : key
}

/**
 * Model keys (`providerID/modelID`) shortened to the model ID, unless
 * another provider in `keys` has a model with the same ID.
 */
function modelLabels(keys: string[]): (key: string) => string {
  const providers = new Map<string, Set<string>>()
  for (const key of keys) {
    const id = modelID(key)
    providers.set(id, (providers.get(id) ?? new Set()).add(key))
  }
  return (key) => {
    const id = modelID(key)
    return (providers.get(id)?.size ?? 0) > 1 ? key : id
  }
}

function subagentLabel(member: Member): string {
  const agent = member.agent ?? "subagent"
  return member.title ? `${agent} · ${member.title}` : agent
}

const byCost = (a: Member, b: Member) => b.cost - a.cost

export function viewRows(view: ViewName, family: Family, options: ViewOptions = {}): Row[] {
  switch (view) {
    case "agents": {
      // Orchestrator vs subagents; per-agent detail lives in `agentTypes`.
      // With more than one subagent, the subagent total expands into one
      // row per subagent.
      const sum = totals(family)
      const rows: Row[] = [{ label: "Orchestrator", amount: sum.orchestrator }]
      const subagents = children(family).sort(byCost)
      if (subagents.length === 0) return rows
      const expandable = subagents.length > 1
      const open = expandable && options.subagentsOpen === true
      rows.push({
        label: `Subagents (${subagents.length})`,
        amount: sum.subagents,
        ...(expandable ? { toggle: { id: "subagents" as const, open } } : {}),
      })
      if (open) {
        for (const member of subagents) {
          rows.push({ label: subagentLabel(member), amount: member.cost, depth: 1 })
        }
      }
      return rows
    }
    case "agentTypes":
      return grouped([
        ...rootRows(family, "byAgent", (member) => member.agent ?? "orchestrator").map((row) => ({
          key: row.label,
          amount: row.amount,
          sessions: 0,
        })),
        ...children(family).map((member) => ({ key: member.agent ?? "subagent", amount: member.cost, sessions: 1 })),
      ])
    case "models": {
      // Grouped by the full `providerID/modelID`, so the same model ID from
      // two providers stays apart.
      const entries = [
        ...rootRows(family, "byModel", (member) => modelKey(member.model)).map((row) => ({
          key: row.label,
          amount: row.amount,
          sessions: 0,
        })),
        ...children(family).map((child) => ({ key: modelKey(child.model), amount: child.cost, sessions: 0 })),
      ]
      return grouped(entries, modelLabels(entries.filter((entry) => entry.amount > 0).map((entry) => entry.key)))
    }
  }
}

export type TokenRow = { label: string; tokens: number }

/**
 * Token usage by type in a fixed order: input, output, context, cache read,
 * cache write. Reasoning follows output only when the model reported any.
 * `context` is the viewed session's current context size, for comparison
 * with the cumulative counts around it.
 */
export function tokenRows(usage: TokenUsage, context?: number): TokenRow[] {
  return [
    { label: "input", tokens: usage.input },
    { label: "output", tokens: usage.output },
    ...(usage.reasoning > 0 ? [{ label: "reasoning", tokens: usage.reasoning }] : []),
    ...(context !== undefined ? [{ label: "context", tokens: context }] : []),
    { label: "cache read", tokens: usage.cache.read },
    { label: "cache write", tokens: usage.cache.write },
  ]
}

// ---- Live conditions ------------------------------------------------------

export type LiveOptions = {
  /** Show running subagents with their own context bars. */
  subagents: boolean
  /** Warn when the family's cache hit rate drops below this ratio (0..1). */
  cacheHitBelow?: number
  /** Minimum input tokens before the cache warning can trigger. */
  cacheMinInput: number
}

export const LIVE_DEFAULTS: LiveOptions = { subagents: true, cacheHitBelow: 0.5, cacheMinInput: 100_000 }

function ratioOption(value: unknown): number | undefined {
  return typeof value === "number" && value > 0 && value < 1 ? value : undefined
}

export function resolveLive(value: unknown): LiveOptions {
  if (value === false) return { subagents: false, cacheHitBelow: undefined, cacheMinInput: LIVE_DEFAULTS.cacheMinInput }
  if (!value || typeof value !== "object") return { ...LIVE_DEFAULTS }
  const options = value as Record<string, unknown>
  return {
    subagents: options.subagents !== false,
    cacheHitBelow:
      options.cacheHitBelow === false ? undefined : (ratioOption(options.cacheHitBelow) ?? LIVE_DEFAULTS.cacheHitBelow),
    cacheMinInput:
      typeof options.cacheMinInput === "number" && options.cacheMinInput >= 0
        ? options.cacheMinInput
        : LIVE_DEFAULTS.cacheMinInput,
  }
}

export type RunningRow = { id: string; label: string; amount: number; ratio?: number }

export type Live =
  | { id: "subagents"; rows: RunningRow[] }
  | { id: "cache"; hit: number; threshold: number }

export type LiveId = Live["id"]

/** Every live condition currently true, in priority order. */
export function liveConditions(
  family: Family,
  options: LiveOptions,
  context: (sessionID: string) => { tokens: number; limit?: number } | undefined,
): Live[] {
  const live: Live[] = []
  if (options.subagents) {
    const rows = children(family)
      .filter((member) => member.running)
      .map((member) => {
        const usage = context(member.id)
        return {
          id: member.id,
          label: member.agent ?? "subagent",
          amount: member.cost,
          ratio: usage?.limit ? usage.tokens / usage.limit : undefined,
        }
      })
    if (rows.length > 0) live.push({ id: "subagents", rows })
  }
  if (options.cacheHitBelow !== undefined) {
    const sum = totals(family)
    if (sum.cacheHit !== undefined && sum.input >= options.cacheMinInput && sum.cacheHit < options.cacheHitBelow) {
      live.push({ id: "cache", hit: sum.cacheHit, threshold: options.cacheHitBelow })
    }
  }
  return live
}

/** The live conditions to show, stacked in order, skipping dismissed ones. */
export function visibleLive(live: Live[], dismissed: ReadonlySet<LiveId>): Live[] {
  return live.filter((condition) => !dismissed.has(condition.id))
}

/** Dismissals last only while their condition holds; drop the rest. */
export function keepDismissed(live: Live[], dismissed: ReadonlySet<LiveId>): Set<LiveId> {
  const current = new Set(live.map((condition) => condition.id))
  return new Set([...dismissed].filter((id) => current.has(id)))
}

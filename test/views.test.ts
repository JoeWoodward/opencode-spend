import { describe, expect, test } from "bun:test"
import { emptyEntry } from "../src/ledger"
import {
  keepDismissed,
  liveConditions,
  resolveLive,
  resolveViews,
  tokenRows,
  totals,
  viewRows,
  type Family,
  type Member,
  VIEW_NAMES,
  visibleLive,
} from "../src/views"

const tokens = (input: number, read: number, write = 0, output = 0) => ({
  input,
  output,
  reasoning: 0,
  cache: { read, write },
})

const member = (id: string, cost: number, extra: Partial<Member> = {}): Member => ({
  id,
  cost,
  running: false,
  ...extra,
})

function family(): Family {
  return {
    rootID: "root",
    members: [
      member("root", 13, { agent: "build", model: { id: "opus", providerID: "p" }, tokens: tokens(10, 80, 10, 5) }),
      member("e1", 2, { parentID: "root", agent: "explore", title: "Find files", model: { id: "haiku", providerID: "p" } }),
      member("e2", 1, { parentID: "root", agent: "explore", title: "Read docs", model: { id: "haiku", providerID: "p" } }),
      member("g1", 4, { parentID: "root", agent: "general", title: "Refactor", model: { id: "opus", providerID: "p" } }),
    ],
    ledger: {
      ...emptyEntry(1),
      count: 3,
      cost: 12.5,
      byAgent: { plan: 4.5, build: 8 },
      byModel: { "p/opus": 12.5 },
    },
  }
}

const labels = (rows: ReturnType<typeof viewRows>) =>
  rows.map((row) => `${row.amount} ${row.label}`)

describe("totals", () => {
  test("sums cost, tokens and cache hit rate across the family", () => {
    expect(totals(family())).toMatchObject({
      total: 20,
      usage: { input: 10, output: 5, reasoning: 0, cache: { read: 80, write: 10 } },
      orchestrator: 13,
      subagents: 7,
      tokens: 105,
      input: 100,
      cacheHit: 0.8,
    })
  })

  test("cache hit is undefined without input", () => {
    expect(totals({ rootID: "r", members: [member("r", 1)] }).cacheHit).toBeUndefined()
  })
})

describe("tokenRows", () => {
  test("fixed order: input, output, cache read, cache write", () => {
    expect(tokenRows(totals(family()).usage)).toEqual([
      { label: "input", tokens: 10 },
      { label: "output", tokens: 5 },
      { label: "cache read", tokens: 80 },
      { label: "cache write", tokens: 10 },
    ])
  })

  test("context follows output when known", () => {
    expect(tokenRows(totals(family()).usage, 42).map((row) => row.label)).toEqual([
      "input",
      "output",
      "context",
      "cache read",
      "cache write",
    ])
  })

  test("reasoning follows output only when reported", () => {
    const usage = { input: 1, output: 2, reasoning: 3, cache: { read: 0, write: 0 } }
    expect(tokenRows(usage).map((row) => row.label)).toEqual(["input", "output", "reasoning", "cache read", "cache write"])
  })
})

describe("viewRows", () => {
  test("agents: orchestrator vs subagents, with a subagent count", () => {
    expect(labels(viewRows("agents", family()))).toEqual(["13 Orchestrator", "7 Subagents (3)"])
  })

  test("agents: more than one subagent makes the total expandable", () => {
    const closed = viewRows("agents", family())
    expect(closed[1]).toMatchObject({ toggle: { id: "subagents", open: false } })
    const open = viewRows("agents", family(), { subagentsOpen: true })
    expect(labels(open)).toEqual([
      "13 Orchestrator",
      "7 Subagents (3)",
      "4 general · Refactor",
      "2 explore · Find files",
      "1 explore · Read docs",
    ])
    expect(open[1]).toMatchObject({ toggle: { id: "subagents", open: true } })
    expect(open.slice(2).every((row) => row.depth === 1)).toBe(true)
  })

  test("agents: a single subagent has no expand handle", () => {
    const f = family()
    f.members = f.members.slice(0, 2)
    const rows = viewRows("agents", f, { subagentsOpen: true })
    expect(labels(rows)).toEqual(["13 Orchestrator", "2 Subagents (1)"])
    expect(rows[1]).not.toHaveProperty("toggle")
  })

  test("agents: a solo session has no subagent row", () => {
    const f: Family = { rootID: "r", members: [member("r", 1, { agent: "build" })] }
    expect(labels(viewRows("agents", f))).toEqual(["1 Orchestrator"])
  })

  test("agentTypes: overhead is hidden while the root is running", () => {
    const f = family()
    f.members[0].running = true
    expect(labels(viewRows("agentTypes", f))).not.toContain("0.5 other")
  })

  test("agentTypes: falls back to the root's own agent before the ledger is read", () => {
    const f = { ...family(), ledger: undefined }
    expect(labels(viewRows("agentTypes", f))).toEqual(["13 build", "4 general", "3 explore ×2"])
  })

  test("agentTypes: groups subagents by agent with a session count", () => {
    expect(labels(viewRows("agentTypes", family()))).toEqual([
      "8 build",
      "4.5 plan",
      "4 general",
      "3 explore ×2",
      "0.5 other",
    ])
  })

  test("models: merges the root's models with subagent models, with overhead as other", () => {
    // Root costs 13, of which the ledger attributes 12.5 to messages.
    expect(labels(viewRows("models", family()))).toEqual(["16.5 opus", "3 haiku", "0.5 other"])
  })

  test("models: overhead is hidden while the root is running", () => {
    const f = family()
    f.members[0].running = true
    expect(labels(viewRows("models", f))).toEqual(["16.5 opus", "3 haiku"])
  })

  test("models: falls back to the root's own model before the ledger is read", () => {
    const f = { ...family(), ledger: undefined }
    expect(labels(viewRows("models", f))).toEqual(["17 opus", "3 haiku"])
  })

  test("models: the same model ID from two providers stays apart, with full labels", () => {
    const f: Family = {
      rootID: "r",
      members: [
        member("r", 3, { model: { id: "same", providerID: "a" } }),
        member("c", 2, { parentID: "r", model: { id: "same", providerID: "b" } }),
        member("d", 1, { parentID: "r", model: { id: "solo", providerID: "a" } }),
      ],
    }
    expect(labels(viewRows("models", f))).toEqual(["3 a/same", "2 b/same", "1 solo"])
  })
})

describe("options", () => {
  test("resolveViews keeps valid views in order without duplicates", () => {
    expect(resolveViews(undefined)).toEqual([...VIEW_NAMES])
    expect(resolveViews(["models", "nope", "agents", "models"])).toEqual(["models", "agents"])
    expect(resolveViews(["nope"])).toEqual([...VIEW_NAMES])
  })

  test("resolveLive", () => {
    expect(resolveLive(undefined)).toEqual({ subagents: true, cacheHitBelow: 0.5, cacheMinInput: 100_000 })
    expect(resolveLive(false)).toMatchObject({ subagents: false, cacheHitBelow: undefined })
    expect(resolveLive({ subagents: false, cacheHitBelow: 0.3, cacheMinInput: 0 })).toEqual({
      subagents: false,
      cacheHitBelow: 0.3,
      cacheMinInput: 0,
    })
    expect(resolveLive({ cacheHitBelow: false }).cacheHitBelow).toBeUndefined()
    expect(resolveLive({ cacheHitBelow: 7 }).cacheHitBelow).toBe(0.5)
  })
})

describe("live conditions", () => {
  const options = { subagents: true, cacheHitBelow: 0.9, cacheMinInput: 50 }

  test("running subagents get their own context rows", () => {
    const f = family()
    f.members[1].running = true
    const live = liveConditions(f, { ...options, cacheHitBelow: undefined }, (id) =>
      id === "e1" ? { tokens: 50, limit: 200 } : undefined,
    )
    expect(live).toEqual([
      { id: "subagents", rows: [{ id: "e1", label: "explore", amount: 2, ratio: 0.25 }] },
    ])
  })

  test("low cache hit rate triggers above the minimum input", () => {
    expect(liveConditions(family(), options, () => undefined)).toEqual([{ id: "cache", hit: 0.8, threshold: 0.9 }])
    expect(liveConditions(family(), { ...options, cacheMinInput: 1_000 }, () => undefined)).toEqual([])
  })

  test("conditions stack in priority order; dismissed ones are skipped until they clear", () => {
    const f = family()
    f.members[1].running = true
    const live = liveConditions(f, options, () => undefined)
    const ids = (dismissed: string[]) => visibleLive(live, new Set(dismissed as never[])).map((c) => c.id)
    expect(ids([])).toEqual(["subagents", "cache"])
    expect(ids(["subagents"])).toEqual(["cache"])
    expect(ids(["subagents", "cache"])).toEqual([])
    expect(keepDismissed([live[1]], new Set(["subagents", "cache"]))).toEqual(new Set(["cache"]))
  })
})

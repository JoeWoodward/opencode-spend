import { describe, expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/tui/context"
import type { HydrationStatus, ViewState } from "../src/hydration"
import { formatExact, MARKERS } from "../src/label"
import { createSpendHydrator, createStoredLedger, familySpend, resolveConfig, type SpendOptions } from "../src/spend"
import { createFakeContext, fastSleep, tick, waitFor, type FakeWorld, type Row } from "./fake-context"

// `$total ($subagents)` plus the hydration marker: a compact way to assert
// both the family total and its completeness.
function spendLabel(session: Pick<Context["data"]["session"], "root" | "cost" | "get">, id: string, state: ViewState) {
  const spend = familySpend(session, id, state)
  return `${formatExact(spend.total)} (${formatExact(spend.subagents)})${MARKERS[state.status]}`
}

const fast: SpendOptions = { baseDelayMs: 10, maxDelayMs: 40, sleep: fastSleep }

// Exact binary fractions, so expected totals do not depend on float noise.
//   root 1.00
//   ├─ c1 0.25 ── g1 0.125
//   ├─ c2 0.25
//   └─ c3 0.25   (root's children span two pages)
function family(): Row[] {
  return [
    { id: "root", cost: 1 },
    { id: "c1", parentID: "root", cost: 0.25 },
    { id: "c2", parentID: "root", cost: 0.25 },
    { id: "c3", parentID: "root", cost: 0.25 },
    { id: "g1", parentID: "c1", cost: 0.125 },
  ]
}

function setup(world: FakeWorld, options: SpendOptions = {}) {
  let changes = 0
  const spend = createSpendHydrator(world.context, () => changes++, { ...fast, ...options })
  const label = (id: string) => spendLabel(world.session, id, spend.hydrator.state(id))
  return { ...spend, label, changes: () => changes }
}

const ready = (spend: ReturnType<typeof setup>, id: string) =>
  waitFor(() => spend.hydrator.state(id).status === "ready", `${id} ready`)

describe("spend totals", () => {
  test("a root-only session has no subagent share", async () => {
    const world = createFakeContext([{ id: "solo", cost: 1.5 }], { preloaded: ["solo"] })
    const spend = setup(world)
    spend.hydrator.acquire("solo")
    await ready(spend, "solo")
    expect(spend.label("solo")).toBe("$1.50 ($0.00)")
    spend.dispose()
  })

  test("nested subagents, including preexisting grandchildren, count toward the total", async () => {
    const world = createFakeContext(family(), { preloaded: ["root"] })
    const spend = setup(world)
    spend.hydrator.acquire("root")
    // Before the family is loaded the total is marked incomplete.
    expect(spend.label("root")).toBe("$1.00 ($0.00) …")
    await ready(spend, "root")
    // 1.875 total, 0.875 subagents; half-cents round up.
    expect(spend.label("root")).toBe("$1.88 ($0.88)")
    spend.dispose()
  })

  test("a viewed subagent shows its root family's total", async () => {
    const world = createFakeContext(family(), { preloaded: ["g1"] })
    const spend = setup(world)
    spend.hydrator.acquire("g1")
    await ready(spend, "g1")
    expect(spend.hydrator.state("g1").root).toBe("root")
    expect(spend.label("g1")).toBe("$1.88 ($0.88)")
    spend.dispose()
  })

  test("falls back to the cache's root until ancestry is resolved", () => {
    const world = createFakeContext(family(), { preloaded: ["c1", "g1"] })
    // Only c1's subtree is cached: the cache's best guess for g1 is c1.
    expect(spendLabel(world.session, "g1", { status: "loading" })).toBe("$0.38 ($0.13) …")
  })

  test("the subagent share is never negative", () => {
    const session = { root: () => "r", cost: () => 0.5, get: () => ({ cost: 1 }) } as never
    expect(spendLabel(session, "r", { status: "ready", root: "r" })).toBe("$0.50 ($0.00)")
  })


  test("marks the label by hydration status", () => {
    const world = createFakeContext([{ id: "solo", cost: 2 }], { preloaded: ["solo"] })
    const markers: Record<HydrationStatus, string> = {
      ready: "$2.00 ($0.00)",
      idle: "$2.00 ($0.00) …",
      loading: "$2.00 ($0.00) …",
      error: "$2.00 ($0.00) ?",
    }
    for (const [status, label] of Object.entries(markers)) {
      expect(spendLabel(world.session, "solo", { status: status as HydrationStatus, root: "solo" })).toBe(label)
    }
  })
})

describe("context wiring", () => {
  test("follows cursor pagination and passes the cancellation signal to the client", async () => {
    const world = createFakeContext(family(), { preloaded: ["root"] })
    const spend = setup(world)
    spend.hydrator.acquire("root")
    await ready(spend, "root")
    // Root's three children come in two pages: no cursor, then "2".
    expect(world.calls.cursors.filter((cursor) => cursor === "2").length).toBe(1)
    expect(world.calls.signals.every((signal) => signal instanceof AbortSignal)).toBe(true)
    spend.dispose()
  })

  test("server.connected retries hydration that gave up", async () => {
    const world = createFakeContext(family(), { preloaded: ["root"] })
    world.failures.list = 1_000
    const spend = setup(world, { maxAttempts: 2 })
    spend.hydrator.acquire("root")
    await waitFor(() => spend.hydrator.state("root").status === "error", "error")
    expect(spend.label("root")).toBe("$1.00 ($0.00) ?")
    const calls = world.calls.list
    for (let i = 0; i < 10; i++) await tick()
    expect(world.calls.list).toBe(calls)

    world.failures.list = 0
    world.emit("server.connected")
    await ready(spend, "root")
    expect(spend.label("root")).toBe("$1.88 ($0.88)")
    spend.dispose()
  })

  test("dispose unsubscribes listeners and cancels hydration", async () => {
    const world = createFakeContext(family(), { preloaded: ["root"] })
    const resume = world.pauseAll()
    const spend = setup(world)
    expect(world.listeners("server.connected")).toBe(1)
    spend.hydrator.acquire("root")
    await tick()
    const changes = spend.changes()
    const before = world.calls.list + world.calls.sync
    spend.dispose()
    expect(world.listeners("server.connected")).toBe(0)
    expect(world.offs()).toBe(1)
    resume()
    for (let i = 0; i < 30; i++) await tick()
    // In-flight requests may settle, but nothing new is scheduled.
    expect(world.calls.list + world.calls.sync).toBeLessThanOrEqual(before + 1)
    expect(world.cache.size).toBe(1)
    expect(spend.changes()).toBe(changes)
    expect(spend.hydrator.state("root").status).toBe("idle")
  })
})

describe("live updates after hydration", () => {
  test("cost changes and new sessions are reflected without re-hydrating", async () => {
    const world = createFakeContext(family(), { preloaded: ["root"] })
    const spend = setup(world)
    spend.hydrator.acquire("root")
    await ready(spend, "root")
    const calls = { list: world.calls.list, sync: world.calls.sync }

    world.setCost("g1", 0.625)
    expect(spend.label("root")).toBe("$2.38 ($1.38)")
    world.setCost("root", 1.5)
    expect(spend.label("root")).toBe("$2.88 ($1.38)")
    // A grandchild created after hydration (delivered via session.created).
    world.create({ id: "g2", parentID: "c2", cost: 0.5 })
    expect(spend.label("root")).toBe("$3.38 ($1.88)")

    for (let i = 0; i < 10; i++) await tick()
    expect(world.calls).toMatchObject(calls)
    expect(spend.hydrator.state("root").status).toBe("ready")
    spend.dispose()
  })
})

describe("two sidebars on one session family", () => {
  async function single() {
    const world = createFakeContext(family(), { preloaded: ["root"] })
    const spend = setup(world)
    spend.hydrator.acquire("root")
    await ready(spend, "root")
    spend.dispose()
    return { list: world.calls.list, sync: world.calls.sync }
  }

  test("both views share one hydration", async () => {
    const baseline = await single()
    const world = createFakeContext(family(), { preloaded: ["root"] })
    const spend = setup(world)
    // Each sidebar acquires its session, as `useModel` does.
    const releaseFirst = spend.hydrator.acquire("root")
    const releaseSecond = spend.hydrator.acquire("root")
    await ready(spend, "root")
    expect({ list: world.calls.list, sync: world.calls.sync }).toEqual(baseline)
    expect(spend.label("root")).toBe("$1.88 ($0.88)")
    releaseFirst()
    releaseSecond()
    spend.dispose()
  })

  test("unmounting one view mid-hydration keeps the other working", async () => {
    const baseline = await single()
    const world = createFakeContext(family(), { preloaded: ["root"] })
    const resume = world.pauseAll()
    const spend = setup(world)
    const releaseFirst = spend.hydrator.acquire("root")
    const releaseSecond = spend.hydrator.acquire("root")
    await tick()
    releaseFirst()
    // Releasing twice is harmless.
    releaseFirst()
    resume()
    await ready(spend, "root")
    expect({ list: world.calls.list, sync: world.calls.sync }).toEqual(baseline)
    world.setCost("c3", 0.75)
    expect(spend.label("root")).toBe("$2.38 ($1.38)")
    releaseSecond()
    spend.dispose()
  })
})

describe("large family", () => {
  test("hydrates a few hundred sessions with bounded concurrency", async () => {
    // 1 root, 20 children, 14 grandchildren each: 301 sessions, 1 cent each.
    const rows: Row[] = [{ id: "root", cost: 0.01 }]
    for (let c = 0; c < 20; c++) {
      rows.push({ id: `c${c}`, parentID: "root", cost: 0.01 })
      for (let g = 0; g < 14; g++) rows.push({ id: `c${c}g${g}`, parentID: `c${c}`, cost: 0.01 })
    }
    const world = createFakeContext(rows, { preloaded: ["root"], pageSize: 7 })
    const spend = setup(world)
    spend.hydrator.acquire("root")
    await ready(spend, "root")

    expect(world.cache.size).toBe(301)
    expect(spend.label("root")).toBe("$3.01 ($3.00)")
    // The default limit (4) bounds listing and syncing together.
    expect(world.peak()).toBeLessThanOrEqual(4)
    expect(world.peak()).toBeGreaterThan(1)
    // Every session synced once; one list per page, plus an empty page per leaf.
    expect(world.calls.sync).toBe(300)
    expect(world.calls.list).toBe(3 + 20 * 2 + 280)
    spend.dispose()
  })
})

describe("stored ledger", () => {
  const done = (id: string, agent: string, cost: number) => ({
    id,
    agent,
    cost,
    model: { id: "opus", providerID: "p" },
    tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 100, write: 0 } },
    time: { completed: 1 },
  })
  const config = { maxSavedSessions: 200 }

  test("step.ended catches the ledger up and records context usage", async () => {
    const world = createFakeContext([{ id: "root", cost: 10 }], {
      preloaded: ["root"],
      messages: { root: [done("m1", "plan", 1)] },
    })
    const stored = createStoredLedger(world.context, () => {}, config, { persistDelayMs: 0 })
    stored.ledger.acquire("root")
    await waitFor(() => stored.ledger.entry("root")?.cost === 1, "first read")

    world.addMessage("root", done("m2", "build", 2))
    world.emit("session.step.ended", { sessionID: "root", assistantMessageID: "m2", tokens: done("m2", "build", 2).tokens })
    await waitFor(() => stored.ledger.entry("root")?.cost === 3, "catch-up")
    expect(stored.ledger.entry("root")?.byAgent).toEqual({ plan: 1, build: 2 })
    expect(stored.usage.get("root")?.tokens).toBe(115)
    stored.dispose()
  })

  test("a restart resumes from storage and reads only the new messages", async () => {
    const storage = new Map<string, unknown>()
    const messages = { root: [done("m1", "plan", 1), done("m2", "build", 2)] }
    const first = createFakeContext([{ id: "root", cost: 10 }], { preloaded: ["root"], messages, storage })
    const a = createStoredLedger(first.context, () => {}, config, { persistDelayMs: 0 })
    a.ledger.acquire("root")
    await waitFor(() => a.ledger.entry("root")?.cost === 3, "first read")
    a.dispose()

    const second = createFakeContext([{ id: "root", cost: 10 }], {
      preloaded: ["root"],
      messages: { root: [...messages.root, done("m3", "build", 4)] },
      storage,
    })
    const b = createStoredLedger(second.context, () => {}, config, { persistDelayMs: 0 })
    b.ledger.acquire("root")
    // The saved entry holds only settled messages; m2 was provisional.
    expect(b.ledger.entry("root")?.cost).toBe(1)
    await waitFor(() => b.ledger.entry("root")?.cost === 7, "resumed")
    expect(b.ledger.entry("root")).toMatchObject({ head: "m2", count: 3 })
    // A single page, stopping at the saved head.
    expect(second.calls.messages.length).toBe(1)
    b.dispose()
  })

  test("pages with a cursor alone, as the server requires", async () => {
    const world = createFakeContext([{ id: "root", cost: 10 }], {
      preloaded: ["root"],
      messages: { root: [done("m1", "plan", 1), done("m2", "build", 2), done("m3", "build", 4)] },
    })
    const stored = createStoredLedger(world.context, () => {}, config, {
      persistDelayMs: 0,
      ledger: { fullPage: 1, maxAttempts: 1 },
    })
    stored.ledger.acquire("root")
    await waitFor(() => stored.ledger.entry("root")?.count === 3, "all pages")
    expect(stored.ledger.entry("root")?.byAgent).toEqual({ plan: 1, build: 6 })
    expect(world.calls.messages.map((call) => call.cursor)).toEqual([undefined, "1", "2"])
    // The cursor does not carry the type filter, so every page repeats it.
    expect(world.calls.messages.every((call) => call.type === "assistant")).toBe(true)
    stored.dispose()
  })

  test("server.connected retries ledger reads that gave up offline", async () => {
    const world = createFakeContext([{ id: "root", cost: 10 }], {
      preloaded: ["root"],
      messages: { root: [done("m1", "plan", 1)] },
    })
    const client = world.context.client.message as { list: (...args: unknown[]) => Promise<unknown> }
    const list = client.list
    let offline = true
    client.list = (...args) => (offline ? Promise.reject(new Error("offline")) : list(...args))
    const stored = createStoredLedger(world.context, () => {}, config, {
      persistDelayMs: 0,
      sleep: fastSleep,
      ledger: { maxAttempts: 2, baseDelayMs: 1 },
    })
    stored.ledger.acquire("root")
    for (let i = 0; i < 20; i++) await tick()
    expect(stored.ledger.entry("root")).toBeUndefined()
    offline = false
    world.emit("server.connected")
    await waitFor(() => stored.ledger.entry("root")?.cost === 1, "recovered")
    stored.dispose()
  })

  test("step.failed catches the ledger up", async () => {
    const world = createFakeContext([{ id: "root", cost: 10 }], {
      preloaded: ["root"],
      messages: { root: [done("m1", "plan", 1)] },
    })
    const stored = createStoredLedger(world.context, () => {}, config, { persistDelayMs: 0 })
    stored.ledger.acquire("root")
    await waitFor(() => stored.ledger.entry("root")?.cost === 1, "first read")
    world.addMessage("root", { ...done("m2", "build", 0.5), error: { type: "provider" } })
    world.emit("session.step.failed", { sessionID: "root", assistantMessageID: "m2", error: { type: "provider" } })
    await waitFor(() => stored.ledger.entry("root")?.cost === 1.5, "failed step counted")
    stored.dispose()
  })

  test("context usage keeps the model a step started with when the selection changes mid-step", () => {
    const world = createFakeContext([{ id: "root", cost: 10 }], { preloaded: ["root"] })
    const stored = createStoredLedger(world.context, () => {}, config, { persistDelayMs: 0 })
    const opus = { id: "opus", providerID: "p" }
    const haiku = { id: "haiku", providerID: "p" }
    world.emit("session.step.started", { sessionID: "root", assistantMessageID: "m1", model: opus })
    // The user picks another model while m1 runs.
    ;(world.cache.get("root") as { model?: unknown }).model = haiku
    world.emit("session.step.ended", { sessionID: "root", assistantMessageID: "m1", tokens: done("m1", "plan", 1).tokens })
    expect(stored.usage.get("root")).toEqual({ tokens: 115, model: opus })
    // Without a matching start, the session's model is the best guess.
    world.emit("session.step.ended", { sessionID: "root", assistantMessageID: "m2", tokens: done("m2", "plan", 1).tokens })
    expect(stored.usage.get("root")?.model).toEqual(haiku)
    stored.dispose()
  })

  test("writes are debounced and flushed on dispose", async () => {
    const world = createFakeContext([{ id: "root", cost: 10 }], {
      preloaded: ["root"],
      messages: { root: [done("m1", "plan", 1)] },
    })
    const stored = createStoredLedger(world.context, () => {}, config, { persistDelayMs: 60_000 })
    stored.ledger.acquire("root")
    await waitFor(() => stored.ledger.entry("root") !== undefined, "read")
    const saved = () => (world.storage.get("ledger") as { sessions: Record<string, unknown> }).sessions
    expect(saved().root).toBeUndefined()
    stored.dispose()
    expect(saved().root).toBeDefined()
  })

  test("session.deleted drops the saved entry", async () => {
    const world = createFakeContext([{ id: "root", cost: 10 }], {
      preloaded: ["root"],
      messages: { root: [done("m1", "plan", 1)] },
    })
    const stored = createStoredLedger(world.context, () => {}, config, { persistDelayMs: 0 })
    stored.ledger.acquire("root")
    await waitFor(() => stored.ledger.entry("root") !== undefined, "read")
    const saved = () => (world.storage.get("ledger") as { sessions: Record<string, unknown> }).sessions
    expect(saved().root).toBeDefined()
    world.emit("session.deleted", { sessionID: "root" })
    expect(saved().root).toBeUndefined()
    stored.dispose()
  })
})

describe("resolveConfig", () => {
  test("defaults", () => {
    expect(resolveConfig({})).toMatchObject({ barWidth: 24, maxSavedSessions: 200, compactionMarker: undefined })
  })

  test("validates options", () => {
    expect(resolveConfig({ barWidth: 30, compactionMarker: 0.8, maxSavedSessions: 10 })).toMatchObject({
      barWidth: 30,
      compactionMarker: 0.8,
      maxSavedSessions: 10,
    })
    expect(resolveConfig({ barWidth: 2, compactionMarker: 80, maxSavedSessions: -1 })).toMatchObject({
      barWidth: 24,
      compactionMarker: undefined,
      maxSavedSessions: 200,
    })
  })
})

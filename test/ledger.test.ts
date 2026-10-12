import { describe, expect, test } from "bun:test"
import { createLedger, emptyEntry, isEntry, LEDGER_VERSION, prune, type AssistantMessage, type LedgerEntry, type MessagePage } from "../src/ledger"
import { fastSleep, waitFor } from "./fake-context"

const done = (id: string, agent: string, cost: number, model = "opus"): AssistantMessage => ({
  id,
  agent,
  cost,
  model: { id: model, providerID: "p" },
  time: { completed: 1 },
})

// A server holding one session's assistant messages, oldest first.
function world(
  initial: AssistantMessage[],
  options: { own?: number; saved?: LedgerEntry; fail?: number } = {},
) {
  const messages = [...initial]
  const fetches: Array<{ cursor?: string; limit: number }> = []
  const saved = new Map<string, LedgerEntry>()
  if (options.saved) saved.set("root", options.saved)
  let failures = options.fail ?? 0
  let own = options.own
  const ledger = createLedger(
    {
      async fetch(_id, cursor, limit): Promise<MessagePage> {
        fetches.push({ cursor, limit })
        if (failures > 0) {
          failures--
          throw new Error("offline")
        }
        const newest = [...messages].reverse()
        const start = cursor ? Number(cursor) : 0
        const end = start + limit
        return { data: newest.slice(start, end), next: end < newest.length ? String(end) : undefined }
      },
      ownCost: () => own,
      load: (id) => saved.get(id),
      save: (id, entry) => saved.set(id, entry),
      now: () => 42,
      sleep: fastSleep,
    },
    { fullPage: 2, baseDelayMs: 1 },
  )
  return {
    ledger,
    messages,
    fetches,
    saved,
    setOwn: (value: number) => (own = value),
    setFailures: (value: number) => (failures = value),
    settled: () => waitFor(() => ledger.entry("root") !== undefined && fetches.length > 0, "ledger entry"),
  }
}

describe("ledger", () => {
  test("the first read pages through every message and sums by agent and model", async () => {
    const w = world([done("m1", "plan", 1), done("m2", "build", 2, "sonnet"), done("m3", "build", 4)])
    w.ledger.acquire("root")
    await w.settled()
    const entry = w.ledger.entry("root")!
    expect(entry).toMatchObject({ count: 3, cost: 7, byAgent: { plan: 1, build: 6 } })
    expect(entry.byModel).toEqual({ "p/opus": 5, "p/sonnet": 2 })
    expect(w.fetches.length).toBe(2)
  })

  test("the newest message stays provisional: shown, not saved", async () => {
    const w = world([done("m1", "plan", 1), done("m2", "build", 2)])
    w.ledger.acquire("root")
    await w.settled()
    expect(w.ledger.entry("root")).toMatchObject({ head: "m1", count: 2, cost: 3 })
    expect(w.saved.get("root")).toMatchObject({ head: "m1", count: 1, cost: 1, byAgent: { plan: 1 } })
  })

  test("a refresh reads one small page down to head", async () => {
    const w = world([done("m1", "plan", 1), done("m2", "build", 2), done("m3", "build", 4)])
    w.ledger.acquire("root")
    await w.settled()
    w.fetches.length = 0
    w.messages.push(done("m4", "plan", 8))
    w.ledger.refresh("root")
    await waitFor(() => w.ledger.entry("root")?.head === "m3", "m3 settled")
    expect(w.ledger.entry("root")).toMatchObject({ count: 4, cost: 15, byAgent: { plan: 9, build: 6 } })
    // m4, m3 (the old provisional message) and head (m2): one page of 4.
    expect(w.fetches).toEqual([{ cursor: undefined, limit: 4 }])
  })

  test("a catch-up that misses head on its first page continues with full pages", async () => {
    const w = world([done("m1", "plan", 1), done("m2", "build", 2)])
    w.ledger.acquire("root")
    await w.settled()
    w.fetches.length = 0
    for (let i = 3; i <= 12; i++) w.messages.push(done(`m${i}`, "build", 1))
    w.ledger.refresh("root")
    await waitFor(() => w.ledger.entry("root")?.head === "m11", "caught up")
    expect(w.ledger.entry("root")).toMatchObject({ count: 12, cost: 13 })
    // A small first page, then full pages (2 in this world).
    expect(w.fetches).toEqual([
      { cursor: undefined, limit: 4 },
      { cursor: "4", limit: 2 },
      { cursor: "6", limit: 2 },
      { cursor: "8", limit: 2 },
      { cursor: "10", limit: 2 },
    ])
  })

  test("a saved entry resumes after a restart without re-reading history", async () => {
    const saved = { ...emptyEntry(1), head: "m2", count: 2, cost: 3, byAgent: { plan: 1, build: 2 } }
    const w = world([done("m1", "plan", 1), done("m2", "build", 2), done("m3", "build", 4)], { saved, own: 7 })
    w.ledger.acquire("root")
    // Saved totals are available immediately.
    expect(w.ledger.entry("root")?.cost).toBe(3)
    await waitFor(() => w.ledger.entry("root")?.cost === 7, "m3 shown")
    expect(w.ledger.entry("root")).toMatchObject({ count: 3, byAgent: { plan: 1, build: 6 } })
    expect(w.fetches.length).toBe(1)
  })

  test("a running step gains its cost when it ends, however long it ran", async () => {
    // A step waiting on a long subagent has no cost until it ends.
    const w = world([done("m1", "plan", 1), { id: "m2", agent: "build", time: { created: 0 } }])
    w.ledger.acquire("root")
    await w.settled()
    expect(w.ledger.entry("root")).toMatchObject({ head: "m1", cost: 1 })
    w.messages[1] = done("m2", "build", 4)
    w.ledger.refresh("root")
    await waitFor(() => w.ledger.entry("root")?.cost === 5, "m2 cost")
    expect(w.ledger.entry("root")?.byAgent).toEqual({ plan: 1, build: 4 })
  })

  test("a failed step restarted under the same message ID is re-read", async () => {
    const failed: AssistantMessage = { id: "m2", agent: "build", error: { type: "x" }, finish: "error", time: { completed: 1 } }
    const w = world([done("m1", "plan", 1), failed])
    w.ledger.acquire("root")
    await w.settled()
    w.messages[1] = done("m2", "build", 3)
    w.ledger.refresh("root")
    await waitFor(() => w.ledger.entry("root")?.cost === 4, "restarted cost")
    expect(w.ledger.entry("root")?.byAgent).toEqual({ plan: 1, build: 3 })
  })

  test("an unfinished message below a newer one is final (abandoned)", async () => {
    const w = world([done("m1", "plan", 1), { id: "m2", agent: "build", cost: 0.5 }, done("m3", "build", 4)])
    w.ledger.acquire("root")
    await w.settled()
    expect(w.ledger.entry("root")).toMatchObject({ head: "m2", count: 3, cost: 5.5 })
  })

  test("rebuilds when head disappeared (revert)", async () => {
    const w = world([done("m1", "plan", 1), done("m2", "build", 2), done("m3", "build", 4)])
    w.ledger.acquire("root")
    await w.settled()
    w.messages.splice(1, 2, done("m4", "plan", 8))
    w.ledger.refresh("root")
    await waitFor(() => w.ledger.entry("root")?.cost === 9, "rebuilt")
    expect(w.ledger.entry("root")).toMatchObject({ head: "m1", count: 2, byAgent: { plan: 9 } })
  })

  test("a revert of only the provisional message needs no rebuild", async () => {
    const w = world([done("m1", "plan", 1), done("m2", "build", 2)])
    w.ledger.acquire("root")
    await w.settled()
    w.fetches.length = 0
    w.messages.splice(1, 1, done("m3", "plan", 8))
    w.ledger.refresh("root")
    await waitFor(() => w.ledger.entry("root")?.cost === 9, "m3 shown")
    expect(w.ledger.entry("root")?.byAgent).toEqual({ plan: 9 })
    expect(w.fetches.length).toBe(1)
  })

  test("ignores a saved entry from an older ledger version and reads again", async () => {
    const saved = { ...emptyEntry(1), v: 1, head: "m1", count: 1, cost: 99, byAgent: { plan: 99 } } as unknown as LedgerEntry
    const w = world([done("m1", "plan", 1), done("m2", "build", 2)], { saved })
    w.ledger.acquire("root")
    expect(w.ledger.entry("root")).toBeUndefined()
    await waitFor(() => w.ledger.entry("root")?.cost === 3, "read again")
    expect(w.saved.get("root")?.v).toBe(LEDGER_VERSION)
  })

  test("rebuilds a saved entry that counts more than the server reports", async () => {
    const saved = { ...emptyEntry(1), head: "m2", count: 2, cost: 50, byAgent: { plan: 50 } }
    const w = world([done("m1", "plan", 1), done("m2", "build", 2)], { saved, own: 3 })
    w.ledger.acquire("root")
    await waitFor(() => w.ledger.entry("root")?.cost === 3, "rebuilt")
    expect(w.ledger.entry("root")?.byAgent).toEqual({ plan: 1, build: 2 })
  })

  test("a provisional message the server has not costed yet does not force a rebuild", async () => {
    const w = world([done("m1", "plan", 1)], { own: 1 })
    w.ledger.acquire("root")
    await w.settled()
    w.fetches.length = 0
    // m2 ended, but the server's session cost has not caught up yet.
    w.messages.push(done("m2", "build", 2))
    w.ledger.refresh("root")
    await waitFor(() => w.ledger.entry("root")?.cost === 3, "m2 shown")
    expect(w.fetches.length).toBe(1)
  })

  test("retries failed reads", async () => {
    const w = world([done("m1", "plan", 1)], { fail: 2 })
    w.ledger.acquire("root")
    await waitFor(() => w.ledger.entry("root") !== undefined, "entry after retries")
    expect(w.fetches.length).toBe(3)
  })

  test("refreshAll retries a session whose reads gave up", async () => {
    const w = world([done("m1", "plan", 1)], { fail: 100 })
    w.ledger.acquire("root")
    await waitFor(() => w.fetches.length === 4, "gave up")
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(w.ledger.entry("root")).toBeUndefined()
    w.setFailures(0)
    w.ledger.refreshAll()
    await waitFor(() => w.ledger.entry("root")?.cost === 1, "recovered")
  })

  test("refreshes requested during a read are coalesced into one more read", async () => {
    const w = world([done("m1", "plan", 1)])
    w.ledger.acquire("root")
    w.ledger.refresh("root")
    w.ledger.refresh("root")
    await w.settled()
    await waitFor(() => w.fetches.length === 2, "second read")
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(w.fetches.length).toBe(2)
  })

  test("refresh is a no-op for untracked sessions and after dispose", async () => {
    const w = world([done("m1", "plan", 1)])
    w.ledger.refresh("root")
    w.ledger.dispose()
    w.ledger.acquire("root")
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(w.fetches.length).toBe(0)
  })
})

describe("prune", () => {
  test("keeps the most recently viewed entries", () => {
    const entries = { a: { ...emptyEntry(1) }, b: { ...emptyEntry(3) }, c: { ...emptyEntry(2) } }
    expect(Object.keys(prune(entries, 2)).sort()).toEqual(["b", "c"])
    expect(prune(entries, 5)).toBe(entries)
    expect(prune(entries, 0)).toEqual({})
  })
})

describe("isEntry", () => {
  test("accepts a well-formed entry", () => {
    expect(isEntry({ ...emptyEntry(1), head: "m1", byAgent: { build: 1 }, byModel: { "p/opus": 1 } })).toBe(true)
  })

  test("rejects saved values that would break the views or arithmetic", () => {
    const base = emptyEntry(1)
    for (const bad of [
      null,
      "entry",
      { ...base, v: 1 },
      { ...base, cost: Number.NaN },
      { ...base, count: "3" },
      { ...base, head: 7 },
      { ...base, byAgent: null },
      { ...base, byModel: [] },
      { ...base, byAgent: { build: "1" } },
      { ...base, byModel: { "p/opus": Number.POSITIVE_INFINITY } },
    ]) {
      expect(isEntry(bad)).toBe(false)
    }
  })
})

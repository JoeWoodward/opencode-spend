import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { HydrationStatus } from "../src/hydration"
import { formatLabel } from "../src/label"
import {
  createSpendHydrator,
  readLegacyLocation,
  resolveLocation,
  showsPrompt,
  showsSidebar,
  spendLabel,
  type SpendOptions,
} from "../src/spend"
import { createFakeContext, fastSleep, tick, waitFor, type FakeWorld, type Row } from "./fake-context"

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

  test("rounds fractional costs to cents", () => {
    expect(formatLabel({ total: 0.1 + 0.2, subagents: 0.3 - 0.1 }, "ready")).toBe("$0.30 ($0.20)")
    expect(formatLabel({ total: 1.234, subagents: 0.004 }, "ready")).toBe("$1.23 ($0.00)")
    expect(formatLabel({ total: 1.236, subagents: 0.996 }, "ready")).toBe("$1.24 ($1.00)")
    expect(formatLabel({ total: 1234.5, subagents: 0 }, "ready")).toBe("$1,234.50 ($0.00)")
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

describe("location option", () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-spend-"))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const file = (name: string, content: string) => {
    const path = join(dir, name)
    writeFileSync(path, content)
    return path
  }

  test("a valid option wins without reading the legacy file", () => {
    let reads = 0
    const legacy = () => (reads++, "sidebar" as const)
    expect(resolveLocation({ location: "prompt" }, legacy)).toBe("prompt")
    expect(resolveLocation({ location: "sidebar" }, legacy)).toBe("sidebar")
    expect(resolveLocation({ location: "both" }, legacy)).toBe("both")
    expect(reads).toBe(0)
  })

  test("an invalid or missing option falls back to the legacy file, then to both", () => {
    expect(resolveLocation({ location: "footer" }, () => "prompt")).toBe("prompt")
    expect(resolveLocation({}, () => "sidebar")).toBe("sidebar")
    expect(resolveLocation({ location: 3 }, () => undefined)).toBe("both")
  })

  test("reads the legacy file defensively", () => {
    expect(readLegacyLocation(file("valid.json", '{"location":"prompt"}'))).toBe("prompt")
    expect(readLegacyLocation(file("invalid.json", '{"location":"footer"}'))).toBeUndefined()
    expect(readLegacyLocation(file("malformed.json", "{"))).toBeUndefined()
    expect(readLegacyLocation(file("null.json", "null"))).toBeUndefined()
    expect(readLegacyLocation(join(dir, "missing.json"))).toBeUndefined()
  })

  test("maps a location to its slots", () => {
    expect([showsSidebar("both"), showsPrompt("both")]).toEqual([true, true])
    expect([showsSidebar("sidebar"), showsPrompt("sidebar")]).toEqual([true, false])
    expect([showsSidebar("prompt"), showsPrompt("prompt")]).toEqual([false, true])
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

describe("simultaneous sidebar and footer", () => {
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
    // Each view acquires its session, as `useSpendLabel` does.
    const releaseSidebar = spend.hydrator.acquire("root")
    const releaseFooter = spend.hydrator.acquire("root")
    await ready(spend, "root")
    expect({ list: world.calls.list, sync: world.calls.sync }).toEqual(baseline)
    expect(spend.label("root")).toBe("$1.88 ($0.88)")
    releaseSidebar()
    releaseFooter()
    spend.dispose()
  })

  test("unmounting one view mid-hydration keeps the other working", async () => {
    const baseline = await single()
    const world = createFakeContext(family(), { preloaded: ["root"] })
    const resume = world.pauseAll()
    const spend = setup(world)
    const releaseSidebar = spend.hydrator.acquire("root")
    const releaseFooter = spend.hydrator.acquire("root")
    await tick()
    releaseSidebar()
    // Releasing twice is harmless.
    releaseSidebar()
    resume()
    await ready(spend, "root")
    expect({ list: world.calls.list, sync: world.calls.sync }).toEqual(baseline)
    world.setCost("c3", 0.75)
    expect(spend.label("root")).toBe("$2.38 ($1.38)")
    releaseFooter()
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

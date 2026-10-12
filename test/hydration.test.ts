import { describe, expect, test } from "bun:test"
import { createHydrator, createLimiter, type HydrationDeps, type HydrationOptions, type Hydrator } from "../src/hydration"

type Session = { id: string; parentID?: string }

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

async function waitFor(check: () => boolean, label = "condition") {
  for (let i = 0; i < 500; i++) {
    if (check()) return
    await tick()
  }
  throw new Error(`timed out waiting for ${label}`)
}

// A fake server plus client cache. `sync` copies a server session into the
// cache and, like the real cache, only attaches it to a family if its parent
// is already cached - so the test can assert parent-before-child order.
function createWorld(sessions: Session[], options: { pageSize?: number; preloaded?: string[] } = {}) {
  const server = new Map(sessions.map((session) => [session.id, session]))
  const cache = new Map<string, Session>()
  for (const id of options.preloaded ?? []) cache.set(id, server.get(id)!)
  const pageSize = options.pageSize ?? 2
  const calls = { list: 0, sync: 0, sleeps: [] as number[] }
  const order: string[] = []
  let active = 0
  let peak = 0
  const failures = { list: 0, sync: 0, syncIDs: new Set<string>() }
  let pause: Promise<void> | undefined

  const track = async <T>(fn: () => T): Promise<T> => {
    active++
    peak = Math.max(peak, active)
    try {
      await tick()
      if (pause) await pause
      return fn()
    } finally {
      active--
    }
  }

  const deps: HydrationDeps = {
    listChildren: (parentID, cursor) =>
      track(() => {
        calls.list++
        if (failures.list > 0) {
          failures.list--
          throw new Error("list failed")
        }
        const children = sessions.filter((session) => session.parentID === parentID).map((session) => session.id)
        const start = cursor ? Number(cursor) : 0
        const next = start + pageSize < children.length ? String(start + pageSize) : undefined
        return { ids: children.slice(start, start + pageSize), next }
      }),
    sync: (id) =>
      track(() => {
        calls.sync++
        if (failures.sync > 0 || failures.syncIDs.has(id)) {
          if (failures.sync > 0) failures.sync--
          else failures.syncIDs.delete(id)
          throw new Error("sync failed")
        }
        const session = server.get(id)
        if (!session) return
        cache.set(id, session)
        order.push(id)
      }),
    get: (id) => cache.get(id),
    sleep: (ms, signal) => {
      calls.sleeps.push(ms)
      return new Promise((resolve, reject) => {
        if (signal.aborted) return reject(new Error("aborted"))
        setTimeout(resolve, 0)
      })
    },
  }

  const familyCost = (root: string) => [...cache.values()].filter((session) => rootOf(session.id) === root).length
  const rootOf = (id: string): string | undefined => {
    let session = cache.get(id)
    const seen = new Set<string>()
    while (session?.parentID) {
      if (seen.has(session.id)) return undefined
      seen.add(session.id)
      session = cache.get(session.parentID)
    }
    return session?.id
  }

  return {
    deps,
    cache,
    calls,
    order,
    failures,
    familyCost,
    peak: () => peak,
    pauseAll() {
      let release!: () => void
      pause = new Promise((resolve) => (release = resolve))
      return () => {
        pause = undefined
        release()
      }
    },
  }
}

const fast: HydrationOptions = { baseDelayMs: 10, maxDelayMs: 40 }

function make(world: ReturnType<typeof createWorld>, options: HydrationOptions = {}): Hydrator {
  return createHydrator(world.deps, { ...fast, ...options })
}

// root -> 5 children (3 pages of 2), each with 3 grandchildren (2 pages),
// one great-grandchild chain 3 deep.
function deepTree(): Session[] {
  const sessions: Session[] = [{ id: "root" }]
  for (let c = 0; c < 5; c++) {
    sessions.push({ id: `c${c}`, parentID: "root" })
    for (let g = 0; g < 3; g++) sessions.push({ id: `c${c}g${g}`, parentID: `c${c}` })
  }
  sessions.push({ id: "d1", parentID: "c0g0" })
  sessions.push({ id: "d2", parentID: "d1" })
  sessions.push({ id: "d3", parentID: "d2" })
  return sessions
}

describe("hydrator", () => {
  test("releases a limiter slot when a dependency throws synchronously", async () => {
    const limit = createLimiter(1)
    const signal = new AbortController().signal
    await expect(limit(() => { throw new Error("sync throw") }, signal)).rejects.toThrow("sync throw")
    expect(await limit(() => Promise.resolve("next"), signal)).toBe("next")
  })

  test("retries and reports an error when cache sync throws synchronously", async () => {
    let calls = 0
    const hydrator = createHydrator({
      get: () => undefined,
      sync: () => {
        calls++
        throw new Error("sync throw")
      },
      listChildren: async () => ({ ids: [] }),
      sleep: async () => {},
    }, { concurrency: 1, maxAttempts: 2 })
    hydrator.acquire("root")
    await waitFor(() => hydrator.state("root").status === "error", "sync failure")
    expect(calls).toBe(2)
    hydrator.dispose()
  })

  test("hydrates a deep tree across paginated children", async () => {
    const sessions = deepTree()
    const world = createWorld(sessions, { preloaded: ["root"] })
    const hydrator = make(world)
    hydrator.acquire("root")
    await waitFor(() => hydrator.state("root").status === "ready", "ready")
    expect(world.cache.size).toBe(sessions.length)
    expect(world.familyCost("root")).toBe(sessions.length)
    expect(hydrator.state("root").root).toBe("root")
    hydrator.dispose()
  })

  test("syncs every parent before its children", async () => {
    const sessions = deepTree()
    const world = createWorld(sessions, { preloaded: ["root"] })
    const hydrator = make(world, { concurrency: 8 })
    hydrator.acquire("root")
    await waitFor(() => hydrator.state("root").status === "ready", "ready")
    const position = new Map(world.order.map((id, index) => [id, index]))
    for (const session of sessions) {
      if (!session.parentID || session.parentID === "root") continue
      expect(position.get(session.parentID)!).toBeLessThanOrEqual(position.get(session.id)! - 1)
    }
    hydrator.dispose()
  })

  test("respects the concurrency limit across listing and syncing", async () => {
    const world = createWorld(deepTree(), { preloaded: ["root"], pageSize: 1 })
    const hydrator = make(world, { concurrency: 3 })
    hydrator.acquire("root")
    await waitFor(() => hydrator.state("root").status === "ready", "ready")
    expect(world.peak()).toBeLessThanOrEqual(3)
    expect(world.peak()).toBeGreaterThan(1)
    hydrator.dispose()
  })

  test("recovers from a transient list failure", async () => {
    const sessions = deepTree()
    const world = createWorld(sessions, { preloaded: ["root"] })
    world.failures.list = 2
    const hydrator = make(world)
    const statuses: string[] = []
    hydrator.subscribe(() => statuses.push(hydrator.state("root").status))
    hydrator.acquire("root")
    await waitFor(() => hydrator.state("root").status === "ready", "ready")
    expect(world.cache.size).toBe(sessions.length)
    expect(statuses).not.toContain("error")
    expect(world.calls.sleeps.length).toBeGreaterThan(0)
    hydrator.dispose()
  })

  test("recovers from a transient sync failure and resumes progress", async () => {
    const sessions = deepTree()
    const world = createWorld(sessions, { preloaded: ["root"] })
    world.failures.syncIDs.add("c2g1")
    const hydrator = make(world)
    hydrator.acquire("root")
    await waitFor(() => hydrator.state("root").status === "ready", "ready")
    expect(world.cache.size).toBe(sessions.length)
    // Every session synced once, plus the single failed attempt; finished
    // syncs are not repeated on retry.
    expect(world.calls.sync).toBe(sessions.length)
    hydrator.dispose()
  })

  test("recovers from a transient ancestor-sync failure to the true root", async () => {
    const sessions = deepTree()
    // Viewing a deep subagent whose ancestors are not cached yet.
    const world = createWorld(sessions, { preloaded: ["d3"] })
    world.failures.syncIDs.add("c0")
    const hydrator = make(world)
    hydrator.acquire("d3")
    await waitFor(() => hydrator.state("d3").status !== "idle", "start")
    expect(hydrator.state("d3").root).toBeUndefined()
    await waitFor(() => hydrator.state("d3").status === "ready", "ready")
    expect(hydrator.state("d3").root).toBe("root")
    expect(world.familyCost("root")).toBe(sessions.length)
    hydrator.dispose()
  })

  test("gives up after a bounded number of attempts and can be re-armed", async () => {
    const world = createWorld(deepTree(), { preloaded: ["root"] })
    world.failures.list = 1_000
    const hydrator = make(world, { maxAttempts: 3 })
    hydrator.acquire("root")
    await waitFor(() => hydrator.state("root").status === "error", "error")
    const listCalls = world.calls.list
    expect(listCalls).toBe(3)
    expect(world.calls.sleeps).toEqual([10, 20])
    for (let i = 0; i < 20; i++) await tick()
    expect(world.calls.list).toBe(listCalls)

    world.failures.list = 0
    hydrator.retryFailed()
    await waitFor(() => hydrator.state("root").status === "ready", "ready after retry")
    hydrator.dispose()
  })

  test("caps backoff at maxDelayMs", async () => {
    const world = createWorld(deepTree(), { preloaded: ["root"] })
    world.failures.list = 1_000
    const hydrator = make(world, { maxAttempts: 6, baseDelayMs: 10, maxDelayMs: 40 })
    hydrator.acquire("root")
    await waitFor(() => hydrator.state("root").status === "error", "error")
    expect(world.calls.sleeps).toEqual([10, 20, 40, 40, 40])
    hydrator.dispose()
  })

  test("terminates on a parent cycle without retrying", async () => {
    const world = createWorld(
      [
        { id: "a", parentID: "b" },
        { id: "b", parentID: "a" },
      ],
      { preloaded: ["a", "b"] },
    )
    const hydrator = make(world)
    hydrator.acquire("a")
    await waitFor(() => hydrator.state("a").status === "error", "error")
    expect(world.calls.sleeps.length).toBe(0)
    hydrator.dispose()
  })

  test("dispose stops further work", async () => {
    const world = createWorld(deepTree(), { preloaded: ["root"] })
    const resume = world.pauseAll()
    const hydrator = make(world)
    hydrator.acquire("root")
    await tick()
    const before = world.calls.list + world.calls.sync
    hydrator.dispose()
    resume()
    for (let i = 0; i < 30; i++) await tick()
    // In-flight requests may finish, but nothing new is scheduled.
    expect(world.calls.list + world.calls.sync).toBeLessThanOrEqual(before + 1)
    expect(world.cache.size).toBe(1)
    expect(hydrator.state("root").status).toBe("idle")
  })

  test("releasing the last consumer cancels outstanding work", async () => {
    const world = createWorld(deepTree(), { preloaded: ["root"] })
    const resume = world.pauseAll()
    const hydrator = make(world)
    const release = hydrator.acquire("root")
    await tick()
    release()
    resume()
    for (let i = 0; i < 30; i++) await tick()
    expect(world.cache.size).toBe(1)
    expect(hydrator.state("root").status).toBe("idle")

    // A later consumer resumes and finishes.
    hydrator.acquire("root")
    await waitFor(() => hydrator.state("root").status === "ready", "ready")
    hydrator.dispose()
  })

  test("two consumers of the same root share one hydration", async () => {
    const sessions = deepTree()
    const world = createWorld(sessions, { preloaded: ["root", "c1"] })
    const hydrator = make(world)
    const releaseSidebar = hydrator.acquire("root")
    const releaseFooter = hydrator.acquire("root")
    // A different viewed session in the same family also joins.
    const releaseChild = hydrator.acquire("c1")
    await waitFor(() => hydrator.state("root").status === "ready" && hydrator.state("c1").status === "ready", "ready")
    expect(hydrator.state("c1").root).toBe("root")
    // Each listing happens exactly once: one page per 2 children.
    const parents = sessions.filter((session) => sessions.some((other) => other.parentID === session.id)).length
    const leaves = sessions.length - parents
    const pages = 3 + 5 * 2 + 3 // root, each child, the d-chain parents
    expect(world.calls.list).toBe(pages + leaves)
    // Every descendant synced once (c1 is refreshed by the walk too).
    expect(world.calls.sync).toBe(sessions.length - 1)
    releaseSidebar()
    releaseFooter()
    releaseChild()
    hydrator.dispose()
  })

  test("a fresh instance hydrates the same session again", async () => {
    const sessions = deepTree()
    const first = createWorld(sessions, { preloaded: ["root"] })
    const a = make(first)
    a.acquire("root")
    await waitFor(() => a.state("root").status === "ready", "first ready")
    a.dispose()

    // Simulates a plugin reload against a fresh client cache.
    const second = createWorld(sessions, { preloaded: ["root"] })
    const b = make(second)
    b.acquire("root")
    await waitFor(() => b.state("root").status === "ready", "second ready")
    expect(second.cache.size).toBe(sessions.length)
    b.dispose()
  })
})

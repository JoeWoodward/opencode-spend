// Hydration of a session family into the TUI's client cache.
//
// `context.data.session.cost(root)` sums the cost of every session the TUI's
// client cache has registered in the root's family. It does not ask the
// server for a total. Sessions created while the TUI is running are
// registered automatically (via `session.created`), and the host syncs the
// direct children of open tabs - but descendants that already existed when a
// session was reopened (grandchildren and beyond, or children past the first
// page) are never loaded, so their spend would be missing. Likewise, a viewed
// subagent needs its ancestors cached for the cache to resolve the true root.
//
// For a viewed session this module runs one recoverable operation:
//   1. resolve the true root by walking (and syncing) the `parentID` chain;
//   2. hydrate that root by listing every descendant (all pages) and syncing
//      it into the cache, parent before child. The cache attaches a session
//      to its root's family by following `parentID` through sessions it
//      already knows, so a parent must be synced before its children.
//
// Both steps retry with bounded exponential backoff, share one concurrency
// limit, resume from their previous progress, and stop when abandoned or
// disposed. Nothing here depends on Solid or the TUI: dependencies are
// injected, and status changes are published through `subscribe`.

export type HydrationStatus = "idle" | "loading" | "ready" | "error"

export type ChildPage = { ids: string[]; next?: string }

export interface HydrationDeps {
  /** One page of direct children of `parentID`. */
  listChildren(parentID: string, cursor: string | undefined, signal: AbortSignal): Promise<ChildPage>
  /** Load one session into the cache. */
  sync(sessionID: string, signal: AbortSignal): Promise<void>
  /** Read a session from the cache. */
  get(sessionID: string): { parentID?: string } | undefined
  /** Injectable for tests. Must reject when `signal` aborts. */
  sleep?(ms: number, signal: AbortSignal): Promise<void>
}

export interface HydrationOptions {
  /** Max concurrent list/sync requests across the whole instance. */
  concurrency?: number
  /** Attempts per round (first try included) before settling on "error". */
  maxAttempts?: number
  /** Delay before the first retry; doubles per attempt. */
  baseDelayMs?: number
  /** Upper bound for a single retry delay. */
  maxDelayMs?: number
  /** Longest `parentID` chain followed before treating it as malformed. */
  maxDepth?: number
}

export const DEFAULTS: Required<HydrationOptions> = {
  concurrency: 4,
  maxAttempts: 5,
  baseDelayMs: 1_000,
  maxDelayMs: 15_000,
  maxDepth: 256,
}

export type ViewState = {
  status: HydrationStatus
  /** The resolved root, once ancestry is known. */
  root?: string
}

export interface Hydrator {
  /**
   * Start (or join) hydration for a viewed session. Returns a release
   * function; when the last consumer releases, outstanding work for that
   * session is cancelled (completed progress is kept).
   */
  acquire(sessionID: string): () => void
  /** Current state of a viewed session. */
  state(sessionID: string): ViewState
  /** Re-arm every acquired session that settled on "error". */
  retryFailed(): void
  /** Called after any state change. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void
  /** Cancel all work and drop all bookkeeping. */
  dispose(): void
}

/** An error that retrying cannot fix (e.g. a parent cycle). */
export class PermanentError extends Error {}

function abortError(): Error {
  const error = new Error("Aborted")
  error.name = "AbortError"
  return error
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError())
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

/** A FIFO semaphore whose waiters can be cancelled. */
export function createLimiter(concurrency: number) {
  let active = 0
  const queue: Array<{ start: () => void; signal: AbortSignal; cancel: () => void }> = []

  const next = () => {
    while (active < concurrency && queue.length > 0) {
      const waiter = queue.shift()!
      if (waiter.signal.aborted) continue
      waiter.start()
    }
  }

  return function run<T>(fn: () => Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal.aborted) return reject(abortError())
      const start = () => {
        signal.removeEventListener("abort", waiter.cancel)
        active++
        Promise.resolve().then(fn).then(resolve, reject).finally(() => {
          active--
          next()
        })
      }
      const waiter = {
        start,
        signal,
        cancel: () => {
          const index = queue.indexOf(waiter)
          if (index >= 0) queue.splice(index, 1)
          reject(abortError())
        },
      }
      signal.addEventListener("abort", waiter.cancel, { once: true })
      queue.push(waiter)
      next()
    })
  }
}

type Limit = ReturnType<typeof createLimiter>

// A unit of retryable, cancellable, ref-counted work.
class Task {
  status: HydrationStatus = "idle"
  refs = 0
  private controller?: AbortController

  constructor(
    private readonly attempt: (signal: AbortSignal) => Promise<void>,
    private readonly options: Required<HydrationOptions>,
    private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>,
    private readonly changed: () => void,
    private readonly parent: AbortSignal,
  ) {}

  private set(status: HydrationStatus) {
    if (this.status === status) return
    this.status = status
    this.changed()
  }

  /** Start a round unless already running or done. */
  start() {
    if (this.status === "loading" || this.status === "ready" || this.parent.aborted) return
    const controller = new AbortController()
    this.controller = controller
    const onParentAbort = () => controller.abort()
    this.parent.addEventListener("abort", onParentAbort, { once: true })
    this.set("loading")
    void this.round(controller.signal).finally(() => {
      this.parent.removeEventListener("abort", onParentAbort)
      if (this.controller === controller) this.controller = undefined
    })
  }

  /** Cancel the running round, keeping progress. */
  stop() {
    this.controller?.abort()
    this.controller = undefined
    if (this.status === "loading") this.set("idle")
  }

  private async round(signal: AbortSignal) {
    const { maxAttempts, baseDelayMs, maxDelayMs } = this.options
    for (let attempt = 1; ; attempt++) {
      try {
        await this.attempt(signal)
        if (!signal.aborted) this.set("ready")
        return
      } catch (error) {
        if (signal.aborted) return
        if (error instanceof PermanentError || attempt >= maxAttempts) {
          this.set("error")
          return
        }
      }
      try {
        await this.sleep(Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1)), signal)
      } catch {
        return
      }
    }
  }
}

// Progress for one root, kept across attempts so retries resume.
type Walk = {
  synced: Set<string>
  children: Map<string, string[]>
  cursors: Map<string, string | undefined>
  listed: Set<string>
}

export function createHydrator(deps: HydrationDeps, options: HydrationOptions = {}): Hydrator {
  const config = { ...DEFAULTS, ...options }
  const sleep = deps.sleep ?? defaultSleep
  const limit: Limit = createLimiter(config.concurrency)
  const lifetime = new AbortController()
  const listeners = new Set<() => void>()
  const changed = () => listeners.forEach((listener) => listener())

  const roots = new Map<string, { task: Task; walk: Walk }>()
  const views = new Map<string, { task: Task; root?: string; rootRef?: () => void }>()

  function rootEntry(rootID: string) {
    let entry = roots.get(rootID)
    if (!entry) {
      const walk: Walk = { synced: new Set(), children: new Map(), cursors: new Map(), listed: new Set() }
      const task = new Task((signal) => hydrateRoot(rootID, walk, signal), config, sleep, changed, lifetime.signal)
      entry = { task, walk }
      roots.set(rootID, entry)
    }
    return entry
  }

  function acquireRoot(rootID: string): () => void {
    const entry = rootEntry(rootID)
    entry.task.refs++
    entry.task.start()
    let released = false
    return () => {
      if (released) return
      released = true
      if (--entry.task.refs === 0) entry.task.stop()
    }
  }

  async function syncOnce(id: string, signal: AbortSignal) {
    await limit(() => deps.sync(id, signal), signal)
  }

  // Walk up from `sessionID`, syncing missing ancestors, and return the root.
  async function resolveRoot(sessionID: string, signal: AbortSignal): Promise<string> {
    const seen = new Set<string>()
    let id = sessionID
    for (;;) {
      if (signal.aborted) throw abortError()
      if (seen.has(id)) throw new PermanentError(`parent cycle at ${id}`)
      if (seen.size >= config.maxDepth) throw new PermanentError("parent chain too deep")
      seen.add(id)
      if (!deps.get(id)) await syncOnce(id, signal)
      const session = deps.get(id)
      if (!session) throw new Error(`session ${id} not found`)
      if (!session.parentID) return id
      id = session.parentID
    }
  }

  async function hydrateRoot(rootID: string, walk: Walk, signal: AbortSignal): Promise<void> {
    // Each attempt revisits the tree but skips finished syncs and listings.
    const visited = new Set([rootID])
    let pending = 0
    let failure: unknown
    let finish!: () => void
    const done = new Promise<void>((resolve) => (finish = resolve))
    const attempt = new AbortController()
    const stop = () => attempt.abort()
    signal.addEventListener("abort", stop, { once: true })

    const spawn = (work: () => Promise<void>) => {
      pending++
      work()
        .catch((error) => {
          if (failure === undefined) failure = error
          attempt.abort()
        })
        .finally(() => {
          if (--pending === 0) finish()
        })
    }

    const child = async (id: string) => {
      if (visited.has(id)) return
      visited.add(id)
      if (!walk.synced.has(id)) {
        await syncOnce(id, attempt.signal)
        walk.synced.add(id)
      }
      spawn(() => list(id))
    }

    const list = async (parentID: string) => {
      const known = walk.children.get(parentID) ?? []
      walk.children.set(parentID, known)
      for (const id of known) spawn(() => child(id))
      if (walk.listed.has(parentID)) return
      let cursor = walk.cursors.get(parentID)
      do {
        const page = await limit(() => deps.listChildren(parentID, cursor, attempt.signal), attempt.signal)
        if (attempt.signal.aborted) throw abortError()
        for (const id of page.ids) {
          known.push(id)
          spawn(() => child(id))
        }
        cursor = page.next
        walk.cursors.set(parentID, cursor)
      } while (cursor)
      walk.listed.add(parentID)
    }

    try {
      if (!deps.get(rootID) && !walk.synced.has(rootID)) await syncOnce(rootID, attempt.signal)
      walk.synced.add(rootID)
      spawn(() => list(rootID))
      await done
    } finally {
      signal.removeEventListener("abort", stop)
    }
    if (signal.aborted) throw abortError()
    if (failure !== undefined) throw failure
  }

  type View = { task: Task; root?: string; rootRef?: () => void }

  function viewEntry(sessionID: string): View {
    const existing = views.get(sessionID)
    if (existing) return existing
    const resolve = async (signal: AbortSignal) => {
      const root = await resolveRoot(sessionID, signal)
      if (signal.aborted) throw abortError()
      view.root = root
      // Ancestry is known: the view now follows the shared root task.
      if (!view.rootRef) view.rootRef = acquireRoot(root)
    }
    const view: View = { task: new Task(resolve, config, sleep, changed, lifetime.signal) }
    views.set(sessionID, view)
    return view
  }

  function state(sessionID: string): ViewState {
    const view = views.get(sessionID)
    if (!view) return { status: "idle" }
    if (view.task.status !== "ready") return { status: view.task.status, root: view.root }
    const root = view.root ? roots.get(view.root) : undefined
    return { status: root?.task.status ?? "idle", root: view.root }
  }

  return {
    acquire(sessionID) {
      if (lifetime.signal.aborted) return () => {}
      const view = viewEntry(sessionID)
      view.task.refs++
      if (view.task.refs === 1 && view.root && !view.rootRef) view.rootRef = acquireRoot(view.root)
      // A fresh consumer re-arms a previously failed round.
      view.task.start()
      if (view.rootRef && view.root) {
        const root = roots.get(view.root)!
        root.task.start()
      }
      let released = false
      return () => {
        if (released) return
        released = true
        if (--view.task.refs > 0) return
        view.task.stop()
        view.rootRef?.()
        view.rootRef = undefined
      }
    },
    state,
    retryFailed() {
      for (const view of views.values()) {
        if (view.task.refs === 0) continue
        view.task.start()
        const root = view.root ? roots.get(view.root) : undefined
        if (root && root.task.refs > 0) root.task.start()
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose() {
      lifetime.abort()
      views.clear()
      roots.clear()
      listeners.clear()
    },
  }
}

// Per-agent and per-model spend for a root session.
//
// Subagent sessions carry their own `agent`, `cost` and `tokens`, so they
// need no message loading. The root session is different: one session can
// switch between primary agents (plan, build, ...) and models, and only its
// assistant messages say who spent what.
//
// Reading every message on every update would stutter in long sessions, so
// the ledger is incremental:
//   - The first visit pages through the root's assistant messages once
//     (newest first) and sums cost by agent and by model.
//   - Every message except the newest is settled: added to the saved totals
//     and never re-read. `head` is the newest settled message.
//   - The newest message stays provisional: it is shown, but re-read on
//     every catch-up, because its cost can still change. A running step has
//     no cost until it ends (which can take as long as a subagent runs), and
//     a failed step can be restarted under the same message ID. Older
//     messages are final: starting a step completes the previous one.
//   - Every catch-up reads newest-first only until it reaches `head`: one
//     small page in a live session.
//   - Settled entries are persisted, so reopening a session after a restart
//     only reads the messages added since.
//   - If `head` has disappeared (a revert removed it) or the settled cost
//     exceeds what the server reports for the session, the entry is rebuilt
//     from scratch once.
//
// Nothing here depends on Solid or the TUI: dependencies are injected.

export type ModelRef = { id: string; providerID: string }

export type TokenUsage = {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

export type AssistantMessage = {
  id: string
  agent?: string
  model?: ModelRef
  cost?: number
  tokens?: TokenUsage
  finish?: string
  error?: unknown
  time?: { created?: number; completed?: number }
}

export type MessagePage = { data: AssistantMessage[]; next?: string }

// Bump when saved entries may be wrong under new counting rules: entries
// with another version are ignored and the session is read again once.
// 2: the newest message is no longer settled (it could gain cost later).
export const LEDGER_VERSION = 2

export type LedgerEntry = {
  v: typeof LEDGER_VERSION
  /** Newest settled message. */
  head?: string
  count: number
  cost: number
  byAgent: Record<string, number>
  byModel: Record<string, number>
  /** Last time the session was viewed, for pruning. */
  viewed: number
}

export interface LedgerDeps {
  /** One page of a session's assistant messages, newest first. */
  fetch(sessionID: string, cursor: string | undefined, limit: number, signal: AbortSignal): Promise<MessagePage>
  /** The server's own cost for the session (excluding descendants), when known. */
  ownCost(sessionID: string): number | undefined
  /** Persisted entry, if any. */
  load(sessionID: string): LedgerEntry | undefined
  /** Persist an entry (callers may debounce). */
  save(sessionID: string, entry: LedgerEntry): void
  now?(): number
  /** Injectable for tests. Must reject when `signal` aborts. */
  sleep?(ms: number, signal: AbortSignal): Promise<void>
}

export interface LedgerOptions {
  /** Page size for a full read, and for every page after the first. */
  fullPage?: number
  /**
   * First page of an incremental catch-up. Messages carry their full
   * content (tool output included, often tens of kB), and a live catch-up
   * usually needs only the provisional message and `head`.
   */
  catchUpPage?: number
  maxAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
}

const DEFAULTS: Required<LedgerOptions> = {
  fullPage: 200,
  catchUpPage: 4,
  maxAttempts: 4,
  baseDelayMs: 1_000,
  maxDelayMs: 10_000,
}

export interface Ledger {
  /** Start tracking a root session. Returns a release function. */
  acquire(sessionID: string): () => void
  /**
   * Current totals (settled plus the provisional newest message), once the
   * first read finished or a saved entry was loaded.
   */
  entry(sessionID: string): LedgerEntry | undefined
  /** Read new messages. Coalesces while a read is in flight. */
  refresh(sessionID: string): void
  /** Refresh every acquired session, e.g. after reconnecting. */
  refreshAll(): void
  /** Called after any change. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void
  dispose(): void
}

export function emptyEntry(now: number): LedgerEntry {
  return { v: LEDGER_VERSION, count: 0, cost: 0, byAgent: {}, byModel: {}, viewed: now }
}

const isAmount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)

function isAmounts(value: unknown): value is Record<string, number> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.values(value).every(isAmount)
}

/** A saved entry that is safe to show and build on; anything else is read again. */
export function isEntry(value: unknown): value is LedgerEntry {
  const entry = value as LedgerEntry | undefined
  return (
    !!entry &&
    typeof entry === "object" &&
    entry.v === LEDGER_VERSION &&
    isAmount(entry.cost) &&
    isAmount(entry.count) &&
    (entry.head === undefined || typeof entry.head === "string") &&
    isAmounts(entry.byAgent) &&
    isAmounts(entry.byModel)
  )
}

export function modelKey(model: ModelRef | undefined): string {
  return model ? `${model.providerID}/${model.id}` : "unknown"
}

/** A finished step: its cost and tokens are final unless it is restarted. */
export function isComplete(message: AssistantMessage): boolean {
  return (
    message.time?.completed !== undefined ||
    message.finish !== undefined ||
    message.error !== undefined
  )
}

/** Add messages (any order) to a copy of `entry`. */
export function applyMessages(entry: LedgerEntry, messages: AssistantMessage[]): LedgerEntry {
  const next: LedgerEntry = { ...entry, byAgent: { ...entry.byAgent }, byModel: { ...entry.byModel } }
  for (const message of messages) {
    const cost = message.cost ?? 0
    next.count++
    next.cost += cost
    const agent = message.agent ?? "unknown"
    next.byAgent[agent] = (next.byAgent[agent] ?? 0) + cost
    const model = modelKey(message.model)
    next.byModel[model] = (next.byModel[model] ?? 0) + cost
  }
  return next
}

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

// Allow for float noise when comparing summed costs.
const EPSILON = 1e-6

type Tracked = {
  refs: number
  /** Settled totals; what is persisted. */
  entry?: LedgerEntry
  /** The provisional newest message, re-read on every catch-up. */
  tail?: AssistantMessage
  /** `entry` plus `tail`, as shown. */
  view?: LedgerEntry
  running?: AbortController
  /** Another refresh was requested while one was running. */
  again: boolean
}

export function createLedger(deps: LedgerDeps, options: LedgerOptions = {}): Ledger {
  const config = { ...DEFAULTS, ...options }
  const sleep = deps.sleep ?? defaultSleep
  const now = deps.now ?? Date.now
  const lifetime = new AbortController()
  const tracked = new Map<string, Tracked>()
  const listeners = new Set<() => void>()
  const changed = () => listeners.forEach((listener) => listener())

  // Read newest-first until `head` (or the end). Returns the new messages
  // and whether `head` was found.
  async function readSince(sessionID: string, head: string | undefined, signal: AbortSignal) {
    const fresh: AssistantMessage[] = []
    let cursor: string | undefined
    for (;;) {
      const limit = head && !cursor ? config.catchUpPage : config.fullPage
      const page = await deps.fetch(sessionID, cursor, limit, signal)
      if (signal.aborted) throw abortError()
      for (const message of page.data) {
        if (head && message.id === head) return { fresh, found: true }
        fresh.push(message)
      }
      // A page may be empty after filtering; only a missing cursor ends the list.
      if (!page.next) return { fresh, found: head === undefined }
      cursor = page.next
    }
  }

  // Settle everything but the newest message, which stays provisional.
  function settle(base: LedgerEntry, newestFirst: AssistantMessage[]): { entry: LedgerEntry; tail?: AssistantMessage } {
    const [tail, ...settled] = newestFirst
    if (settled.length === 0) return { entry: base, tail }
    return { entry: { ...applyMessages(base, settled), head: settled[0].id }, tail }
  }

  function show(item: Tracked) {
    item.view = item.entry && item.tail ? { ...applyMessages(item.entry, [item.tail]), head: item.entry.head } : item.entry
  }

  async function catchUp(sessionID: string, item: Tracked, signal: AbortSignal) {
    const current = item.entry
    const { fresh, found } = await readSince(sessionID, current?.head, signal)
    let next: ReturnType<typeof settle>
    if (current?.head && !found) {
      // `head` was removed: `fresh` is the whole history, so rebuild.
      next = settle(emptyEntry(now()), fresh)
    } else {
      next = settle(current ?? emptyEntry(now()), fresh)
      // Settled messages never change, so their sum cannot exceed the
      // server's cost unless the saved entry is stale (the provisional
      // message is left out: the server may not have added it yet).
      const own = deps.ownCost(sessionID)
      if (current && own !== undefined && next.entry.cost > own + EPSILON) {
        next = settle(emptyEntry(now()), (await readSince(sessionID, undefined, signal)).fresh)
      }
    }
    next.entry.viewed = now()
    item.entry = next.entry
    item.tail = next.tail
    show(item)
    deps.save(sessionID, next.entry)
    changed()
  }

  async function run(sessionID: string, item: Tracked) {
    const controller = new AbortController()
    item.running = controller
    const onAbort = () => controller.abort()
    lifetime.signal.addEventListener("abort", onAbort, { once: true })
    try {
      do {
        item.again = false
        for (let attempt = 1; ; attempt++) {
          try {
            await catchUp(sessionID, item, controller.signal)
            break
          } catch (error) {
            if (controller.signal.aborted) return
            if (attempt >= config.maxAttempts) break
            try {
              await sleep(Math.min(config.maxDelayMs, config.baseDelayMs * 2 ** (attempt - 1)), controller.signal)
            } catch {
              return
            }
          }
        }
      } while (item.again && !controller.signal.aborted)
    } finally {
      lifetime.signal.removeEventListener("abort", onAbort)
      if (item.running === controller) item.running = undefined
    }
  }

  function refresh(sessionID: string) {
    const item = tracked.get(sessionID)
    if (!item || item.refs === 0 || lifetime.signal.aborted) return
    if (item.running) {
      item.again = true
      return
    }
    void run(sessionID, item)
  }

  return {
    acquire(sessionID) {
      if (lifetime.signal.aborted) return () => {}
      let item = tracked.get(sessionID)
      if (!item) {
        const saved = deps.load(sessionID)
        item = { refs: 0, again: false, entry: isEntry(saved) ? saved : undefined }
        show(item)
        tracked.set(sessionID, item)
        if (item.entry) changed()
      }
      item.refs++
      if (item.refs === 1) refresh(sessionID)
      let released = false
      const owned = item
      return () => {
        if (released) return
        released = true
        if (--owned.refs > 0) return
        owned.running?.abort()
        owned.running = undefined
      }
    },
    entry: (sessionID) => tracked.get(sessionID)?.view,
    refresh,
    refreshAll() {
      for (const sessionID of tracked.keys()) refresh(sessionID)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose() {
      lifetime.abort()
      tracked.clear()
      listeners.clear()
    },
  }
}

/** Keep the `max` most recently viewed entries. */
export function prune<Entry extends { viewed?: number }>(
  entries: Record<string, Entry>,
  max: number,
): Record<string, Entry> {
  const ids = Object.keys(entries)
  if (ids.length <= max) return entries
  const keep = ids.sort((a, b) => (entries[b].viewed ?? 0) - (entries[a].viewed ?? 0)).slice(0, Math.max(0, max))
  return Object.fromEntries(keep.map((id) => [id, entries[id]]))
}

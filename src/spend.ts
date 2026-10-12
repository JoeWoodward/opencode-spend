// Framework-independent wiring: options, the hydrator, the ledger and the
// usage tracker, connected to the plugin context. Kept out of `tui.tsx` so it
// can be tested without a Solid/OpenTUI renderer.
import type { Context } from "@opencode/plugin/tui/context"
import {
  createHydrator,
  type HydrationDeps,
  type HydrationOptions,
  type Hydrator,
  type ViewState,
} from "./hydration.ts"
import {
  createLedger,
  isEntry,
  prune,
  type AssistantMessage,
  type Ledger,
  type LedgerEntry,
  type LedgerOptions,
  type MessagePage,
} from "./ledger.ts"
import { createUsageTracker, type UsageTracker } from "./usage.ts"
import { resolveLive, resolveViews, type LiveOptions, type ViewName } from "./views.ts"

export type PluginConfig = {
  views: ViewName[]
  live: LiveOptions
  /** Draw a threshold line on the context bar at this ratio (0..1). */
  compactionMarker?: number
  barWidth: number
  /** Sessions whose ledger totals and open sections are kept in storage. */
  maxSavedSessions: number
}

export const CONFIG_DEFAULTS = { barWidth: 24, maxSavedSessions: 200 }

function positiveInteger(value: unknown, fallback: number, min = 1, max = 1_000_000): number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : fallback
}

export function resolveConfig(options: Context["options"]): PluginConfig {
  const marker = options.compactionMarker
  return {
    views: resolveViews(options.views),
    live: resolveLive(options.live),
    compactionMarker: typeof marker === "number" && marker > 0 && marker < 1 ? marker : undefined,
    barWidth: positiveInteger(options.barWidth, CONFIG_DEFAULTS.barWidth, 8, 80),
    maxSavedSessions: positiveInteger(options.maxSavedSessions, CONFIG_DEFAULTS.maxSavedSessions, 0),
  }
}

/** Tuning for the hydrator, ledger and persistence. Injectable for tests. */
export type SpendOptions = HydrationOptions &
  Pick<HydrationDeps, "sleep"> & {
    ledger?: LedgerOptions
    /** Delay before ledger changes are written to storage. */
    persistDelayMs?: number
  }

const HYDRATION_KEYS = ["concurrency", "maxAttempts", "baseDelayMs", "maxDelayMs", "maxDepth"] as const

// Only the keys that are set: the hydrator spreads options over its
// defaults, so an explicit `undefined` would erase a default.
function hydrationOptions(options: SpendOptions): HydrationOptions {
  const picked: HydrationOptions = {}
  for (const key of HYDRATION_KEYS) if (options[key] !== undefined) picked[key] = options[key]
  return picked
}

// One hydrator per plugin instance, so its bookkeeping lives and dies with
// the client cache it fills. `onChange` is called after every hydration
// state change.
export function createSpendHydrator(
  context: Pick<Context, "client" | "data">,
  onChange: () => void,
  options: SpendOptions = {},
): { hydrator: Hydrator; dispose: () => void } {
  const hydrator = createHydrator(
    {
      async listChildren(parentID, cursor, signal) {
        const response = await context.client.session.list({ parentID, cursor }, { signal })
        return { ids: response.data.map((session) => session.id), next: response.cursor.next ?? undefined }
      },
      // The cache's sync does not accept a signal; the hydrator stops
      // scheduling further syncs once cancelled instead.
      sync: (sessionID) => context.data.session.sync(sessionID),
      get: (sessionID) => context.data.session.get(sessionID),
      sleep: options.sleep,
    },
    hydrationOptions(options),
  )
  const unsubscribe = hydrator.subscribe(onChange)
  // Reconnecting is the natural moment to retry rounds that gave up offline.
  const offConnected = context.data.on("server.connected", () => hydrator.retryFailed())

  return {
    hydrator,
    dispose() {
      offConnected()
      unsubscribe()
      hydrator.dispose()
    },
  }
}

export type FamilySpend = { root: string; total: number; orchestrator: number; subagents: number }

// The family total for a viewed session, read from the client cache. Until
// ancestry is resolved, falls back to the cache's view of the root.
export function familySpend(
  session: Pick<Context["data"]["session"], "root" | "cost" | "get">,
  sessionID: string,
  state: ViewState,
): FamilySpend {
  const root = state.root ?? session.root(sessionID)
  const total = session.cost(root)
  const orchestrator = session.get(root)?.cost ?? 0
  return { root, total, orchestrator, subagents: Math.max(0, total - orchestrator) }
}

/** Newest-first assistant messages of one session. */
function messageFetcher(context: Pick<Context, "client">) {
  return async (sessionID: string, cursor: string | undefined, limit: number, signal: AbortSignal): Promise<MessagePage> => {
    // A cursor encodes the order, and the server rejects `order` alongside
    // it ("Cursor cannot be combined with order"). It does not encode the
    // type filter: without `type`, later pages return every message type.
    const response = await context.client.message.list(
      cursor ? { sessionID, cursor, type: "assistant", limit } : { sessionID, type: "assistant", order: "desc", limit },
      { signal },
    )
    return {
      data: response.data.filter((message) => message.type === "assistant") as unknown as AssistantMessage[],
      next: response.cursor.next ?? undefined,
    }
  }
}

type LedgerStore = { sessions: Record<string, LedgerEntry> }

const LEDGER_STORE_KEY = "ledger"

// The ledger persisted in plugin storage. Writes are debounced, so a busy
// session does not rewrite the store on every step.
export function createStoredLedger(
  context: Pick<Context, "client" | "data" | "storage">,
  onChange: () => void,
  config: Pick<PluginConfig, "maxSavedSessions">,
  options: SpendOptions = {},
): { ledger: Ledger; usage: UsageTracker; dispose: () => void } {
  const [store, update] = context.storage.store<LedgerStore>(LEDGER_STORE_KEY, { initial: { sessions: {} } })
  const pending = new Map<string, LedgerEntry | undefined>()
  let timer: ReturnType<typeof setTimeout> | undefined
  const delay = options.persistDelayMs ?? 2_000

  const flush = () => {
    timer = undefined
    if (pending.size === 0) return
    const writes = [...pending]
    pending.clear()
    update((draft) => {
      for (const [id, entry] of writes) {
        if (entry) draft.sessions[id] = entry
        else delete draft.sessions[id]
      }
      const kept = prune({ ...draft.sessions }, config.maxSavedSessions)
      for (const id of Object.keys(draft.sessions)) if (!(id in kept)) delete draft.sessions[id]
    }).catch((error) => console.error("opencode-spend: failed to persist ledger", error))
  }
  const schedule = (id: string, entry: LedgerEntry | undefined) => {
    pending.set(id, entry)
    if (delay <= 0) return flush()
    timer ??= setTimeout(flush, delay)
  }

  const fetch = messageFetcher(context)
  const ledger = createLedger(
    {
      fetch,
      ownCost: (sessionID) => context.data.session.get(sessionID)?.cost,
      load(sessionID) {
        const saved = store.sessions?.[sessionID]
        // Copy out of the reactive store.
        return isEntry(saved) ? (JSON.parse(JSON.stringify(saved)) as LedgerEntry) : undefined
      },
      save: (sessionID, entry) => schedule(sessionID, entry),
      sleep: options.sleep,
    },
    options.ledger,
  )
  const usage = createUsageTracker({ fetch })

  const offLedger = ledger.subscribe(onChange)
  const offUsage = usage.subscribe(onChange)
  const offs = [
    context.data.on("session.step.ended", (event) => {
      const { sessionID, assistantMessageID, tokens } = event.data
      usage.record(sessionID, tokens, assistantMessageID, context.data.session.get(sessionID)?.model)
      ledger.refresh(sessionID)
    }),
    // A failed step can still have cost and tokens.
    context.data.on("session.step.failed", (event) => {
      const { sessionID, assistantMessageID, tokens } = event.data
      if (tokens) usage.record(sessionID, tokens, assistantMessageID, context.data.session.get(sessionID)?.model)
      ledger.refresh(sessionID)
    }),
    context.data.on("session.step.started", (event) => {
      usage.started(event.data.sessionID, event.data.model, event.data.assistantMessageID)
    }),
    // Reads that gave up while offline would otherwise wait for the next step,
    // which an older session may never have.
    context.data.on("server.connected", () => ledger.refreshAll()),
    context.data.on("session.revert.committed", (event) => {
      usage.forget(event.data.sessionID)
      usage.ensure(event.data.sessionID)
      ledger.refresh(event.data.sessionID)
    }),
    context.data.on("session.deleted", (event) => {
      usage.forget(event.data.sessionID)
      schedule(event.data.sessionID, undefined)
    }),
  ]

  return {
    ledger,
    usage,
    dispose() {
      offs.forEach((off) => off())
      offLedger()
      offUsage()
      ledger.dispose()
      usage.dispose()
      if (timer) clearTimeout(timer)
      flush()
    },
  }
}

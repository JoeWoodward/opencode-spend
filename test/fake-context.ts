// A fake plugin `Context` for tests: a paginated server plus a client cache
// that, like the real one, attaches a session to its root's family by
// following `parentID` through sessions it already knows. It also fakes
// assistant-message paging (with the real server's cursor rules), plugin
// storage, keymap layers and events. Only the members the plugin uses are
// implemented.
import type { Context } from "@opencode/plugin/tui/context"
import { createStore, produce, unwrap } from "solid-js/store"
import type { AssistantMessage, ModelRef, TokenUsage } from "../src/ledger"

export type Row = {
  id: string
  parentID?: string
  cost: number
  agent?: string
  title?: string
  model?: ModelRef
  tokens?: TokenUsage
}

export const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

export async function waitFor(check: () => boolean, label = "condition") {
  for (let i = 0; i < 2_000; i++) {
    if (check()) return
    await tick()
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** Resolves on the next tick; rejects when aborted. */
export function fastSleep(_ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"))
    setTimeout(resolve, 0)
  })
}

type Claim = { append?: string; prepend?: string; render: (input: any) => unknown }

export function createFakeContext(
  rows: Row[],
  config: {
    pageSize?: number
    preloaded?: string[]
    options?: Record<string, unknown>
    /** Assistant messages per session, oldest first. */
    messages?: Record<string, AssistantMessage[]>
    /** Shared across worlds to simulate durable storage across restarts. */
    storage?: Map<string, unknown>
  } = {},
) {
  const server = new Map(rows.map((row) => [row.id, { ...row }]))
  const cache = new Map<string, Row>()
  for (const id of config.preloaded ?? []) cache.set(id, { ...server.get(id)! })
  const pageSize = config.pageSize ?? 2
  const calls = {
    list: 0,
    sync: 0,
    cursors: [] as Array<string | undefined>,
    signals: [] as AbortSignal[],
    messages: [] as Array<{ sessionID: string; cursor?: string; limit: number; type?: string }>,
  }
  const messages = new Map(Object.entries(config.messages ?? {}).map(([id, list]) => [id, [...list]]))
  const storage = config.storage ?? new Map<string, unknown>()
  const layers: unknown[] = []
  const failures = { list: 0 }
  const handlers = new Map<string, Set<(event: unknown) => void>>()
  const claims: Claim[] = []
  const statuses = new Map<string, "running" | "idle">()
  let offs = 0
  let active = 0
  let peak = 0
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

  const rootOf = (id: string): string => {
    let current = id
    const seen = new Set<string>()
    for (;;) {
      const parent = cache.get(current)?.parentID
      if (!parent || !cache.has(parent) || seen.has(current)) return current
      seen.add(current)
      current = parent
    }
  }

  const session = {
    get: (id: string) => cache.get(id),
    family: (id: string) => {
      const root = rootOf(id)
      return [...cache.keys()].filter((key) => rootOf(key) === root)
    },
    status: (id: string) => statuses.get(id) ?? "idle",
    root: rootOf,
    cost(id: string) {
      const root = rootOf(id)
      let total = 0
      for (const row of cache.values()) if (rootOf(row.id) === root) total += row.cost
      return total
    },
    sync: (id: string) =>
      track(() => {
        calls.sync++
        const row = server.get(id)
        if (row) cache.set(id, { ...row })
      }),
  }

  const context = {
    options: config.options ?? {},
    client: {
      session: {
        list: (input: { parentID: string; cursor?: string }, init: { signal: AbortSignal }) =>
          track(() => {
            calls.list++
            calls.cursors.push(input.cursor)
            calls.signals.push(init.signal)
            if (failures.list > 0) {
              failures.list--
              throw new Error("list failed")
            }
            const children = rows.filter((row) => row.parentID === input.parentID)
            const start = input.cursor ? Number(input.cursor) : 0
            const next = start + pageSize < children.length ? String(start + pageSize) : null
            return {
              data: children.slice(start, start + pageSize).map((row) => ({ id: row.id })),
              cursor: { next },
            }
          }),
      },
      message: {
        // Newest first; the cursor is the index of the next message.
        list: (input: { sessionID: string; order?: string; type?: string; limit: number; cursor?: string }) =>
          track(() => {
            // Like the real server: a cursor encodes the order but not the
            // type filter, which must be passed again on every page.
            if (input.cursor && input.order) {
              throw new Error("InvalidCursorError: Cursor cannot be combined with order")
            }
            calls.messages.push({ sessionID: input.sessionID, cursor: input.cursor, limit: input.limit, type: input.type })
            const list = [...(messages.get(input.sessionID) ?? [])].reverse()
            const start = input.cursor ? Number(input.cursor) : 0
            const end = start + input.limit
            return {
              data: list.slice(start, end).map((message) => ({ type: "assistant", ...message })),
              cursor: { next: end < list.length ? String(end) : null },
            }
          }),
      },
    },
    storage: {
      // A Solid store, like the real one, so render tests see updates.
      // Durable `storage` keeps a plain copy across worlds.
      store<Value extends object>(key: string, options: { initial: Value }) {
        if (!storage.has(key)) storage.set(key, structuredClone(options.initial))
        const [value, setValue] = createStore(storage.get(key) as Value)
        return [
          value,
          async (mutation: (draft: Value) => void) => {
            setValue(produce(mutation))
            storage.set(key, unwrap(value))
          },
        ] as const
      },
    },
    keymap: {
      layer(factory: () => unknown) {
        layers.push(factory())
      },
    },
    data: {
      location: { model: { list: () => [], sync: async () => {} } },
      session,
      on(type: string, handler: (event: unknown) => void) {
        let set = handlers.get(type)
        if (!set) handlers.set(type, (set = new Set()))
        set.add(handler)
        return () => {
          offs++
          set.delete(handler)
        }
      },
    },
    ui: {
      model: { current: () => undefined },
      slot(claim: Claim) {
        claims.push(claim)
        return () => {}
      },
    },
    theme: { text: { base: "white", muted: "gray" } },
  }

  return {
    context: context as unknown as Context,
    session: session as unknown as Context["data"]["session"],
    cache,
    calls,
    failures,
    claims,
    peak: () => peak,
    offs: () => offs,
    listeners: (type: string) => handlers.get(type)?.size ?? 0,
    emit(type: string, data?: unknown) {
      for (const handler of handlers.get(type) ?? []) handler({ type, data })
    },
    storage,
    layers,
    /** Append an assistant message (newest) to a session. */
    addMessage(sessionID: string, message: AssistantMessage) {
      const list = messages.get(sessionID) ?? []
      list.push(message)
      messages.set(sessionID, list)
    },
    /** Remove the newest `count` messages, as a revert would. */
    dropMessages(sessionID: string, count: number) {
      messages.get(sessionID)?.splice(-count, count)
    },
    /** A session arriving through `session.created` after hydration. */
    create(row: Row) {
      server.set(row.id, { ...row })
      cache.set(row.id, { ...row })
    },
    setCost(id: string, cost: number) {
      cache.get(id)!.cost = cost
    },
    setStatus(id: string, status: "running" | "idle") {
      statuses.set(id, status)
    },
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

export type FakeWorld = ReturnType<typeof createFakeContext>

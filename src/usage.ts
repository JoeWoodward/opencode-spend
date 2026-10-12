// Latest context size per session: the token total of its newest completed
// assistant message (the same measure the built-in Context section uses).
//
// `session.step.ended` carries the step's tokens for any session, so live
// sessions (including running subagents) update without loading messages.
// A session seen for the first time reads one small page once.
import { isComplete, type AssistantMessage, type MessagePage, type ModelRef, type TokenUsage } from "./ledger.ts"

export type ContextUsage = { tokens: number; model?: ModelRef }

export function contextTokens(tokens: TokenUsage | undefined): number {
  if (!tokens) return 0
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
}

export interface UsageDeps {
  fetch(sessionID: string, cursor: string | undefined, limit: number, signal: AbortSignal): Promise<MessagePage>
}

export interface UsageTracker {
  get(sessionID: string): ContextUsage | undefined
  /** Load the latest usage once, if not yet known. */
  ensure(sessionID: string): void
  /**
   * Record a finished step. Its model is the one it started with, when that
   * was seen; `fallback` (the session's selected model) otherwise. The
   * selected model can change mid-step without affecting the step.
   */
  record(sessionID: string, tokens: TokenUsage, messageID?: string, fallback?: ModelRef): void
  /**
   * Record the model of a step that just started. A session with no usage
   * yet gets an empty entry, so its bar can show from the first step.
   *
   * On a model switch the previous size is kept against the new model's
   * limit on purpose: the step now running sends that same history to the
   * new model, so this is the pressure it is under (and an overflow into a
   * smaller window shows before the step fails or compacts).
   */
  started(sessionID: string, model: ModelRef, messageID?: string): void
  /** Forget a session (e.g. after a revert), so the next `ensure` reloads it. */
  forget(sessionID: string): void
  subscribe(listener: () => void): () => void
  dispose(): void
}

function latestUsage(messages: AssistantMessage[]): ContextUsage | undefined {
  for (const message of messages) {
    if (!isComplete(message)) continue
    const tokens = contextTokens(message.tokens)
    if (tokens > 0) return { tokens, model: message.model }
  }
  return undefined
}

export function createUsageTracker(deps: UsageDeps): UsageTracker {
  const usage = new Map<string, ContextUsage>()
  /**
   * Sessions read (or being read) since they were last forgotten, so a
   * session without completed usage is not re-read on every update. Each
   * read gets a token: `forget` drops it, and a read whose token is gone
   * (the session was reverted meanwhile) is discarded.
   */
  const reads = new Map<string, symbol>()
  /** The model each session's current step started with. */
  const steps = new Map<string, { messageID?: string; model: ModelRef }>()
  const listeners = new Set<() => void>()
  const lifetime = new AbortController()
  const changed = () => listeners.forEach((listener) => listener())

  return {
    get: (sessionID) => usage.get(sessionID),
    ensure(sessionID) {
      // An empty entry from `started` still needs the real latest usage.
      if ((usage.get(sessionID)?.tokens ?? 0) > 0 || reads.has(sessionID) || lifetime.signal.aborted) return
      const read = Symbol(sessionID)
      reads.set(sessionID, read)
      deps
        .fetch(sessionID, undefined, 5, lifetime.signal)
        .then((page) => {
          // A step recorded meanwhile is newer than this page.
          if (lifetime.signal.aborted || reads.get(sessionID) !== read || (usage.get(sessionID)?.tokens ?? 0) > 0) return
          const latest = latestUsage(page.data)
          if (!latest) return
          // A step started meanwhile (or before) runs on its own model,
          // which is newer than any completed message in the page.
          usage.set(sessionID, { tokens: latest.tokens, model: steps.get(sessionID)?.model ?? latest.model })
          changed()
        })
        // Read again on the next `ensure`.
        .catch(() => {
          if (reads.get(sessionID) === read) reads.delete(sessionID)
        })
    },
    record(sessionID, tokens, messageID, fallback) {
      const total = contextTokens(tokens)
      if (total <= 0) return
      const step = steps.get(sessionID)
      const model = step && (messageID === undefined || step.messageID === messageID) ? step.model : fallback
      usage.set(sessionID, { tokens: total, model: model ?? usage.get(sessionID)?.model })
      changed()
    },
    started(sessionID, model, messageID) {
      steps.set(sessionID, { messageID, model })
      const current = usage.get(sessionID)
      if (current?.model?.id === model.id && current.model.providerID === model.providerID) return
      usage.set(sessionID, { tokens: current?.tokens ?? 0, model })
      changed()
    },
    forget(sessionID) {
      steps.delete(sessionID)
      reads.delete(sessionID)
      if (usage.delete(sessionID)) changed()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose() {
      lifetime.abort()
      usage.clear()
      reads.clear()
      steps.clear()
      listeners.clear()
    },
  }
}

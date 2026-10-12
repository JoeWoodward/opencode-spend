// Which sidebar sections are open, per session. Persisted, so it survives
// restarts, and keyed by session so expanding a section in one session (or
// tab) leaves the others alone. Pure helpers; storage is wired in `tui.tsx`.
import { prune } from "./ledger.ts"

export type SectionState = {
  /** The summary line's details. */
  expanded: boolean
  /** The spend breakdown. */
  breakdown: boolean
  /** The token breakdown. */
  tokens: boolean
  /** One row per subagent under the subagent total. */
  subagents: boolean
}

export type SectionKey = keyof SectionState

/** Everything starts collapsed. */
export const SECTION_DEFAULTS: SectionState = { expanded: false, breakdown: false, tokens: false, subagents: false }

export type SavedSections = Partial<SectionState> & { viewed?: number }

export type SectionStore = { sessions: Record<string, SavedSections> }

export const SECTION_STORE_KEY = "sections"

export function sectionsFor(store: SectionStore | undefined, sessionID: string): SectionState {
  const saved = store?.sessions?.[sessionID]
  const state = { ...SECTION_DEFAULTS }
  if (!saved) return state
  for (const key of Object.keys(SECTION_DEFAULTS) as SectionKey[]) {
    if (typeof saved[key] === "boolean") state[key] = saved[key]
  }
  return state
}

/** Flip one section of one session in `draft`, keeping at most `max` sessions. */
export function toggleSection(draft: SectionStore, sessionID: string, key: SectionKey, now: number, max: number) {
  draft.sessions ??= {}
  const next: SavedSections = { ...sectionsFor(draft, sessionID), viewed: now }
  next[key] = !next[key]
  draft.sessions[sessionID] = next
  const kept = prune(draft.sessions, max)
  for (const id of Object.keys(draft.sessions)) if (!(id in kept)) delete draft.sessions[id]
}

/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import type { HydrationStatus, Hydrator } from "./hydration.ts"
import {
  fit,
  SIDEBAR_WIDTH,
  formatCount,
  formatExact,
  formatMoney,
  formatTokens,
  MARKERS,
  percent,
  pressure,
  progressBar,
  type BarSegment,
} from "./label.ts"
import type { Ledger, ModelRef } from "./ledger.ts"
import {
  createSpendHydrator,
  createStoredLedger,
  familySpend,
  resolveConfig,
  type PluginConfig,
  type SpendOptions,
} from "./spend.ts"
import type { UsageTracker } from "./usage.ts"
import {
  keepDismissed,
  liveConditions,
  tokenRows,
  totals,
  VIEW_TITLES,
  viewRows,
  visibleLive,
  type Family,
  type Live,
  type LiveId,
  type Member,
  type Row,
  type TokenRow,
} from "./views.ts"
import {
  SECTION_STORE_KEY,
  sectionsFor,
  toggleSection,
  type SectionKey,
  type SectionStore,
} from "./sections.ts"

// Everything a sidebar instance needs. `version` turns change notifications
// from the hydrator, ledger and usage tracker into something Solid can track.
type Spend = {
  context: Context
  config: PluginConfig
  hydrator: Hydrator
  ledger: Ledger
  usage: UsageTracker
  version: () => number
  /** Open sections per session (reactive store). */
  sections: SectionStore
  toggleSection: (sessionID: string, key: SectionKey) => void
}

// A plain, serialisable snapshot of what the sidebar shows. The tree is
// rebuilt only when this changes (compared structurally), so streaming
// updates that do not change the numbers cost nothing.
type Model = {
  status: HydrationStatus
  total: number
  tokens: number
  tokenRows: TokenRow[]
  cacheHit?: number
  context?: { tokens: number; limit?: number }
  expanded: boolean
  breakdown: boolean
  tokensOpen: boolean
  /** Every configured view, in order, skipping empty ones. */
  sections: Array<{ title: string; rows: Row[] }>
  /** Live conditions not dismissed, stacked in priority order. */
  live: Live[]
}

function contextLimit(context: Context, model: ModelRef | undefined, location: unknown): number | undefined {
  if (!model) return undefined
  const models = context.data.location.model.list(location as never)
  return models?.find((entry) => entry.providerID === model.providerID && entry.id === model.id)?.limit.context
}

function member(context: Context, id: string): Member | undefined {
  const session = context.data.session.get(id)
  if (!session) return undefined
  return {
    id,
    parentID: session.parentID,
    agent: session.agent,
    model: session.model,
    title: session.title,
    cost: session.cost ?? 0,
    tokens: session.tokens,
    running: context.data.session.status(id) === "running",
  }
}

function useModel(spend: Spend, sessionID: () => string, dismissed: () => ReadonlySet<LiveId>) {
  const { context, hydrator, ledger, usage, config } = spend
  const synced = new Set<string>()

  // Sessions acquire the same root and so share its hydration.
  createEffect(() => {
    const id = sessionID()
    if (id) onCleanup(hydrator.acquire(id))
  })

  const rootID = createMemo(() => {
    const id = sessionID()
    spend.version()
    return familySpend(context.data.session, id, hydrator.state(id)).root
  })

  createEffect(() => {
    const root = rootID()
    if (root) onCleanup(ledger.acquire(root))
  })

  const family = createMemo((): Family => {
    spend.version()
    const root = rootID()
    const ids = new Set([root, ...(context.data.session.family(root) ?? [])])
    const members = [...ids].map((id) => member(context, id)).filter((value): value is Member => !!value)
    return { rootID: root, members, ledger: ledger.entry(root) }
  })

  // `fallback` supplies a model before the session has recorded any usage,
  // so a new session shows an empty bar right away.
  const contextOf = (id: string, fallback?: ModelRef) => {
    const latest = usage.get(id)
    const session = context.data.session.get(id)
    const model = latest?.model ?? session?.model ?? fallback
    if (!latest && !model) return undefined
    const location = session?.location
    const key = JSON.stringify(location ?? null)
    if (!synced.has(key) && context.data.location.model.list(location as never) === undefined) {
      synced.add(key)
      context.data.location.model.sync(location as never).catch(() => {})
    }
    const limit = contextLimit(context, model, location)
    // Without usage there is nothing to show unless the limit is known.
    if (!latest && !limit) return undefined
    return { tokens: latest?.tokens ?? 0, limit }
  }

  // The prompt's selected model, for the viewed session before its first step.
  const promptModel = (): ModelRef | undefined => {
    const selected = context.ui.model.current()
    return selected ? { id: selected.modelID, providerID: selected.providerID } : undefined
  }

  // Load the latest context size of the viewed session and running subagents.
  createEffect(() => {
    usage.ensure(sessionID())
    for (const entry of family().members) if (entry.running) usage.ensure(entry.id)
  })

  const live = createMemo(() => liveConditions(family(), config.live, (id) => contextOf(id)))

  const model = createMemo(
    (): Model => {
      spend.version()
      const id = sessionID()
      const state = hydrator.state(id)
      const sum = totals(family())
      const open = sectionsFor(spend.sections, id)
      return {
        status: state.status,
        // The cache's family total is authoritative; `sum` covers tokens.
        total: familySpend(context.data.session, id, state).total,
        tokens: sum.tokens,
        tokenRows: tokenRows(sum.usage, contextOf(id, promptModel())?.tokens),
        cacheHit: sum.cacheHit,
        context: contextOf(id, promptModel()),
        expanded: open.expanded,
        breakdown: open.breakdown,
        tokensOpen: open.tokens,
        sections: config.views
          .map((view) => ({
            title: VIEW_TITLES[view],
            rows: viewRows(view, family(), { subagentsOpen: open.subagents }),
          }))
          .filter((section) => section.rows.length > 0),
        live: visibleLive(live(), dismissed()),
      }
    },
    undefined,
    { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) },
  )

  return { model, live }
}

// JSX rules: installed from npm, this file lives under node_modules, where
// OpenTUI skips Solid's JSX compiler and Bun compiles JSX with the automatic
// runtime instead. Every `{expression}` is then evaluated once. To stay
// reactive in both a file:// and an npm install, the sidebar renders through
// one function child that rebuilds the tree from a plain `Model` snapshot.
// Relative imports also need explicit extensions, or OpenTUI cannot swap
// `solid-js` for the host's copy and the plugin gets a disconnected one.

function SidebarView(props: { spend: Spend; sessionID: string }) {
  const { spend } = props
  const theme = spend.context.theme
  const [dismissed, setDismissed] = createSignal<ReadonlySet<LiveId>>(new Set())
  const { model, live } = useModel(spend, () => props.sessionID, dismissed)

  // A dismissal lasts until its condition clears.
  createEffect(() => {
    const conditions = live()
    setDismissed((current) => {
      const kept = keepDismissed(conditions, current)
      return kept.size === current.size ? current : kept
    })
  })

  const toggle = (key: SectionKey) => () => spend.toggleSection(props.sessionID, key)
  const dismiss = (id: LiveId) => () => setDismissed((current) => new Set([...current, id]))

  const feedback = (level: "success" | "warning" | "error") => theme.text.feedback?.[level]?.base ?? theme.text.base
  const fillColor = (ratio: number) => {
    const band = pressure(ratio)
    return band === "high" ? feedback("error") : band === "medium" ? feedback("warning") : feedback("success")
  }
  const segmentColor = (segment: BarSegment, ratio: number) =>
    segment.kind === "fill" ? fillColor(ratio) : segment.kind === "marker" ? theme.text.base : theme.text.muted

  const bar = (width: number, ratio: number, marker?: number) =>
    progressBar(width, ratio, marker).map((segment) => (
      <span style={{ fg: segmentColor(segment, ratio) }}>{segment.text}</span>
    ))

  const amountWidth = (rows: Row[]) =>
    Math.max(0, ...rows.map((row) => formatExact(row.amount).length))

  const rowsView = (rows: Row[], indent: string, width = amountWidth(rows)) => {
    return rows.map((row) => {
      // An expandable row carries its handle before the label; nested rows
      // line up under the label text.
      const prefix = row.toggle ? `${row.toggle.open ? "▼" : "▶"} ` : "  ".repeat(row.depth ?? 0)
      const amount = formatExact(row.amount).padStart(width)
      const room = SIDEBAR_WIDTH - indent.length - width - 2 - prefix.length
      const line = (
        <text fg={theme.text.muted} wrapMode="none" truncate>
          {`${indent}${amount}  ${prefix}${fit(row.label, room)}`}
        </text>
      )
      return row.toggle ? <box onMouseUp={toggle(row.toggle.id)}>{line}</box> : line
    })
  }

  const liveView = (live: Live, indent: string) => {
    if (live.id === "cache") {
      return (
        <box onMouseUp={dismiss("cache")}>
          <text fg={feedback("warning")} wrapMode="none" truncate>
            {`${indent}⚠ Cache hit ${percent(live.hit)} (target ${percent(live.threshold)})`}
          </text>
        </box>
      )
    }
    const labelWidth = Math.min(12, Math.max(...live.rows.map((row) => row.label.length)))
    return (
      <box>
        <box onMouseUp={dismiss("subagents")}>
          <text fg={theme.text.base}>{`${indent}Running (${live.rows.length})`}</text>
        </box>
        {live.rows.map((row) => (
          <text fg={theme.text.muted} wrapMode="none" truncate>
            <span>{`${indent}${row.label.slice(0, labelWidth).padEnd(labelWidth)} `}</span>
            {row.ratio !== undefined ? bar(8, row.ratio) : <span>{"········"}</span>}
            <span>{` ${row.ratio !== undefined ? percent(row.ratio).padStart(4) : "   …"} ${formatMoney(row.amount).padStart(4)}`}</span>
          </text>
        ))}
      </box>
    )
  }

  const render = (m: Model) => {
    if (m.total <= 0 && !m.context) return null
    const marker = MARKERS[m.status]
    const ratio = m.context?.limit ? m.context.tokens / m.context.limit : undefined
    const summary = [
      m.context ? (m.context.limit ? `${formatTokens(m.context.tokens)} / ${formatTokens(m.context.limit)}` : `${formatTokens(m.context.tokens)} tokens`) : undefined,
      `${formatMoney(m.total)}${marker}`,
    ]
      .filter(Boolean)
      .join(" · ")
    // One amount column across every section, so they line up.
    const width = amountWidth(m.sections.flatMap((section) => section.rows))
    const countWidth = Math.max(0, ...m.tokenRows.map((row) => formatCount(row.tokens).length))

    return (
      <box>
        {/* The whole header (title, bar, summary) toggles, so the handle
            works wherever the click lands. */}
        <box onMouseUp={toggle("expanded")}>
          <text fg={theme.text.base}>
            <b>Context</b>
          </text>
          {ratio !== undefined && (
            <text wrapMode="none">
              {bar(spend.config.barWidth, ratio, spend.config.compactionMarker)}
              <span style={{ fg: theme.text.muted }}>{` ${percent(ratio)}`}</span>
            </text>
          )}
          <text fg={theme.text.muted} wrapMode="none" truncate>{`${m.expanded ? "▼" : "▶"} ${summary}`}</text>
        </box>
        {m.expanded && (
          <box onMouseUp={toggle("breakdown")}>
            <text fg={theme.text.muted}>{`  ${m.breakdown ? "▼" : "▶"} ${formatExact(m.total)} spent${marker}`}</text>
          </box>
        )}
        {m.expanded &&
          m.breakdown &&
          m.sections.map((section) => (
            <box>
              <text fg={theme.text.base}>{`    ${section.title}`}</text>
              {rowsView(section.rows, "    ", width)}
            </box>
          ))}
        {m.expanded && (
          <box onMouseUp={toggle("tokens")}>
            <text fg={theme.text.muted}>{`  ${m.tokensOpen ? "▼" : "▶"} ${formatCount(m.tokens)} tokens`}</text>
          </box>
        )}
        {m.expanded &&
          m.tokensOpen &&
          m.tokenRows.map((row) => (
            <text fg={theme.text.muted} wrapMode="none" truncate>
              {`    ${formatCount(row.tokens).padStart(countWidth)}  ${row.label}`}
            </text>
          ))}
        {m.expanded && m.tokensOpen && m.cacheHit !== undefined && (
          <text fg={theme.text.muted}>{`    ${"".padStart(countWidth)}  cache hit ${percent(m.cacheHit)}`}</text>
        )}
        {/* Below everything, so it never splits the spend and token
            sections, collapsed or expanded. */}
        {m.live.map((condition) => liveView(condition, "  "))}
      </box>
    )
  }

  return <>{() => render(model())}</>
}

export type PluginOverrides = {
  /** Hydration and ledger tuning. Injectable for tests. */
  hydration?: SpendOptions
}

export function createPlugin(overrides: PluginOverrides = {}) {
  return Plugin.define({
    id: "opencode-spend",
    setup(context) {
      const config = resolveConfig(context.options)
      const [version, setVersion] = createSignal(0)
      const bump = () => setVersion((value) => value + 1)
      const hydration = createSpendHydrator(context, bump, overrides.hydration)
      const stored = createStoredLedger(context, bump, config, overrides.hydration)
      const [sections, updateSections] = context.storage.store<SectionStore>(SECTION_STORE_KEY, {
        initial: { sessions: {} },
      })
      const toggle = (sessionID: string, key: SectionKey) => {
        updateSections((draft) => toggleSection(draft, sessionID, key, Date.now(), config.maxSavedSessions)).catch(
          (error) => console.error("opencode-spend: failed to save section state", error),
        )
      }

      const spend: Spend = {
        context,
        config,
        hydrator: hydration.hydrator,
        ledger: stored.ledger,
        usage: stored.usage,
        version,
        sections,
        toggleSection: toggle,
      }

      // Slot claims are owned by the plugin and removed automatically on unload.
      // Prepended, so it sits where the built-in Context section did: above MCP.
      context.ui.slot({
        prepend: "sidebar.content",
        render: (input) => <SidebarView spend={spend} sessionID={input.sessionID} />,
      })

      // Cancel outstanding work and flush the ledger on unload.
      return () => {
        stored.dispose()
        hydration.dispose()
      }
    },
  })
}

export default createPlugin()

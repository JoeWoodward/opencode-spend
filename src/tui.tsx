import type { TuiPlugin, TuiPluginModule, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { OpencodeClient } from "@opencode-ai/sdk/v2"
import { createSignal, createMemo, onCleanup, Show, type Accessor, type Setter } from "solid-js"
import { appendFileSync } from "node:fs"

// Lightweight perf instrumentation. Enabled when SPEND_DEBUG is set. Rather than
// logging every event (which itself can dominate CPU), we aggregate counters and
// flush a one-line summary on an interval, plus immediately flag pathological
// signals (very frequent refreshes, slow tree walks, coalesce backpressure).
const DEBUG = !!process.env.SPEND_DEBUG
const DEBUG_LOG = "/tmp/spend-debug.log"

function logLine(msg: string) {
  if (!DEBUG) return
  try {
    appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${msg}\n`)
  } catch {
    // ignore
  }
}

type Metrics = {
  events: number
  refreshes: number
  coalesced: number
  walkTotalMs: number
  walkMaxMs: number
  trackerCount: number
}

const metrics: Metrics = {
  events: 0,
  refreshes: 0,
  coalesced: 0,
  walkTotalMs: 0,
  walkMaxMs: 0,
  trackerCount: 0,
}

let metricsTimer: ReturnType<typeof setInterval> | undefined

function startMetricsLoop() {
  if (!DEBUG || metricsTimer) return
  metricsTimer = setInterval(() => {
    const avgWalk = metrics.refreshes > 0 ? metrics.walkTotalMs / metrics.refreshes : 0
    logLine(
      `[metrics 5s] events=${metrics.events} refreshes=${metrics.refreshes} ` +
        `coalesced=${metrics.coalesced} avgWalkMs=${avgWalk.toFixed(1)} ` +
        `maxWalkMs=${metrics.walkMaxMs.toFixed(1)} trackers=${metrics.trackerCount}`,
    )
    // Flag suspicious throughput: a healthy idle tracker should be ~0 refreshes.
    if (metrics.refreshes > 50) {
      logLine(`[WARN] high refresh rate this window: ${metrics.refreshes} (possible loop)`) 
    }
    if (metrics.walkMaxMs > 500) {
      logLine(`[WARN] slow tree walk: ${metrics.walkMaxMs.toFixed(0)}ms`)
    }
    metrics.events = 0
    metrics.refreshes = 0
    metrics.coalesced = 0
    metrics.walkTotalMs = 0
    metrics.walkMaxMs = 0
  }, 5000)
  if (typeof metricsTimer === "object" && "unref" in metricsTimer) {
    ;(metricsTimer as { unref: () => void }).unref()
  }
}

async function sumDescendants(
  client: OpencodeClient,
  sessionID: string,
  visited: Set<string>,
  depth: number,
): Promise<number> {
  if (depth > 10) return 0
  if (visited.has(sessionID)) return 0
  visited.add(sessionID)
  try {
    const result = await client.session.children({ sessionID })
    const children = (result.data ?? []).filter((s) => !visited.has(s.id))
    const ownCost = children.reduce((sum, s) => sum + (s.cost ?? 0), 0)
    let nested = 0
    for (const child of children) {
      nested += await sumDescendants(client, child.id, visited, depth + 1)
    }
    return ownCost + nested
  } catch {
    return 0
  }
}

// One tracker per orchestrator session, created exactly ONCE and stored at
// module scope. The slot renderer can be invoked many times, so all stateful
// setup (event subscription, polling) lives here behind a strict guard. The
// previous version created this inside the render body, which re-ran on every
// reactive update and produced an infinite refresh loop plus a listener leak.
type Tracker = {
  cost: Accessor<number>
  setCost: Setter<number>
  started: boolean
  dispose: () => void
}

const trackers = new Map<string, Tracker>()

function getTracker(sessionID: string): Tracker {
  let tracker = trackers.get(sessionID)
  if (tracker) return tracker
  const [cost, setCost] = createSignal(0)
  tracker = { cost, setCost, started: false, dispose: () => {} }
  trackers.set(sessionID, tracker)
  return tracker
}

// Begin watching a session's subagent spend. Guarded by `started` so it only
// ever runs once per tracker no matter how often the view mounts.
function startTracker(api: TuiPluginApi, sessionID: string) {
  const tracker = getTracker(sessionID)
  if (tracker.started) return
  tracker.started = true

  let inFlight = false
  let dirty = false
  let disposed = false

  metrics.trackerCount = trackers.size
  startMetricsLoop()

  async function refresh() {
    if (disposed) return
    if (inFlight) {
      dirty = true
      metrics.coalesced++
      return
    }
    inFlight = true
    dirty = false
    const t0 = Date.now()
    try {
      const total = await sumDescendants(api.client, sessionID, new Set(), 0)
      if (!disposed) tracker.setCost(total)
    } finally {
      const elapsed = Date.now() - t0
      metrics.refreshes++
      metrics.walkTotalMs += elapsed
      if (elapsed > metrics.walkMaxMs) metrics.walkMaxMs = elapsed
      inFlight = false
      if (dirty && !disposed) void refresh()
    }
  }

  // Subagent message.updated events DO reach api.event.on (verified), carrying
  // the subagent's own sessionID. Any such event means a descendant's spend may
  // have changed, so recompute the tree (coalesced to avoid pile-up).
  const handler = () => {
    if (disposed) return
    metrics.events++
    void refresh()
  }
  const offMessage = api.event.on("message.updated", handler as never)
  const offIdle = api.event.on("session.idle", handler as never)

  tracker.dispose = () => {
    disposed = true
    offMessage()
    offIdle()
    trackers.delete(sessionID)
    metrics.trackerCount = trackers.size
  }

  void refresh()
}

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const session = createMemo(() => props.api.state.session.get(props.session_id))

  startTracker(props.api, props.session_id)
  const tracker = getTracker(props.session_id)

  const total = createMemo(() => (session()?.cost ?? 0) + tracker.cost())

  return (
    <Show when={total() > 0}>
      <box>
        <text fg={theme().text}>
          <b>Total Spend</b>
        </text>
        <text fg={theme().textMuted}>
          {money.format(total())} ({money.format(tracker.cost())})
        </text>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 150,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "spend",
  tui,
}

export default plugin

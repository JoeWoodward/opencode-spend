// Framework-independent pieces of the plugin: option resolution, wiring the
// hydrator to the plugin context, and computing a session's label. Kept out
// of `tui.tsx` so they can be tested without a Solid/OpenTUI renderer.
import type { Context } from "@opencode/plugin/tui/context"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { createHydrator, type HydrationDeps, type HydrationOptions, type Hydrator, type ViewState } from "./hydration.ts"
import { formatLabel } from "./label.ts"

export type SpendLocation = "both" | "sidebar" | "prompt"

const LOCATIONS: readonly SpendLocation[] = ["both", "sidebar", "prompt"]

export function isLocation(value: unknown): value is SpendLocation {
  return LOCATIONS.includes(value as SpendLocation)
}

// Legacy config file from the V1 release. Still honoured so existing installs
// keep their setting, but plugin options in cli.json take precedence:
//   { "plugins": [{ "package": "opencode-spend", "options": { "location": "prompt" } }] }
export const LEGACY_CONFIG_PATH = join(homedir(), ".config", "opencode", "spend.json")

export function readLegacyLocation(path: string = LEGACY_CONFIG_PATH): SpendLocation | undefined {
  try {
    const location = JSON.parse(readFileSync(path, "utf-8"))?.location
    return isLocation(location) ? location : undefined
  } catch {
    return undefined
  }
}

export function resolveLocation(
  options: Context["options"],
  readLegacy: () => SpendLocation | undefined = readLegacyLocation,
): SpendLocation {
  if (isLocation(options.location)) return options.location
  return readLegacy() ?? "both"
}

export function showsSidebar(location: SpendLocation): boolean {
  return location === "both" || location === "sidebar"
}

export function showsPrompt(location: SpendLocation): boolean {
  return location === "both" || location === "prompt"
}

export type SpendOptions = HydrationOptions & Pick<HydrationDeps, "sleep">

// One hydrator per plugin instance, so its bookkeeping lives and dies with
// the client cache it fills. `onChange` is called after every hydration
// state change.
export function createSpendHydrator(
  context: Pick<Context, "client" | "data">,
  onChange: () => void,
  options: SpendOptions = {},
): { hydrator: Hydrator; dispose: () => void } {
  const { sleep, ...hydration } = options
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
      sleep,
    },
    hydration,
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

// The label for a viewed session, read from the client cache.
export function spendLabel(
  session: Pick<Context["data"]["session"], "root" | "cost" | "get">,
  sessionID: string,
  state: ViewState,
): string {
  // Until ancestry is resolved, fall back to the cache's view of the root.
  const root = state.root ?? session.root(sessionID)
  const total = session.cost(root)
  const own = session.get(root)?.cost ?? 0
  return formatLabel({ total, subagents: Math.max(0, total - own) }, state.status)
}

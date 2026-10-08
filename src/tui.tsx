/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import type { Hydrator } from "./hydration.ts"
import {
  createSpendHydrator,
  readLegacyLocation,
  resolveLocation,
  showsPrompt,
  showsSidebar,
  spendLabel,
  type SpendLocation,
  type SpendOptions,
} from "./spend.ts"

// `version` turns the hydrator's change notifications into something Solid
// can track.
type Spend = {
  context: Context
  hydrator: Hydrator
  version: () => number
}

function createSpend(context: Context, options?: SpendOptions): { spend: Spend; dispose: () => void } {
  const [version, setVersion] = createSignal(0)
  const { hydrator, dispose } = createSpendHydrator(context, () => setVersion((value) => value + 1), options)
  return { spend: { context, hydrator, version }, dispose }
}

function useSpendLabel(spend: Spend, sessionID: () => string | undefined): () => string | undefined {
  const { context, hydrator } = spend

  // Sidebar and footer acquire the same session and so share its hydration.
  createEffect(() => {
    const id = sessionID()
    if (!id) return
    onCleanup(hydrator.acquire(id))
  })

  const view = createMemo(() => {
    const id = sessionID()
    if (!id) return undefined
    spend.version()
    return hydrator.state(id)
  })

  return createMemo(() => {
    const id = sessionID()
    const state = view()
    if (!id || !state) return undefined
    return spendLabel(context.data.session, id, state)
  })
}

// JSX rules: installed from npm, this file lives under node_modules, where
// OpenTUI skips Solid's JSX compiler and Bun compiles JSX with the automatic
// runtime instead. Every `{expression}` is then evaluated once. To stay
// reactive in both a file:// and an npm install:
//   - pass accessors as children (`{label}`, never `{label()}`);
//   - wrap conditional markup in a function child, not `<Show when={...}>`.
// Relative imports also need explicit extensions, or OpenTUI cannot swap
// `solid-js` for the host's copy and the plugin gets a disconnected one.

function SidebarView(props: { spend: Spend; sessionID: string }) {
  const label = useSpendLabel(props.spend, () => props.sessionID)
  const visible = createMemo(() => label() !== undefined)
  const theme = props.spend.context.theme

  return (
    <>
      {() =>
        visible() && (
          <box>
            <text fg={theme.text.base}>
              <b>Total Spend</b>
            </text>
            <text fg={theme.text.muted}>{label}</text>
          </box>
        )
      }
    </>
  )
}

function PromptView(props: { spend: Spend; sessionID?: string }) {
  const label = useSpendLabel(props.spend, () => props.sessionID)
  const visible = createMemo(() => label() !== undefined)
  const theme = props.spend.context.theme

  return <>{() => visible() && <text fg={theme.text.muted}>{label}</text>}</>
}

export type PluginOverrides = {
  /** Reads the legacy V1 config file. Injectable for tests. */
  readLegacyLocation?: () => SpendLocation | undefined
  /** Hydration tuning. Injectable for tests. */
  hydration?: SpendOptions
}

export function createPlugin(overrides: PluginOverrides = {}) {
  return Plugin.define({
    id: "opencode-spend",
    setup(context) {
      const location = resolveLocation(context.options, overrides.readLegacyLocation ?? readLegacyLocation)
      const { spend, dispose } = createSpend(context, overrides.hydration)

      // Slot claims are owned by the plugin and removed automatically on unload.
      if (showsSidebar(location)) {
        context.ui.slot({
          append: "sidebar.content",
          render: (input) => <SidebarView spend={spend} sessionID={input.sessionID} />,
        })
      }
      if (showsPrompt(location)) {
        context.ui.slot({
          append: "prompt.footer.status",
          render: (input) => <PromptView spend={spend} sessionID={input.sessionID} />,
        })
      }

      // Cancel outstanding hydration and drop its bookkeeping on unload.
      return dispose
    },
  })
}

export default createPlugin()

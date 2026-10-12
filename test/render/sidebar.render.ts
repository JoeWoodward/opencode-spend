// Renders the real sidebar in an OpenTUI test renderer, to catch what the
// pure view tests cannot: placement, indentation, click targets and
// reactivity. Run in two modes (see package.json `test:render`):
//   - compiled: Solid's JSX compiler, as for a file:// install
//   - npm: the automatic JSX runtime, as for an npm install (see npm-preload.ts)
import { afterEach, describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { untrack } from "solid-js"
import type { AssistantMessage, TokenUsage } from "../../src/ledger.ts"
import { createPlugin } from "../../src/tui.tsx"
import { createFakeContext, type Row } from "../fake-context.ts"

const opus = { id: "opus", providerID: "p" }
const haiku = { id: "haiku", providerID: "p" }
const usage = (input: number, read: number): TokenUsage => ({ input, output: 0, reasoning: 0, cache: { read, write: 0 } })
const done = (id: string, agent: string, cost: number): AssistantMessage => ({
  id,
  agent,
  cost,
  model: opus,
  time: { completed: 1 },
})

let cleanups: Array<() => void> = []
afterEach(() => {
  cleanups.forEach((cleanup) => cleanup())
  cleanups = []
})

async function mount(rows: Row[], messages: AssistantMessage[] = [], options: Record<string, unknown> = {}) {
  const world = createFakeContext(rows, {
    preloaded: ["root"],
    messages: { root: messages },
    options,
  })
  const unload = createPlugin({ hydration: { persistDelayMs: 0 } }).setup(world.context) as () => void
  // Untracked, as the host mounts slots: otherwise a frozen expression would
  // pass by re-running the whole component.
  const setup = await testRender(() => untrack(() => world.claims[0].render({ sessionID: "root" })) as never, {
    width: 42,
    height: 30,
  })
  cleanups.push(() => setup.renderer.destroy(), unload)
  const frame = async () => {
    await setup.renderOnce()
    return setup
      .captureCharFrame()
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line, index, lines) => line !== "" || lines.slice(index).some(Boolean))
  }
  /** Wait until the frame contains `text`; returns its lines. */
  const until = async (text: string) => {
    for (let i = 0; i < 200; i++) {
      const lines = await frame()
      if (lines.some((line) => line.includes(text))) return lines
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    throw new Error(`"${text}" never rendered:\n${(await frame()).join("\n")}`)
  }
  /** Click the first line containing `text`. */
  const click = async (text: string) => {
    const lines = await frame()
    const y = lines.findIndex((line) => line.includes(text))
    if (y < 0) throw new Error(`no line with "${text}":\n${lines.join("\n")}`)
    await setup.mockMouse.click(lines[y].indexOf(text), y)
  }
  return { world, frame, until, click }
}

describe("sidebar", () => {
  test("the total follows a finished step (reactivity)", async () => {
    const view = await mount([{ id: "root", cost: 1.5 }])
    await view.until("$1.50")
    view.world.setCost("root", 2.25)
    view.world.emit("session.step.ended", { sessionID: "root", tokens: usage(10, 0) })
    await view.until("$2.25")
  })

  test("header and breakdown expand on click, with every view and its other row", async () => {
    const view = await mount(
      [
        { id: "root", cost: 13, agent: "build", model: opus },
        { id: "e1", parentID: "root", cost: 2, agent: "explore", model: haiku },
      ],
      [done("m1", "plan", 4.5), done("m2", "build", 8)],
    )
    await view.until("$15")
    await view.click("▶")
    await view.click("spent")
    const lines = await view.until("By model")
    expect(lines).toEqual([
      "Context",
      "▼ $15.00",
      "  ▼ $15.00 spent",
      "    By agent",
      "    $13.00  Orchestrator",
      "     $2.00  Subagents (1)",
      "    By agent type",
      "     $8.00  build",
      "     $4.50  plan",
      "     $2.00  explore",
      "     $0.50  other",
      "    By model",
      "    $12.50  opus",
      "     $2.00  haiku",
      "     $0.50  other",
      "  ▶ 0 tokens",
    ])
  })

  test("live sections stack at the bottom, and dismiss one at a time", async () => {
    const view = await mount([
      { id: "root", cost: 3, tokens: usage(200_000, 10_000) },
      { id: "e1", parentID: "root", cost: 1, agent: "explore" },
    ])
    view.world.setStatus("e1", "running")
    // Any change re-reads the family; a step is the usual trigger.
    view.world.emit("session.step.ended", { sessionID: "root", tokens: usage(1, 0) })
    let lines = await view.until("Running (1)")
    const running = lines.findIndex((line) => line.includes("Running (1)"))
    const cache = lines.findIndex((line) => line.includes("⚠ Cache hit"))
    expect(running).toBeGreaterThan(lines.findIndex((line) => line.includes("$4")))
    expect(cache).toBe(running + 2)
    expect(lines[running + 1]).toStartWith("  explore")

    await view.click("Running (1)")
    lines = await view.frame()
    expect(lines.some((line) => line.includes("Running"))).toBe(false)
    expect(lines.at(-1)).toContain("⚠ Cache hit 5% (target 50%)")
  })
})

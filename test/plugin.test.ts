import { describe, expect, test } from "bun:test"
import plugin, { createPlugin } from "../src/tui"
import { createFakeContext } from "./fake-context"

// Exercises `setup` against a fake Context. Slot renders are covered by
// test/render, which needs a client-side Solid build (plain `bun test`
// resolves solid-js to its server build); run it with `bun run test:render`.
function run(options: Record<string, unknown> = {}) {
  const world = createFakeContext([{ id: "root", cost: 1 }], { preloaded: ["root"], options })
  const cleanup = createPlugin().setup(world.context)
  return { world, cleanup: cleanup as () => void, slots: world.claims.map((claim) => claim.prepend ?? claim.append) }
}

describe("plugin", () => {
  test("is the default export", () => {
    expect(plugin.id).toBe("opencode-spend")
    expect(typeof plugin.setup).toBe("function")
  })

  test("prepends to the sidebar (above MCP), whatever the legacy location option says", () => {
    expect(run().slots).toEqual(["sidebar.content"])
    expect(run().world.claims[0].prepend).toBe("sidebar.content")
    expect(run({ location: "both" }).slots).toEqual(["sidebar.content"])
    expect(run({ location: "prompt" }).slots).toEqual(["sidebar.content"])
  })

  test("cleanup unsubscribes every listener", () => {
    const { world, cleanup } = run()
    // The hydrator and the ledger both retry on reconnect.
    expect(world.listeners("server.connected")).toBe(2)
    expect(world.listeners("session.step.ended")).toBe(1)
    expect(world.listeners("session.step.failed")).toBe(1)
    cleanup()
    expect(world.listeners("server.connected")).toBe(0)
    expect(world.listeners("session.step.ended")).toBe(0)
    expect(world.listeners("session.step.failed")).toBe(0)
    expect(world.listeners("session.deleted")).toBe(0)
    // Events after unload are ignored.
    world.emit("server.connected")
    expect(world.calls.list + world.calls.sync).toBe(0)
  })
})

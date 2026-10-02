import { describe, expect, test } from "bun:test"
import plugin, { createPlugin, type PluginOverrides } from "../src/tui"
import { createFakeContext } from "./fake-context"

// Exercises `setup` against a fake Context. Slot renders are not invoked:
// rendering needs an OpenTUI renderer and a client-side Solid build, which
// `bun test` does not provide (it resolves solid-js to its server build).
function run(options: Record<string, unknown>, overrides: PluginOverrides = {}) {
  const world = createFakeContext([{ id: "root", cost: 1 }], { preloaded: ["root"], options })
  const cleanup = createPlugin({ readLegacyLocation: () => undefined, ...overrides }).setup(world.context)
  return { world, cleanup: cleanup as () => void, slots: world.claims.map((claim) => claim.append) }
}

describe("plugin", () => {
  test("is the default export", () => {
    expect(plugin.id).toBe("opencode-spend")
    expect(typeof plugin.setup).toBe("function")
  })

  test("registers both slots by default", () => {
    expect(run({}).slots).toEqual(["sidebar.content", "prompt.footer.status"])
    expect(run({ location: "both" }).slots).toEqual(["sidebar.content", "prompt.footer.status"])
  })

  test("registers only the chosen slot", () => {
    expect(run({ location: "sidebar" }).slots).toEqual(["sidebar.content"])
    expect(run({ location: "prompt" }).slots).toEqual(["prompt.footer.status"])
  })

  test("a valid option does not read the legacy file", () => {
    let reads = 0
    run({ location: "prompt" }, { readLegacyLocation: () => (reads++, "sidebar") })
    expect(reads).toBe(0)
  })

  test("an invalid option falls back to the legacy file, then to both", () => {
    let reads = 0
    const legacy = run({ location: "footer" }, { readLegacyLocation: () => (reads++, "sidebar") })
    expect(legacy.slots).toEqual(["sidebar.content"])
    expect(reads).toBe(1)
    expect(run({ location: "footer" }).slots).toEqual(["sidebar.content", "prompt.footer.status"])
  })

  test("listens for server.connected and its cleanup unsubscribes", () => {
    const { world, cleanup } = run({})
    expect(world.listeners("server.connected")).toBe(1)
    expect(typeof cleanup).toBe("function")
    cleanup()
    expect(world.listeners("server.connected")).toBe(0)
    // Events after unload are ignored.
    world.emit("server.connected")
    expect(world.calls.list + world.calls.sync).toBe(0)
  })
})

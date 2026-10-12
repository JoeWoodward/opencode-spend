import { describe, expect, test } from "bun:test"
import type { AssistantMessage, MessagePage } from "../src/ledger"
import { createUsageTracker } from "../src/usage"
import { waitFor } from "./fake-context"

const tokens = (input: number) => ({ input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })
const opus = { id: "opus", providerID: "p" }

function tracker(messages: AssistantMessage[]) {
  let fetches = 0
  const usage = createUsageTracker({
    async fetch(): Promise<MessagePage> {
      fetches++
      return { data: messages }
    },
  })
  return { usage, fetches: () => fetches }
}

describe("usage tracker", () => {
  test("loads the newest completed usage once", async () => {
    const t = tracker([
      { id: "m2", tokens: tokens(9) },
      { id: "m1", tokens: tokens(5), model: opus, time: { completed: 1 } },
    ])
    t.usage.ensure("s")
    await waitFor(() => t.usage.get("s") !== undefined, "loaded")
    expect(t.usage.get("s")).toEqual({ tokens: 5, model: opus })
    t.usage.ensure("s")
    expect(t.fetches()).toBe(1)
  })

  test("a started step gives a new session an empty entry with its model", () => {
    const t = tracker([])
    t.usage.started("s", opus)
    expect(t.usage.get("s")).toEqual({ tokens: 0, model: opus })
  })

  test("an empty entry still loads the real latest usage", async () => {
    const t = tracker([{ id: "m1", tokens: tokens(5), model: opus, time: { completed: 1 } }])
    t.usage.started("s", opus)
    t.usage.ensure("s")
    await waitFor(() => t.usage.get("s")?.tokens === 5, "loaded")
  })

  test("a finished step keeps the known model", () => {
    const t = tracker([])
    t.usage.started("s", opus)
    t.usage.record("s", tokens(7))
    expect(t.usage.get("s")).toEqual({ tokens: 7, model: opus })
  })

  test("a model switch keeps the current size against the new model", () => {
    // The step on the new model sends the same history, so that is its pressure.
    const t = tracker([])
    const haiku = { id: "haiku", providerID: "p" }
    t.usage.started("s", opus, "m1")
    t.usage.record("s", tokens(150_000), "m1")
    t.usage.started("s", haiku, "m2")
    expect(t.usage.get("s")).toEqual({ tokens: 150_000, model: haiku })
  })

  test("a session without completed usage is read once, not on every ensure", async () => {
    const t = tracker([{ id: "m1", tokens: tokens(9) }])
    t.usage.started("s", opus)
    t.usage.ensure("s")
    await Promise.resolve()
    await Promise.resolve()
    t.usage.ensure("s")
    t.usage.ensure("s")
    expect(t.fetches()).toBe(1)
    t.usage.forget("s")
    t.usage.ensure("s")
    expect(t.fetches()).toBe(2)
  })

  test("a failed read is retried on the next ensure", async () => {
    let fetches = 0
    const usage = createUsageTracker({
      async fetch(): Promise<MessagePage> {
        fetches++
        throw new Error("offline")
      },
    })
    usage.ensure("s")
    await waitFor(() => {
      usage.ensure("s")
      return fetches === 2
    }, "retried")
  })

  test("a model switch while the first read is in flight keeps the new model", async () => {
    const haiku = { id: "haiku", providerID: "p" }
    let resolve!: (page: MessagePage) => void
    const usage = createUsageTracker({ fetch: () => new Promise((r) => (resolve = r)) })
    usage.ensure("s")
    usage.started("s", haiku, "m2")
    resolve({ data: [{ id: "m1", tokens: tokens(5), model: opus, time: { completed: 1 } }] })
    await waitFor(() => usage.get("s")?.tokens === 5, "loaded")
    expect(usage.get("s")).toEqual({ tokens: 5, model: haiku })
  })

  test("a read in flight across a revert is discarded, and the session is read again", async () => {
    const resolvers: Array<(page: MessagePage) => void> = []
    const usage = createUsageTracker({ fetch: () => new Promise((r) => resolvers.push(r)) })
    usage.ensure("s")
    // Revert: forget, then ensure (as `session.revert.committed` does).
    usage.forget("s")
    usage.ensure("s")
    expect(resolvers.length).toBe(2)
    resolvers[0]({ data: [{ id: "reverted", tokens: tokens(99), model: opus, time: { completed: 1 } }] })
    await Promise.resolve()
    await Promise.resolve()
    expect(usage.get("s")).toBeUndefined()
    resolvers[1]({ data: [{ id: "m1", tokens: tokens(5), model: opus, time: { completed: 1 } }] })
    await waitFor(() => usage.get("s")?.tokens === 5, "reloaded")
  })

  test("a finished step keeps the model it started with", () => {
    const t = tracker([])
    t.usage.started("s", opus, "m1")
    t.usage.record("s", tokens(7), "m1", { id: "other", providerID: "p" })
    expect(t.usage.get("s")?.model).toEqual(opus)
  })
})

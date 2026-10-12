import { describe, expect, test } from "bun:test"
import { SECTION_DEFAULTS, sectionsFor, toggleSection, type SectionStore } from "../src/sections"

describe("sections", () => {
  test("everything starts collapsed", () => {
    expect(SECTION_DEFAULTS).toEqual({ expanded: false, breakdown: false, tokens: false, subagents: false })
    expect(sectionsFor(undefined, "a")).toEqual(SECTION_DEFAULTS)
    expect(sectionsFor({ sessions: {} }, "a")).toEqual(SECTION_DEFAULTS)
  })

  test("toggling one session leaves the others alone", () => {
    const store: SectionStore = { sessions: {} }
    toggleSection(store, "a", "expanded", 1, 10)
    toggleSection(store, "a", "tokens", 2, 10)
    expect(sectionsFor(store, "a")).toEqual({ ...SECTION_DEFAULTS, expanded: true, tokens: true })
    expect(sectionsFor(store, "b")).toEqual(SECTION_DEFAULTS)
    toggleSection(store, "a", "expanded", 3, 10)
    expect(sectionsFor(store, "a").expanded).toBe(false)
  })

  test("ignores malformed saved values", () => {
    const store = { sessions: { a: { expanded: "yes", tokens: true } } } as unknown as SectionStore
    expect(sectionsFor(store, "a")).toEqual({ ...SECTION_DEFAULTS, tokens: true })
  })

  test("keeps only the most recently toggled sessions", () => {
    const store: SectionStore = { sessions: {} }
    toggleSection(store, "a", "expanded", 1, 2)
    toggleSection(store, "b", "expanded", 2, 2)
    toggleSection(store, "c", "expanded", 3, 2)
    expect(Object.keys(store.sessions).sort()).toEqual(["b", "c"])
  })
})

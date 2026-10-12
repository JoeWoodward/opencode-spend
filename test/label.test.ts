import { describe, expect, test } from "bun:test"
import { fit, formatCount, formatExact, formatMoney, formatTokens, percent, pressure, progressBar } from "../src/label"

const text = (segments: ReturnType<typeof progressBar>) => segments.map((segment) => segment.text).join("")

describe("formatMoney", () => {
  test("uses cents under a dollar", () => {
    expect(formatMoney(0)).toBe("0c")
    expect(formatMoney(0.001)).toBe("<1c")
    expect(formatMoney(0.34)).toBe("34c")
    expect(formatMoney(0.345)).toBe("35c")
    expect(formatMoney(0.994)).toBe("99c")
  })

  test("uses dollars and cents from a dollar", () => {
    expect(formatMoney(0.996)).toBe("$1.00")
    expect(formatMoney(1)).toBe("$1.00")
    expect(formatMoney(19.29)).toBe("$19.29")
    expect(formatMoney(19.294)).toBe("$19.29")
    expect(formatMoney(1234.4)).toBe("$1,234.40")
  })

  test("never shows a negative amount", () => {
    expect(formatMoney(-1)).toBe("0c")
  })
})

describe("formatExact", () => {
  test("rounds to cents", () => {
    expect(formatExact(0.1 + 0.2)).toBe("$0.30")
    expect(formatExact(19.294)).toBe("$19.29")
    expect(formatExact(1234.5)).toBe("$1,234.50")
  })
})

describe("tokens", () => {
  test("formatTokens is compact", () => {
    expect(formatTokens(950)).toBe("950")
    expect(formatTokens(172_400)).toBe("172k")
    expect(formatTokens(400_000)).toBe("400k")
    expect(formatTokens(1_200_000)).toBe("1.2M")
    expect(formatTokens(1_000_000)).toBe("1M")
    expect(formatTokens(12_400_000)).toBe("12M")
  })

  test("formatCount is exact", () => {
    expect(formatCount(592_819)).toBe("592,819")
  })
})

describe("progressBar", () => {
  test("fills whole and partial cells", () => {
    expect(text(progressBar(10, 0))).toBe("░░░░░░░░░░")
    expect(text(progressBar(10, 1))).toBe("██████████")
    expect(text(progressBar(10, 0.5))).toBe("█████░░░░░")
    expect(text(progressBar(10, 0.525))).toBe("█████▎░░░░")
  })

  test("clamps out-of-range ratios", () => {
    expect(text(progressBar(4, 2))).toBe("████")
    expect(text(progressBar(4, -1))).toBe("░░░░")
    expect(text(progressBar(4, Number.NaN))).toBe("░░░░")
  })

  test("groups cells into coloured segments", () => {
    expect(progressBar(4, 0.5).map((segment) => segment.kind)).toEqual(["fill", "empty"])
  })

  test("draws a marker on unfilled cells only", () => {
    expect(text(progressBar(10, 0.2, 0.8))).toBe("██░░░░░░│░")
    expect(progressBar(10, 0.2, 0.8).map((segment) => segment.kind)).toEqual(["fill", "empty", "marker", "empty"])
    expect(text(progressBar(10, 0.9, 0.8))).toBe("█████████░")
  })
})

describe("fit", () => {
  test("truncates at the end", () => {
    expect(fit("general · Implement tasks", 12)).toBe("general · I…")
    expect(fit("short", 12)).toBe("short")
  })
})

describe("percent and pressure", () => {
  test("percent rounds", () => {
    expect(percent(0.524)).toBe("52%")
  })

  test("pressure bands", () => {
    expect(pressure(0.5)).toBe("low")
    expect(pressure(0.7)).toBe("medium")
    expect(pressure(0.95)).toBe("high")
  })
})

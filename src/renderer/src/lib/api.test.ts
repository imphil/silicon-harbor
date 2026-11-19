import { describe, expect, it } from "vitest"
import { selectApi } from "./api"

describe("selectApi", () => {
  it("uses the preload bridge by default", () => {
    expect(selectApi("", true, undefined)).toEqual({ mock: false })
  })

  it("falls back to the mock without a bridge", () => {
    expect(selectApi("", false, undefined).mock).toBe(true)
  })

  it("uses the mock when requested by build flag or URL", () => {
    expect(selectApi("", true, "1").mock).toBe(true)
    expect(selectApi("?mock=1", true, undefined).mock).toBe(true)
  })

  it("reads scenario, platform and speed, ignoring unknown values", () => {
    expect(
      selectApi(
        "?mock=1&scenario=first-run&platform=win&speed=0.1",
        true,
        undefined,
      ),
    ).toEqual({
      mock: true,
      scenario: "first-run",
      platform: "win",
      speed: 0.1,
    })
    expect(
      selectApi(
        "?mock=1&scenario=bogus&platform=amiga&speed=-1",
        true,
        undefined,
      ),
    ).toEqual({
      mock: true,
      scenario: undefined,
      platform: undefined,
      speed: undefined,
    })
  })
})

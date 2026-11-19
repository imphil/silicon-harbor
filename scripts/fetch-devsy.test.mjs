import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  binaryName,
  hostTarget,
  localCandidates,
  parseTargets,
} from "./fetch-devsy.mjs"

describe("fetch-devsy", () => {
  it("maps the host to an electron-builder target", () => {
    expect(hostTarget("darwin", "arm64")).toBe("mac-arm64")
    expect(hostTarget("win32", "x64")).toBe("win-x64")
    expect(hostTarget("linux", "x64")).toBe("linux-x64")
    expect(() => hostTarget("aix", "x64")).toThrow()
  })

  it("parses --targets", () => {
    expect(parseTargets(["--targets", "mac-x64, mac-arm64"])).toEqual([
      "mac-x64",
      "mac-arm64",
    ])
    expect(() => parseTargets(["--targets"])).toThrow()
  })

  it("names the Windows binary devsy.exe", () => {
    expect(binaryName("win-x64")).toBe("devsy.exe")
    expect(binaryName("mac-arm64")).toBe("devsy")
  })

  it("finds goreleaser output directories for a local build", () => {
    const dist = mkdtempSync(join(tmpdir(), "sh-dist-"))
    try {
      mkdirSync(join(dist, "devsy-dev_darwin_arm64_v8.0"))
      writeFileSync(join(dist, "devsy-dev_darwin_arm64_v8.0", "devsy"), "")
      expect(localCandidates(dist, "mac-arm64")[0]).toBe(
        join(dist, "devsy-dev_darwin_arm64_v8.0", "devsy"),
      )
      expect(localCandidates(dist, "win-x64")).toEqual([
        join(dist, "devsy-windows-amd64.exe"),
      ])
    } finally {
      rmSync(dist, { recursive: true, force: true })
    }
  })
})

import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { devsyBinaryPath } from "../devsy-path"

describe("devsyBinaryPath", () => {
  it("uses the packaged resources directory", () => {
    expect(
      devsyBinaryPath({
        platform: "darwin",
        arch: "arm64",
        isPackaged: true,
        resourcesPath: "/Applications/Silicon Harbor.app/Contents/Resources",
        appPath: "/ignored",
      }),
    ).toBe(
      join(
        "/Applications/Silicon Harbor.app/Contents/Resources",
        "bin",
        "devsy",
      ),
    )
  })

  it("adds .exe on Windows", () => {
    expect(
      devsyBinaryPath({
        platform: "win32",
        arch: "x64",
        isPackaged: true,
        resourcesPath: "/res",
        appPath: "/ignored",
      }),
    ).toBe(join("/res", "bin", "devsy.exe"))
  })

  it("reads the host target from resources/bin in development", () => {
    expect(
      devsyBinaryPath({
        platform: "linux",
        arch: "x64",
        isPackaged: false,
        resourcesPath: "/ignored",
        appPath: "/repo",
      }),
    ).toBe(join("/repo", "resources", "bin", "linux-x64", "devsy"))
    expect(
      devsyBinaryPath({
        platform: "darwin",
        arch: "arm64",
        isPackaged: false,
        resourcesPath: "/ignored",
        appPath: "/repo",
      }),
    ).toBe(join("/repo", "resources", "bin", "mac-arm64", "devsy"))
  })
})

// @vitest-environment node
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import {
  ChecksumMismatchError,
  downloadVerified,
  type FetchLike,
} from "../installers/download"
import { InstallError, runInstaller } from "../installers/install"
import {
  AssetSchema,
  findAsset,
  loadManifest,
  ManifestSchema,
} from "../installers/manifest"
import {
  appleScriptString,
  elevatedCommand,
  shellQuote,
  windowsArg,
} from "../requirements/elevate"
import { decodeOutput } from "../requirements/host"
import { FakeHost, fail, ok } from "./fake-host"

const dir = mkdtempSync(join(tmpdir(), "sh-installers-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe("manifest", () => {
  const manifest = loadManifest()

  it("loads and validates the shipped manifest", () => {
    expect(manifest.items["rancher-desktop"]?.version).toMatch(/^\d+\.\d+/)
  })

  it("finds a verified asset per platform and arch", () => {
    const mac = findAsset(manifest, "rancher-desktop", "darwin", "arm64")
    expect(mac).toMatchObject({ ok: true, asset: { kind: "dmg" } })
    const win = findAsset(manifest, "rancher-desktop", "win32", "x64")
    expect(win).toMatchObject({ ok: true, asset: { kind: "msi" } })
    expect(findAsset(manifest, "xquartz", "darwin", "x64").ok).toBe(true)
    expect(findAsset(manifest, "git-for-windows", "win32", "x64").ok).toBe(true)
  })

  it("refuses items without a published release or checksum", () => {
    const unreleased = ManifestSchema.parse({
      ...manifest,
      items: {
        ...manifest.items,
        "docker-credential-icr": {
          ...manifest.items["docker-credential-icr"],
          version: null,
          assets: {},
        },
      },
    })
    const icr = findAsset(unreleased, "docker-credential-icr", "linux", "x64")
    expect(icr.ok).toBe(false)
    if (!icr.ok) expect(icr.reason).toMatch(/cannot be installed automatically/)

    const xq = manifest.items.xquartz
    if (!xq) throw new Error("xquartz missing from the manifest")
    const noSha = ManifestSchema.parse({
      ...manifest,
      items: {
        ...manifest.items,
        xquartz: {
          ...xq,
          assets: {
            "darwin-arm64": { ...xq.assets["darwin-arm64"], sha256: null },
          },
        },
      },
    })
    const lookup = findAsset(noSha, "xquartz", "darwin", "arm64")
    expect(lookup.ok).toBe(false)
    if (!lookup.ok) expect(lookup.reason).toMatch(/no published checksum/)
  })

  it("has no asset for unsupported targets", () => {
    expect(findAsset(manifest, "rancher-desktop", "linux", "x64").ok).toBe(
      false,
    )
    expect(findAsset(manifest, "rancher-desktop", "win32", "arm64").ok).toBe(
      false,
    )
  })

  it("rejects plain-HTTP URLs and malformed checksums", () => {
    const bad = (asset: Record<string, unknown>) =>
      ManifestSchema.safeParse({
        schemaVersion: 1,
        updated: "x",
        items: {
          xquartz: {
            name: "XQuartz",
            version: "1",
            homepage: "https://example.com",
            assets: { "darwin-arm64": asset },
          },
        },
      }).success
    const sha = "a".repeat(64)
    expect(bad({ kind: "pkg", url: "https://x/y.pkg", sha256: sha })).toBe(true)
    expect(bad({ kind: "pkg", url: "http://x/y.pkg", sha256: sha })).toBe(false)
    expect(bad({ kind: "pkg", url: "https://x/y.pkg", sha256: "abc" })).toBe(
      false,
    )
  })
})

function fakeFetch(body: Buffer, status = 200): FetchLike {
  return async () => ({
    ok: status === 200,
    status,
    headers: {
      get: (n: string) => (n === "content-length" ? String(body.length) : null),
    },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(body.subarray(0, 3)))
        controller.enqueue(new Uint8Array(body.subarray(3)))
        controller.close()
      },
    }),
  })
}

describe("downloadVerified", () => {
  const body = Buffer.from("installer bytes")
  const sha = createHash("sha256").update(body).digest("hex")

  it("returns the file when the checksum matches, reporting progress", async () => {
    const progress: Array<number | undefined> = []
    const file = await downloadVerified({
      url: "https://example.com/dl/Setup 1.0.msi",
      sha256: sha,
      dir,
      fetch: fakeFetch(body),
      onProgress: (p) => progress.push(p),
    })
    expect(readFileSync(file, "utf8")).toBe("installer bytes")
    expect(file).toBe(join(dir, "Setup_1.0.msi"))
    expect(progress.at(-1)).toBe(100)
  })

  it("deletes the file and refuses on a checksum mismatch", async () => {
    await expect(
      downloadVerified({
        url: "https://example.com/bad.pkg",
        sha256: "0".repeat(64),
        dir,
        fetch: fakeFetch(body),
      }),
    ).rejects.toBeInstanceOf(ChecksumMismatchError)
    expect(existsSync(join(dir, "bad.pkg"))).toBe(false)
  })

  it("only downloads over HTTPS and reports HTTP errors", async () => {
    await expect(
      downloadVerified({
        url: "http://example.com/x.pkg",
        sha256: sha,
        dir,
        fetch: fakeFetch(body),
      }),
    ).rejects.toThrow(/HTTPS/)
    await expect(
      downloadVerified({
        url: "https://example.com/x.pkg",
        sha256: sha,
        dir,
        fetch: fakeFetch(body, 404),
      }),
    ).rejects.toThrow(/HTTP 404/)
  })
})

describe("runInstaller", () => {
  const url = "https://example.com/x"
  const sha256 = "a".repeat(64)

  it("unpacks a binary from an archive with tar and cleans up", async () => {
    const host = new FakeHost({ platform: "linux" })
    host.commands.tar = (args) => {
      // tar -xf <archive> -C <dir> <member>
      host.files[`${args[3]}/${args[4]}`] = "binary"
      return ok()
    }
    await runInstaller({
      host,
      asset: {
        kind: "binary",
        url,
        sha256,
        archive: "tar.gz",
        member: "docker-credential-icr",
      },
      file: "/tmp/dl/icr.tar.gz",
      name: "docker-credential-icr",
      binaryDest: "/home/dev/.local/bin/docker-credential-icr",
    })
    expect(host.runs).toEqual([
      "tar -xf /tmp/dl/icr.tar.gz -C /tmp/sh-extract-1 docker-credential-icr",
    ])
    expect(host.copies).toEqual([
      {
        src: "/tmp/sh-extract-1/docker-credential-icr",
        dest: "/home/dev/.local/bin/docker-credential-icr",
      },
    ])
    expect(host.removed).toEqual(["/tmp/sh-extract-1"])
  })

  it("fails clearly when the archive does not contain the binary", async () => {
    const host = new FakeHost({ platform: "linux", commands: { tar: ok() } })
    await expect(
      runInstaller({
        host,
        asset: { kind: "binary", url, sha256, archive: "zip", member: "x.exe" },
        file: "/tmp/dl/x.zip",
        name: "docker-credential-icr",
        binaryDest: "/home/dev/bin/x.exe",
      }),
    ).rejects.toThrow(/x\.exe not found in the download/)
    expect(host.removed).toEqual(["/tmp/sh-extract-1"])
  })

  it("rejects archive members that are paths", () => {
    expect(() =>
      AssetSchema.parse({
        kind: "binary",
        url,
        sha256,
        archive: "tar.gz",
        member: "../evil",
      }),
    ).toThrow()
  })

  it("installs a macOS pkg with administrator rights", async () => {
    const host = new FakeHost({ platform: "darwin" })
    await runInstaller({
      host,
      asset: { kind: "pkg", url, sha256 },
      file: "/tmp/x.pkg",
      name: "XQuartz",
    })
    expect(host.elevatedRuns).toEqual([
      "/usr/sbin/installer -pkg /tmp/x.pkg -target /",
    ])
  })

  it("copies an app out of a dmg, elevating only when needed, and detaches", async () => {
    const host = new FakeHost({
      platform: "darwin",
      commands: {
        "/usr/bin/hdiutil": ok(),
        "/usr/bin/ditto": fail("Permission denied"),
      },
    })
    await runInstaller({
      host,
      asset: { kind: "dmg", url, sha256, appName: "Rancher Desktop.app" },
      file: "/tmp/rd.dmg",
      name: "Rancher Desktop",
    })
    expect(host.runs[0]).toMatch(/^\/usr\/bin\/hdiutil attach \/tmp\/rd\.dmg/)
    expect(host.elevatedRuns).toEqual([
      "/usr/bin/ditto /tmp/sh-dmg-1/Rancher Desktop.app /Applications/Rancher Desktop.app",
    ])
    expect(host.runs.at(-1)).toBe(
      "/usr/bin/hdiutil detach /tmp/sh-dmg-1 -quiet",
    )
  })

  it("runs an MSI and an Inno Setup installer silently", async () => {
    const host = new FakeHost({ platform: "win32" })
    await runInstaller({
      host,
      asset: { kind: "msi", url, sha256 },
      file: "C:\\t\\rd.msi",
      name: "Rancher Desktop",
    })
    await runInstaller({
      host,
      asset: { kind: "inno", url, sha256 },
      file: "C:\\t\\Git.exe",
      name: "Git for Windows",
    })
    expect(host.elevatedRuns).toEqual([
      "msiexec.exe /i C:\\t\\rd.msi /qn /norestart",
      "C:\\t\\Git.exe /VERYSILENT /NORESTART /NOCANCEL /SP- /SUPPRESSMSGBOXES",
    ])
  })

  it("explains a cancelled or failed prompt", async () => {
    const cancelled = new FakeHost({
      platform: "darwin",
      elevated: { "/usr/sbin/installer": fail("User canceled. (-128)") },
    })
    await expect(
      runInstaller({
        host: cancelled,
        asset: { kind: "pkg", url, sha256 },
        file: "/tmp/x.pkg",
        name: "XQuartz",
      }),
    ).rejects.toThrow(/was cancelled/)
    const denied = new FakeHost({
      platform: "win32",
      elevated: { "msiexec.exe": fail("", 1603) },
    })
    await expect(
      runInstaller({
        host: denied,
        asset: { kind: "msi", url, sha256 },
        file: "x.msi",
        name: "Rancher Desktop",
      }),
    ).rejects.toBeInstanceOf(InstallError)
  })
})

describe("elevatedCommand", () => {
  it("uses AppleScript with administrator privileges on macOS", () => {
    const cmd = elevatedCommand("darwin", "/usr/sbin/installer", [
      "-pkg",
      "/tmp/a b's.pkg",
    ])
    expect(cmd.command).toBe("osascript")
    expect(cmd.args[1]).toBe(
      `do shell script "'/usr/sbin/installer' '-pkg' '/tmp/a b'\\\\''s.pkg'" with administrator privileges`,
    )
  })

  it("uses Start-Process -Verb RunAs on Windows and propagates the exit code", () => {
    const cmd = elevatedCommand("win32", "C:\\a b\\setup.exe", [
      "/i",
      "C:\\x y\\file.msi",
    ])
    expect(cmd.command).toBe("powershell.exe")
    const script = cmd.args.at(-1) ?? ""
    expect(script).toContain("Start-Process -FilePath 'C:\\a b\\setup.exe'")
    expect(script).toContain(`-ArgumentList '/i "C:\\x y\\file.msi"'`)
    expect(script).toContain("-Verb RunAs -Wait -PassThru")
    expect(script).toContain("exit $p.ExitCode")
  })

  it("uses pkexec on Linux", () => {
    expect(elevatedCommand("linux", "/bin/sh", ["-c", "x"])).toEqual({
      command: "pkexec",
      args: ["/bin/sh", "-c", "x"],
    })
  })

  it("quotes safely", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`)
    expect(appleScriptString('a"b\\c')).toBe('"a\\"b\\\\c"')
    expect(windowsArg("plain")).toBe("plain")
    expect(windowsArg('say "hi"')).toBe('"say \\"hi\\""')
    expect(windowsArg("C:\\dir with space\\")).toBe('"C:\\dir with space\\\\"')
    expect(windowsArg("")).toBe('""')
  })
})

describe("decodeOutput", () => {
  it("decodes UTF-16LE output from wsl.exe", () => {
    const text = "WSL version: 2.6.1.0\r\n"
    expect(decodeOutput(Buffer.from(text, "utf16le"))).toBe(text)
    expect(
      decodeOutput(
        Buffer.concat([
          Buffer.from([0xff, 0xfe]),
          Buffer.from(text, "utf16le"),
        ]),
      ),
    ).toBe(text)
  })

  it("leaves UTF-8 alone", () => {
    expect(decodeOutput(Buffer.from("Docker 28.5 – ok"))).toBe(
      "Docker 28.5 – ok",
    )
  })
})

// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import {
  buildCliEnv,
  defaultDevsyHome,
  executableSearchPath,
} from "../devsy/env"
import { toWorkspaceId, uniqueWorkspaceId } from "../devsy/ids"
import { buildDiagnostics, redact } from "../diagnostics"
import { DEFAULT_SETTINGS, SettingsStore } from "../settings-store"
import { shQuote, terminalCommands } from "../terminal"

const dir = mkdtempSync(join(tmpdir(), "sh-support-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe("buildCliEnv", () => {
  const env = buildCliEnv({
    hostEnv: {
      PATH: "/usr/bin",
      HOME: "/home/u",
      DOCKER_HOST: "unix:///x.sock",
      GITHUB_TOKEN: "secret",
      AWS_SECRET_ACCESS_KEY: "secret",
      DISPLAY: ":0",
    },
    platform: "linux",
    homeDir: "/home/u",
    devsyHome: "/home/u/.silicon-harbor",
  })

  it("passes only allow-listed variables", () => {
    expect(env.GITHUB_TOKEN).toBeUndefined()
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined()
    expect(env).toMatchObject({
      PATH: "/usr/bin",
      HOME: "/home/u",
      DOCKER_HOST: "unix:///x.sock",
      DISPLAY: ":0",
    })
  })

  it("forces English messages and sets Devsy's home and UI mode", () => {
    expect(env).toMatchObject({
      LC_ALL: "C",
      LANG: "C",
      DEVSY_UI: "true",
      DEVSY_HOME: "/home/u/.silicon-harbor",
    })
  })

  it("keeps Windows' differently-cased Path", () => {
    const win = buildCliEnv({
      hostEnv: { Path: "C:\\Windows", SystemRoot: "C:\\Windows" },
      platform: "win32",
      homeDir: "C:\\Users\\u",
      devsyHome: "C:\\Users\\u\\.silicon-harbor",
    })
    expect(win.Path).toBe("C:\\Windows")
    expect(win.SystemRoot).toBe("C:\\Windows")
    expect(win.PATH).toBeUndefined()
  })

  it("puts our own bin dir (docker-credential-icr) first on PATH", () => {
    const linux = buildCliEnv({
      hostEnv: { PATH: "/usr/bin" },
      platform: "linux",
      homeDir: "/home/u",
      devsyHome: "/home/u/.silicon-harbor",
      extraPathDirs: ["/home/u/.silicon-harbor/bin"],
    })
    expect(linux.PATH).toBe("/home/u/.silicon-harbor/bin:/usr/bin")
    const win = buildCliEnv({
      hostEnv: { Path: "C:\\Windows" },
      platform: "win32",
      homeDir: "C:\\Users\\u",
      devsyHome: "C:\\Users\\u\\.silicon-harbor",
      extraPathDirs: ["C:\\Users\\u\\.silicon-harbor\\bin"],
    })
    expect(win.Path).toBe("C:\\Users\\u\\.silicon-harbor\\bin;C:\\Windows")
  })

  it("adds Rancher Desktop and Homebrew to PATH on macOS only", () => {
    const mac = executableSearchPath("/usr/bin:/bin", "darwin", "/Users/u")
    expect(mac.split(":").slice(0, 2)).toEqual([
      "/Users/u/.rd/bin",
      "/usr/local/bin",
    ])
    expect(mac).toContain("/opt/homebrew/bin")
    expect(executableSearchPath("/usr/bin", "linux", "/home/u")).toBe(
      "/usr/bin",
    )
  })

  it("uses a short Devsy home, overridable for tests", () => {
    expect(defaultDevsyHome("darwin", "/Users/u", {})).toBe(
      "/Users/u/.silicon-harbor",
    )
    expect(defaultDevsyHome("win32", "C:\\Users\\u", {})).toBe(
      "C:\\Users\\u\\.silicon-harbor",
    )
    expect(
      defaultDevsyHome("linux", "/home/u", { SH_DEVSY_HOME: "/tmp/sh-1" }),
    ).toBe("/tmp/sh-1")
  })
})

describe("workspace ids", () => {
  it("normalizes names like Devsy does", () => {
    expect(toWorkspaceId("Core RTL_v2")).toBe("core-rtlv2")
    expect(toWorkspaceId("--x--")).toBe("x")
    expect(toWorkspaceId("!!!")).toBe("environment")
    expect(toWorkspaceId("a".repeat(60))).toHaveLength(48)
  })

  it("picks a free id because devsy up silently reuses existing ones", () => {
    expect(uniqueWorkspaceId("core-rtl", [])).toBe("core-rtl")
    expect(uniqueWorkspaceId("core-rtl", ["core-rtl"])).toBe("core-rtl-2")
    expect(uniqueWorkspaceId("core-rtl", ["core-rtl", "core-rtl-2"])).toBe(
      "core-rtl-3",
    )
    expect(uniqueWorkspaceId("a".repeat(48), ["a".repeat(48)])).toHaveLength(48)
  })
})

describe("SettingsStore", () => {
  it("starts with defaults and persists validated updates", () => {
    const file = join(dir, "settings.json")
    const store = new SettingsStore(file)
    expect(store.get()).toEqual(DEFAULT_SETTINGS)
    store.update({ defaultIde: "bob", firstRunDone: true })
    expect(new SettingsStore(file).get()).toMatchObject({
      defaultIde: "bob",
      firstRunDone: true,
    })
    expect(() => store.update({ defaultIde: "emacs" })).toThrow()
    expect(() => store.update({ unknown: 1 })).toThrow()
  })

  it("recovers from a corrupt or partially invalid file", () => {
    const file = join(dir, "bad.json")
    writeFileSync(file, "{ not json")
    expect(new SettingsStore(file).get()).toEqual(DEFAULT_SETTINGS)
    writeFileSync(
      file,
      JSON.stringify({ defaultIde: "emacs", firstRunDone: true }),
    )
    expect(new SettingsStore(file).get()).toMatchObject({
      defaultIde: "vscode",
      firstRunDone: true,
    })
    expect(readFileSync(file, "utf8")).toContain("emacs")
  })
})

describe("diagnostics", () => {
  it("redacts home paths, user names and credentials", () => {
    const text = redact(
      "/home/jdoe/.silicon-harbor jdoe https://jdoe:tok@github.ibm.com/x ghp_abcdefghijklmnopqrstuvwxyz0123",
      "/home/jdoe",
      "jdoe",
    )
    expect(text).toBe(
      "~/.silicon-harbor <user> https://<redacted>@github.ibm.com/x <redacted-token>",
    )
  })

  it("summarises environments and the focused log", () => {
    const text = buildDiagnostics({
      app: {
        appVersion: "0.1.0",
        electronVersion: "44",
        platform: "linux",
        arch: "x64",
        devsyPath: "/opt/x/devsy",
      },
      devsyVersion: "v1.27.1",
      devsyHome: "/home/jdoe/.silicon-harbor",
      homeDir: "/home/jdoe",
      environments: [
        {
          id: "core-rtl",
          name: "core-rtl",
          repoUrl: "https://github.ibm.com/chipdev/core-rtl",
          ide: "vscode",
          state: "failed",
          operation: {
            id: "op",
            kind: "create",
            state: "failed",
            steps: [{ id: "start", state: "failed" }],
            error: {
              code: "registry-auth",
              cliCode: "BUILD_FAILED_RECOVERABLE",
              title: "Expired",
              message: "m",
            },
            startedAt: "t0",
          },
        },
      ],
      focus: {
        id: "core-rtl",
        log: [{ ts: "t1", level: "error", text: "pull denied" }],
      },
    })
    expect(text).toContain("Devsy home: ~/.silicon-harbor")
    expect(text).toContain("error: registry-auth [BUILD_FAILED_RECOVERABLE]")
    expect(text).toContain("t1 ERROR pull denied")
  })
})

describe("terminalCommands", () => {
  const base = {
    devsyPath: "/Applications/Silicon Harbor.app/Contents/Resources/bin/devsy",
    devsyHome: "/Users/u/.silicon-harbor",
    workspaceId: "core-rtl",
  }

  it("uses Terminal.app via osascript on macOS, quoting paths with spaces", () => {
    const [cmd] = terminalCommands({ ...base, platform: "darwin" })
    expect(cmd.command).toBe("osascript")
    expect(cmd.args[1]).toContain(shQuote(base.devsyPath).replace(/"/g, '\\"'))
    expect(cmd.args[1]).toContain("workspace")
  })

  it("prefers Windows Terminal with a cmd fallback", () => {
    const cmds = terminalCommands({
      ...base,
      platform: "win32",
      devsyPath: "C:\\Program Files\\Silicon Harbor\\resources\\bin\\devsy.exe",
    })
    expect(cmds.map((c) => c.command)).toEqual(["wt.exe", "cmd.exe"])
    expect(cmds[0].args).toContain("ssh")
  })

  it("tries $TERMINAL, then Fedora's terminals", () => {
    const cmds = terminalCommands({
      ...base,
      platform: "linux",
      preferredTerminal: "foot",
    })
    expect(cmds.map((c) => c.command)).toEqual([
      "foot",
      "ptyxis",
      "gnome-terminal",
      "konsole",
      "x-terminal-emulator",
      "xterm",
    ])
    expect(cmds[2].args).toEqual([
      "--",
      base.devsyPath,
      "workspace",
      "ssh",
      "core-rtl",
      "--home",
      base.devsyHome,
    ])
  })
})

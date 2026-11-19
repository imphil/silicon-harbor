// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { IpcChannel } from "../../shared/api"
import { DevsyClient } from "../devsy/client"
import { EnvironmentService } from "../environments"
import { registerIpc } from "../ipc"
import { LogStore } from "../log-store"
import { SettingsStore } from "../settings-store"
import { FixtureCli, fixture } from "./fixtures"

const dir = mkdtempSync(join(tmpdir(), "sh-ipc-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const handlers = new Map<
  string,
  (event: unknown, ...args: unknown[]) => unknown
>()
const cli = new FixtureCli((args) =>
  args[0] === "--version"
    ? { name: "v", stdout: "v1.27.1\n", stderr: "", code: 0 }
    : fixture("d4-list-after-delete"),
)
const client = new DevsyClient(cli)
const settings = new SettingsStore(join(dir, "settings.json"))
const environments = new EnvironmentService({
  client,
  logs: new LogStore(join(dir, "logs")),
  settings: () => settings.get(),
  onChange: () => {},
  onLog: () => {},
})
let clipboard = ""
registerIpc({
  ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
  appInfo: () => ({
    appVersion: "0.1.0",
    electronVersion: "44",
    platform: "linux",
    arch: "x64",
    devsyPath: null,
  }),
  environments,
  settings,
  client,
  devsyHome: "/tmp/sh-home",
  writeClipboard: (text) => {
    clipboard = text
  },
})

const call = (channel: string, ...args: unknown[]) =>
  Promise.resolve().then(() => {
    const fn = handlers.get(channel)
    if (!fn) throw new Error(`no handler for ${channel}`)
    return fn({}, ...args)
  })

describe("IPC", () => {
  it("registers a handler for every request channel", () => {
    const requests = Object.values(IpcChannel).filter(
      (c) => !c.startsWith("evt:"),
    )
    for (const channel of requests) expect(handlers.has(channel)).toBe(true)
  })

  it("rejects malformed ids before they reach the CLI", async () => {
    const before = cli.calls.length
    await expect(call(IpcChannel.envStop, "../etc")).rejects.toThrow()
    await expect(call(IpcChannel.envStart, "--force")).rejects.toThrow()
    expect(cli.calls.length).toBe(before)
  })

  it("validates create requests strictly", async () => {
    await expect(
      call(IpcChannel.envCreate, {
        repoUrl: "https://github.ibm.com/a/b",
        extra: 1,
      }),
    ).rejects.toThrow()
    await expect(
      call(IpcChannel.envCreate, {
        repoUrl: "https://github.ibm.com/a/b",
        branch: "x; rm -rf",
      }),
    ).rejects.toThrow()
    await expect(
      call(IpcChannel.envCreate, {
        repoUrl: "https://github.ibm.com/a/b",
        ide: "emacs",
      }),
    ).rejects.toThrow()
  })

  it("reads and updates settings", async () => {
    await expect(
      call(IpcChannel.settingsUpdate, { defaultIde: "codium" }),
    ).resolves.toMatchObject({ defaultIde: "codium" })
    await expect(call(IpcChannel.settingsGet)).resolves.toMatchObject({
      defaultIde: "codium",
    })
  })

  it("has no requirements yet (M2)", async () => {
    await expect(call(IpcChannel.reqCheck)).resolves.toEqual([])
    await expect(call(IpcChannel.reqFix, "xquartz")).rejects.toThrow(
      /not available yet/,
    )
  })

  it("copies diagnostics to the clipboard", async () => {
    await call(IpcChannel.diagnosticsCopy)
    expect(clipboard).toContain("Silicon Harbor diagnostics")
    expect(clipboard).toContain("Devsy: v1.27.1")
  })
})

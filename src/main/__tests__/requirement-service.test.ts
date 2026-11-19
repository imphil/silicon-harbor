// @vitest-environment node
import { describe, expect, it } from "vitest"
import type { RequirementStatus } from "../../shared/api"
import { loadManifest } from "../installers/manifest"
import { RequirementService } from "../requirements/service"
import type { Requirement } from "../requirements/types"
import { FakeHost } from "./fake-host"

const PENDING = "/profile/requirements-pending.json"

function setup(requirements: Requirement[], bootTime = 1_000_000) {
  const host = new FakeHost({ platform: "darwin" })
  const events: RequirementStatus[][] = []
  let boot = bootTime
  const service = new RequirementService({
    host,
    manifest: loadManifest(),
    binDir: "/bin-dir",
    settings: () => ({
      defaultIde: "vscode",
      autoUpdateCheck: true,
      firstRunDone: true,
    }),
    pendingFile: PENDING,
    bootTime: () => boot,
    onChange: (list) => events.push(list),
    requirements,
    sleep: async () => {},
  })
  return {
    host,
    service,
    events,
    reboot: (at: number) => {
      boot = at
    },
  }
}

/** A requirement whose state flips to ok after its fix ran. */
function fixable(
  outcome: { needsRelogin?: boolean; needsReboot?: boolean } = {},
  okAfterFix = true,
): Requirement & { fixed: boolean } {
  const req = {
    id: "xquartz" as const,
    fixed: false as boolean,
    async check(ctx) {
      if (req.fixed && okAfterFix && ctx.pending === undefined) {
        return { id: "xquartz", title: "XQuartz", state: "ok", detail: "ok" }
      }
      if (req.fixed && ctx.pending) {
        return {
          id: "xquartz",
          title: "XQuartz",
          state: "warn",
          detail: `pending ${ctx.pending}`,
        }
      }
      return {
        id: "xquartz",
        title: "XQuartz",
        state: "missing",
        detail: "missing",
        fix: { label: "Install" },
      }
    },
    async fix(ctx) {
      ctx.progress("Downloading…")
      req.fixed = true
      return outcome
    },
  } satisfies Requirement & { fixed: boolean }
  return req
}

describe("RequirementService", () => {
  it("runs every check and reports a failing check as a warning", async () => {
    const broken: Requirement = {
      id: "ide",
      async check() {
        throw new Error("boom")
      },
    }
    const { service, events } = setup([fixable(), broken])
    const list = await service.check()
    expect(list.map((s) => [s.id, s.state])).toEqual([
      ["xquartz", "missing"],
      ["ide", "warn"],
    ])
    expect(list[1].detail).toBe("Could not be checked: boom")
    expect(events.at(-1)).toEqual(list)
  })

  it("shows the fix as working with progress, then re-checks", async () => {
    const req = fixable()
    const { service, events } = setup([req])
    await service.check()
    await service.fix("xquartz")
    const states = events.map((e) => `${e[0].state}:${e[0].detail}`)
    expect(states).toContain("working:Working…")
    expect(states).toContain("working:Downloading…")
    expect(states.at(-1)).toBe("ok:ok")
  })

  it("refuses fixes that are not offered or already running", async () => {
    const noFix: Requirement = {
      id: "ide",
      async check() {
        return { id: "ide", title: "IDE", state: "ok", detail: "x" }
      },
    }
    const { service } = setup([noFix])
    await expect(service.fix("ide")).rejects.toThrow(/cannot be fixed/)
    await expect(service.fix("wsl")).rejects.toThrow(/cannot be fixed/)

    let release = () => {}
    const slow: Requirement = {
      id: "xquartz",
      async check() {
        return {
          id: "xquartz",
          title: "XQuartz",
          state: "missing",
          detail: "",
          fix: { label: "Install" },
        }
      },
      fix: () =>
        new Promise((resolve) => {
          release = () => resolve(undefined)
        }),
    }
    const second = setup([slow])
    await second.service.check()
    const first = second.service.fix("xquartz")
    await expect(second.service.fix("xquartz")).rejects.toThrow(/already/)
    release()
    await first
  })

  it("remembers a pending re-login until the check passes", async () => {
    const req = fixable({ needsRelogin: true })
    const { service, host } = setup([req])
    await service.check()
    await service.fix("xquartz")
    expect(JSON.parse(host.files[PENDING]).entries).toEqual({
      xquartz: "relogin",
    })
    expect((await service.check())[0]).toMatchObject({
      state: "warn",
      detail: "pending relogin",
    })
  })

  it("clears a pending entry once its check resolves it", async () => {
    let loggedIn = false
    const req: Requirement = {
      id: "xquartz",
      async check(ctx) {
        if (ctx.pending && loggedIn) ctx.resolvePending()
        return {
          id: "xquartz",
          title: "XQuartz",
          state: "ok",
          detail: ctx.pending && !loggedIn ? "log in again" : "fine",
          fix: ctx.pending ? undefined : { label: "Install" },
        }
      },
      async fix() {
        return { needsRelogin: true }
      },
    }
    const { service, host } = setup([req])
    await service.check()
    await service.fix("xquartz")
    expect((await service.check())[0].detail).toBe("log in again")
    expect(JSON.parse(host.files[PENDING]).entries).toEqual({
      xquartz: "relogin",
    })
    loggedIn = true
    await service.check()
    expect(JSON.parse(host.files[PENDING]).entries).toEqual({})
  })

  it("clears pending entries after a reboot", async () => {
    const req = fixable({ needsReboot: true })
    const { service, host, reboot } = setup([req])
    await service.check()
    await service.fix("xquartz")
    expect(JSON.parse(host.files[PENDING]).entries).toEqual({
      xquartz: "reboot",
    })
    reboot(2_000_000)
    const list = await service.check()
    expect(list[0].state).toBe("ok")
    expect(JSON.parse(host.files[PENDING]).entries).toEqual({})
  })

  it("restores the real state when a fix fails", async () => {
    const failing: Requirement = {
      id: "xquartz",
      async check() {
        return {
          id: "xquartz",
          title: "XQuartz",
          state: "missing",
          detail: "missing",
          fix: { label: "Install" },
        }
      },
      async fix() {
        throw new Error("download failed")
      },
    }
    const { service, events } = setup([failing])
    await service.check()
    await expect(service.fix("xquartz")).rejects.toThrow("download failed")
    expect(events.at(-1)?.[0].state).toBe("missing")
  })
})

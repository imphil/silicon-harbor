import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Environment, SiliconHarborApi } from "$shared/api"
import { createMockApi } from "./mock-api"

/** Runs all pending timers and returns the latest environment list. */
async function settle(api: SiliconHarborApi): Promise<Environment[]> {
  await vi.runAllTimersAsync()
  // listEnvironments itself waits on a (fake) timer.
  const list = api.listEnvironments()
  await vi.runAllTimersAsync()
  return list
}

describe("createMockApi", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("seeds running, stopped and failed environments by default", async () => {
    const api = createMockApi()
    const list = await settle(api)
    expect(list.map((e) => [e.id, e.state])).toEqual([
      ["core-rtl", "running"],
      ["scan-flows", "stopped"],
      ["cache-tb", "failed"],
    ])
    const failed = list.find((e) => e.id === "cache-tb")
    expect(failed?.operation?.error?.code).toBe("registry-auth")
  })

  it("starts empty with first-run settings and issues in the first-run scenario", async () => {
    const api = createMockApi({ scenario: "first-run", platform: "linux" })
    expect(await settle(api)).toEqual([])
    expect((await api.getSettings()).firstRunDone).toBe(false)
    const pending = api.checkRequirements()
    await vi.runAllTimersAsync()
    const reqs = await pending
    expect(reqs.map((r) => r.id)).not.toContain("git-credentials")
    expect(reqs.filter((r) => r.state !== "ok").length).toBeGreaterThan(0)
  })

  it("walks a create through all five steps and ends running", async () => {
    const api = createMockApi({ scenario: "empty" })
    const seen = new Set<string>()
    api.onEnvironmentsChanged((envs) => {
      for (const s of envs[0]?.operation?.steps ?? [])
        if (s.state === "active") seen.add(s.id)
    })
    const { id } = await createAndSubmit(
      api,
      "https://github.ibm.com/chipdev/core-rtl",
    )
    const env = (await settle(api)).find((e) => e.id === id)
    expect(env?.state).toBe("running")
    expect(env?.operation?.state).toBe("succeeded")
    expect([...seen]).toEqual(["check", "clone", "start", "prepare", "ide"])
    expect((await api.getLog(id)).length).toBeGreaterThan(3)
  })

  it("fails a create with a registry error once, then retries successfully", async () => {
    const api = createMockApi({ scenario: "empty" })
    const { id } = await createAndSubmit(
      api,
      "https://github.ibm.com/x/denied-repo",
    )
    let env = (await settle(api)).find((e) => e.id === id)
    expect(env?.state).toBe("failed")
    expect(env?.operation?.error?.code).toBe("registry-auth")
    expect(env?.operation?.steps.find((s) => s.id === "start")?.state).toBe(
      "failed",
    )

    await api.startEnvironment(id)
    env = (await settle(api)).find((e) => e.id === id)
    expect(env?.state).toBe("running")
  })

  it("fails the clone for missing repositories and retries the whole create", async () => {
    const api = createMockApi({ scenario: "empty" })
    const { id } = await createAndSubmit(
      api,
      "https://github.ibm.com/x/missing",
    )
    let env = (await settle(api)).find((e) => e.id === id)
    expect(env?.operation?.error?.code).toBe("clone-failed")
    await api.startEnvironment(id)
    env = (await settle(api)).find((e) => e.id === id)
    expect(env?.operation?.kind).toBe("create")
    expect(env?.state).toBe("running")
  })

  it("cancels a running create and leaves a stopped environment", async () => {
    const api = createMockApi({ scenario: "empty" })
    const { id } = await createAndSubmit(api, "https://github.ibm.com/x/y")
    await vi.advanceTimersByTimeAsync(500)
    await api.cancelOperation(id)
    const env = (await settle(api)).find((e) => e.id === id)
    expect(env?.state).toBe("stopped")
    expect(env?.operation?.state).toBe("cancelled")
  })

  it("stops, starts and deletes", async () => {
    const api = createMockApi()
    await api.stopEnvironment("core-rtl")
    expect((await settle(api)).find((e) => e.id === "core-rtl")?.state).toBe(
      "stopped",
    )
    await api.startEnvironment("core-rtl")
    const started = (await settle(api)).find((e) => e.id === "core-rtl")
    expect(started?.state).toBe("running")
    expect(started?.operation?.steps.find((s) => s.id === "clone")?.state).toBe(
      "skipped",
    )
    await api.deleteEnvironment("core-rtl")
    expect((await settle(api)).map((e) => e.id)).not.toContain("core-rtl")
  })

  it("refuses to open the IDE of a stopped environment", async () => {
    const api = createMockApi()
    await expect(api.openInIde("scan-flows")).rejects.toThrow(/not running/)
  })

  it("fixes requirements and notifies listeners", async () => {
    const api = createMockApi({ scenario: "first-run", platform: "mac" })
    const updates: string[] = []
    api.onRequirementsChanged((reqs) =>
      updates.push(reqs.find((r) => r.id === "xquartz")?.state ?? ""),
    )
    const fixing = api.fixRequirement("xquartz")
    await vi.runAllTimersAsync()
    await fixing
    expect(updates).toEqual(["working", "ok"])
  })

  it("names duplicate environments uniquely", async () => {
    const api = createMockApi({ scenario: "empty" })
    const a = await createAndSubmit(api, "https://github.ibm.com/x/core")
    const b = await createAndSubmit(api, "https://github.ibm.com/y/core")
    expect([a.id, b.id]).toEqual(["core", "core-2"])
  })
})

async function createAndSubmit(api: SiliconHarborApi, repoUrl: string) {
  const pending = api.createEnvironment({ repoUrl })
  await vi.advanceTimersByTimeAsync(250)
  return pending
}

// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Environment, LogLine } from "../../shared/api"
import { DevsyClient } from "../devsy/client"
import { BusyError, EnvironmentService } from "../environments"
import { LogStore } from "../log-store"
import { DEFAULT_SETTINGS } from "../settings-store"
import { type Fixture, FixtureCli, fixture } from "./fixtures"

const REPO = "https://github.com/microsoft/vscode-remote-try-python"

const inline = (stdout: string, code = 0, stderr = ""): Fixture => ({
  name: "inline",
  stdout,
  stderr,
  code,
})

/** Command prefix → fixture; later stages can be switched via `set`. */
class Script {
  private readonly map = new Map<string, Fixture>()
  set(prefix: string, f: Fixture | string): this {
    this.map.set(prefix, typeof f === "string" ? fixture(f) : f)
    return this
  }
  respond = (args: string[]): Fixture | undefined => {
    const cmd = args.join(" ")
    let best: string | undefined
    for (const prefix of this.map.keys())
      if (cmd.startsWith(prefix) && (!best || prefix.length > best.length))
        best = prefix
    return best ? this.map.get(best) : undefined
  }
}

const dirs: string[] = []
const services: EnvironmentService[] = []
afterEach(() => {
  for (const s of services.splice(0)) s.stop()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function setup(script: Script) {
  const dir = mkdtempSync(join(tmpdir(), "sh-env-"))
  dirs.push(dir)
  const cli = new FixtureCli(script.respond)
  const snapshots: Environment[][] = []
  const logs: Array<{ id: string; line: LogLine }> = []
  const service = new EnvironmentService({
    client: new DevsyClient(cli),
    logs: new LogStore(join(dir, "logs")),
    settings: () => DEFAULT_SETTINGS,
    onChange: (envs) => snapshots.push(envs),
    onLog: (id, line) => logs.push({ id, line }),
    listIntervalMs: 3_600_000,
    statusIntervalMs: 3_600_000,
  })
  services.push(service)
  const env = (id: string) => service.get(id)
  const until = async (cond: () => boolean, what: string) => {
    for (let i = 0; i < 2000; i++) {
      if (cond()) return
      await new Promise((r) => setTimeout(r, 0))
    }
    throw new Error(`timed out waiting for ${what}`)
  }
  return { cli, service, snapshots, logs, env, until }
}

/** The baseline: docker provider present, nothing else. */
function baseScript(): Script {
  return new Script()
    .set("provider list", "provider-list")
    .set("provider use", "provider-use-docker")
    .set("workspace task list", inline("[]"))
    .set("workspace list", "d4-list-after-delete")
    .set("workspace logs", "l2-setup-logs-read")
}

describe("EnvironmentService", () => {
  it("creates an environment and reports progress until it runs", async () => {
    const script = baseScript()
      .set("workspace up", "a-up-submit")
      .set("workspace task logs", "b-task-logs-follow")
      .set("workspace status", "e2-status-running")
    const { cli, service, snapshots, logs, env, until } = setup(script)

    const { id } = await service.create({
      repoUrl: REPO,
      name: "try-python",
      ide: "bob",
    })
    expect(id).toBe("try-python")
    expect(env(id)?.state).toBe("busy")
    script.set("workspace list", "d2-list-running")

    await until(() => env(id)?.state === "running", "running")
    const up = cli.calls.find((c) => c[1] === "up")
    expect(up).toEqual([
      "workspace",
      "up",
      REPO,
      "--id",
      "try-python",
      "--display-name",
      "try-python",
      "--ide",
      "bob",
      "--ide-launch",
      "auto",
      "--detach",
    ])
    // Progress was visible on the way.
    const activeSteps = new Set(
      snapshots.flatMap(
        (s) =>
          s
            .find((e) => e.id === id)
            ?.operation?.steps.filter((st) => st.state === "active")
            .map((st) => st.id) ?? [],
      ),
    )
    expect([...activeSteps]).toEqual(
      expect.arrayContaining(["clone", "start", "prepare", "ide"]),
    )
    // Success clears the operation; the log has the result and the setup output.
    expect(env(id)?.operation).toBeUndefined()
    await until(
      () => logs.some((l) => l.line.text === "── Setup output ──"),
      "setup log",
    )
    expect(logs.map((l) => l.line.text)).toContain("Environment ready.")
    expect(service.getLog(id).length).toBeGreaterThan(5)
  })

  it("adds and initialises the docker provider on first use", async () => {
    const script = baseScript()
      .set("provider list", inline("{}"))
      .set("provider add", "provider-add-docker")
      .set("provider init", "provider-init-docker")
      .set("workspace up", "a-up-submit")
      .set("workspace task logs", "b-task-logs-follow")
      .set("workspace status", "e2-status-running")
    const { cli, service, env, until } = setup(script)
    const { id } = await service.create({ repoUrl: REPO, name: "try-python" })
    await until(() => env(id)?.operation === undefined, "finish")
    const provider = cli.calls
      .filter((c) => c[0] === "provider")
      .map((c) => c.slice(0, 2).join(" "))
    expect(provider).toEqual([
      "provider list",
      "provider add",
      "provider init",
      "provider use",
    ])
  })

  it("keeps a failed clone as a placeholder with a Git sign-in error", async () => {
    const script = baseScript()
      .set("workspace up", "i1-clone-fail-submit")
      .set("workspace task logs", "i2-clone-fail-logs")
    const { cli, service, env, until } = setup(script)
    const { id } = await service.create({
      repoUrl:
        "https://github.com/devsy-org/silicon-harbor-does-not-exist-4711",
    })
    await until(() => env(id)?.state === "failed", "failed")
    const op = env(id)?.operation
    expect(op?.state).toBe("failed")
    expect(op?.error?.code).toBe("git-auth")
    expect(op?.steps.find((s) => s.id === "clone")?.state).toBe("failed")

    // The placeholder survives a refresh and deleting it needs no CLI call.
    await service.refreshList()
    expect(env(id)).not.toBeNull()
    const before = cli.calls.length
    await service.delete(id)
    expect(env(id)).toBeNull()
    expect(cli.calls.length).toBe(before)
  })

  it("retries a failed creation with the same id", async () => {
    const script = baseScript()
      .set("workspace up", "i1-clone-fail-submit")
      .set("workspace task logs", "i2-clone-fail-logs")
    const { cli, service, env, until } = setup(script)
    const { id } = await service.create({ repoUrl: REPO, branch: "main" })
    await until(() => env(id)?.state === "failed", "failed")
    await service.startEnv(id)
    await until(
      () =>
        env(id)?.state === "failed" &&
        cli.calls.filter((c) => c[1] === "up").length === 2,
      "retry",
    )
    const ups = cli.calls.filter((c) => c[1] === "up")
    expect(ups[1].slice(0, 5)).toEqual([
      "workspace",
      "up",
      `${REPO}@main`,
      "--id",
      id,
    ])
  })

  it("shows a failed image pull on the download step", async () => {
    const script = baseScript()
      .set("workspace up", "a-up-submit")
      .set("workspace task logs", "j2-image-fail-logs")
      .set("workspace status", "j3-image-fail-status")
    const { service, env, until } = setup(script)
    const { id } = await service.create({ repoUrl: REPO, name: "image-fail" })
    script.set("workspace list", "j4-image-fail-list")
    await until(() => env(id)?.operation?.state === "failed", "failed op")
    await service.refreshStatuses([id])
    expect(env(id)?.state).toBe("failed")
    expect(env(id)?.operation?.error?.code).toBe("image-access-denied")
    expect(env(id)?.operation?.steps.find((s) => s.id === "start")?.state).toBe(
      "failed",
    )
  })

  it("cancels through the task and reports the environment as not usable", async () => {
    const script = baseScript()
      .set(
        "workspace list",
        inline(
          '[{"id":"cancel-me","source":{"gitRepository":"https://github.com/a/b"}}]',
        ),
      )
      .set("workspace status", "k4-cancel-status")
      .set("workspace up", "k1-cancel-submit")
      .set("workspace task logs", "k2-cancel-logs-follow")
      .set("workspace task cancel", "k3-task-cancel")
    const { cli, service, env, until } = setup(script)
    await service.refreshList()
    await service.startEnv("cancel-me")
    await until(() => cli.calls.some((c) => c[2] === "logs"), "following")
    await service.cancel("cancel-me")
    await until(
      () => env("cancel-me")?.operation?.state === "cancelled",
      "cancelled",
    )
    expect(
      cli.calls.some(
        (c) => c.slice(0, 3).join(" ") === "workspace task cancel",
      ),
    ).toBe(true)
    // Devsy says Running after the cancel; we do not trust it.
    await service.refreshStatuses(["cancel-me"])
    expect(env("cancel-me")?.state).toBe("failed")
  })

  it("stops and deletes an environment", async () => {
    const script = baseScript()
      .set("workspace list", "d2-list-running")
      .set("workspace status", "e2-status-running")
      .set("workspace stop", "f-stop")
      .set("workspace delete", "h-delete")
    const { service, env, until } = setup(script)
    await service.refreshList()
    expect(env("try-python")?.state).toBe("running")

    script.set("workspace status", "e3-status-stopped")
    await service.stopEnv("try-python")
    await until(() => env("try-python")?.state === "stopped", "stopped")

    script
      .set("workspace list", "d4-list-after-delete")
      .set("workspace status", "e4-status-after-delete")
    await service.delete("try-python")
    await until(() => env("try-python") === null, "deleted")
  })

  it("refuses a second operation while one runs", async () => {
    const script = baseScript()
      .set("workspace list", "d3-list-stopped")
      .set("workspace status", "e3-status-stopped")
      .set("workspace up", "g1-restart-submit")
      .set("workspace task logs", "g2-restart-logs-follow")
    const { service, env, until } = setup(script)
    await service.refreshList()
    await service.startEnv("try-python")
    await expect(service.stopEnv("try-python")).rejects.toBeInstanceOf(
      BusyError,
    )
    script.set("workspace status", "e2-status-running")
    await until(() => env("try-python")?.state === "running", "running")
  })

  it("re-attaches to a task that was running before the app started", async () => {
    const script = baseScript()
      .set("workspace list", "d1-list-during-up")
      .set("workspace status", "e1-status-during-up")
      .set("workspace task list", "c-task-list-during-up")
      .set("workspace task logs", "b-task-logs-follow")
    const { cli, service, env, until } = setup(script)
    await service.start()
    expect(cli.calls).toContainEqual([
      "workspace",
      "task",
      "logs",
      "iqauycmxoilv",
      "--follow",
    ])
    script.set("workspace status", "e2-status-running")
    await until(() => env("try-python")?.state === "running", "running")
  })

  it("rejects invalid repository URLs", async () => {
    const { service } = setup(baseScript())
    await expect(
      service.create({ repoUrl: "git@github.ibm.com:a/b.git" }),
    ).rejects.toThrow(/ssh/)
  })
})

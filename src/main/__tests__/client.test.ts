// @vitest-environment node
import { describe, expect, it } from "vitest"
import { DevsyClient, DevsyError } from "../devsy/client"
import type { Envelope } from "../devsy/schemas"
import { parseLine } from "../devsy/schemas"
import { FixtureCli, fixture } from "./fixtures"

const by =
  (map: Record<string, string>) =>
  (args: string[]): ReturnType<typeof fixture> | undefined => {
    const key = Object.keys(map).find((k) => args.join(" ").startsWith(k))
    return key ? fixture(map[key]) : undefined
  }

describe("parseLine", () => {
  it("classifies envelopes, zap log lines and plain text", () => {
    expect(parseLine('{"kind":"task","id":"abc"}')).toEqual({
      type: "envelope",
      envelope: { kind: "task", id: "abc" },
    })
    expect(
      parseLine(
        '{"level":"info","ts":"2026","msg":"default provider: docker"}',
      ),
    ).toMatchObject({
      type: "log",
      record: { msg: "default provider: docker" },
    })
    expect(parseLine("Cloning into 'x'...")).toEqual({
      type: "text",
      text: "Cloning into 'x'...",
    })
    expect(parseLine("   ")).toBeUndefined()
  })

  it("parses every line of every recorded stream without throwing", () => {
    for (const name of [
      "b-task-logs-follow",
      "j2-image-fail-logs",
      "k2-cancel-logs-follow",
      "f-stop",
      "h-delete",
      "x-agent-socket-path-too-long-logs",
    ]) {
      const f = fixture(name)
      for (const line of `${f.stdout}\n${f.stderr}`.split("\n"))
        expect(() => parseLine(line)).not.toThrow()
    }
  })
})

describe("DevsyClient", () => {
  it("asks for a volume clone with --clone-into-volume", async () => {
    const cli = new FixtureCli(by({ "workspace up": "a-up-submit" }))
    await new DevsyClient(cli).submitUp({ source: "x", cloneIntoVolume: true })
    expect(cli.calls[0]).toEqual([
      "workspace",
      "up",
      "x",
      "--clone-into-volume",
      "--detach",
    ])
  })

  it("submits a detached up with id, ide and launch mode", async () => {
    const cli = new FixtureCli(by({ "workspace up": "a-up-submit" }))
    const task = await new DevsyClient(cli).submitUp({
      source: "https://github.com/microsoft/vscode-remote-try-python@main",
      id: "try-python",
      ide: "vscode",
      ideLaunch: "auto",
    })
    expect(task.id).toBe("iqauycmxoilv")
    expect(cli.calls[0]).toEqual([
      "workspace",
      "up",
      "https://github.com/microsoft/vscode-remote-try-python@main",
      "--id",
      "try-python",
      "--ide",
      "vscode",
      "--ide-launch",
      "auto",
      "--detach",
    ])
  })

  it("lists workspaces from the recorded output", async () => {
    const cli = new FixtureCli(by({ "workspace list": "d2-list-running" }))
    const [ws] = await new DevsyClient(cli).listWorkspaces()
    expect(ws).toMatchObject({
      id: "try-python",
      effectiveDisplayName: "try-python",
      source: {
        gitRepository: "https://github.com/microsoft/vscode-remote-try-python",
      },
      ide: { name: "none" },
    })
  })

  it("reads workspace status and returns null when the workspace is gone", async () => {
    const running = new DevsyClient(
      new FixtureCli(by({ "workspace status": "e2-status-running" })),
    )
    expect((await running.status("try-python"))?.state).toBe("Running")
    const gone = new DevsyClient(
      new FixtureCli(by({ "workspace status": "e4-status-after-delete" })),
    )
    expect(await gone.status("try-python")).toBeNull()
  })

  it("keeps the error of a failed workspace from status", async () => {
    const client = new DevsyClient(
      new FixtureCli(by({ "workspace status": "j3-image-fail-status" })),
    )
    const status = await client.status("image-fail")
    expect(status?.state).toBe("Failed")
    expect(status?.lastOperation?.error?.code).toBe("BUILD_FAILED_RECOVERABLE")
  })

  it("parses task records without exposing the host environment", async () => {
    const client = new DevsyClient(
      new FixtureCli(by({ "workspace task list": "c2-task-list-after-up" })),
    )
    const [task] = await client.listTasks()
    expect(task).toMatchObject({
      id: "iqauycmxoilv",
      command: "up",
      workspaceId: "try-python",
    })
    expect(JSON.stringify(task)).not.toMatch(/SubstitutionContext|"Env"/)
  })

  it("reads setup output records", async () => {
    const client = new DevsyClient(
      new FixtureCli(by({ "workspace logs": "l2-setup-logs-read" })),
    )
    const log = await client.readSetupLog("try-python")
    expect(log.records.some((r) => r.kind === "output" && r.text)).toBe(true)
  })

  it("lists provider names", async () => {
    const client = new DevsyClient(
      new FixtureCli(by({ "provider list": "provider-list" })),
    )
    expect(await client.providerNames()).toContain("docker")
  })

  it("throws a DevsyError with the structured cliError on failure", async () => {
    const client = new DevsyClient(
      new FixtureCli(by({ "workspace up": "i2-clone-fail-logs" })),
    )
    const error = await client
      .submitUp({ source: "x" })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DevsyError)
    expect((error as DevsyError).cliError?.code).toBe("UNKNOWN")
    expect((error as DevsyError).exitCode).toBe(1)
  })

  it("streams envelopes of a followed task", async () => {
    const client = new DevsyClient(
      new FixtureCli(by({ "workspace task logs": "b-task-logs-follow" })),
    )
    const kinds: Envelope["kind"][] = []
    const handle = client.followTask("iqauycmxoilv", {
      onEnvelope: (e) => kinds.push(e.kind),
      onLog: () => {},
      onText: () => {},
    })
    expect(await handle.done).toBe(0)
    expect(kinds.at(-1)).toBe("result")
    expect(kinds.filter((k) => k === "status").length).toBeGreaterThan(10)
  })
})

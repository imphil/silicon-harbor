// @vitest-environment node
/**
 * Opt-in end-to-end check against the real Devsy CLI and the local Docker:
 *
 *   SH_INTEGRATION=1 SH_DEVSY_BIN=resources/bin/linux-x64/devsy \
 *     npx vitest run src/main/__tests__/integration.test.ts
 *
 * Creates, stops and deletes a public example environment in a throwaway
 * DEVSY_HOME under /tmp (short path: socket limit), with --ide none and a
 * private ssh config, so neither ~/.devsy nor ~/.ssh/config is touched.
 */
import { createHash } from "node:crypto"
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import type { Environment } from "../../shared/api"
import { DevsyClient } from "../devsy/client"
import { buildCliEnv } from "../devsy/env"
import { CliRunner } from "../devsy/runner"
import { EnvironmentService } from "../environments"
import { LogStore } from "../log-store"
import { DEFAULT_SETTINGS } from "../settings-store"

const enabled = process.env.SH_INTEGRATION === "1"
const REPO = "https://github.com/microsoft/vscode-remote-try-python"

function fingerprint(path: string): string {
  if (!existsSync(path)) return "missing"
  const s = statSync(path)
  if (s.isDirectory()) return `dir:${s.mtimeMs}`
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

describe.skipIf(!enabled)("integration: real Devsy + Docker", () => {
  const home = mkdtempSync("/tmp/sh-")
  const guarded = [join(homedir(), ".devsy"), join(homedir(), ".ssh", "config")]
  const before = guarded.map(fingerprint)
  let service: EnvironmentService | undefined
  let runner: CliRunner | undefined

  afterAll(() => {
    service?.stop()
    runner?.killAll()
    rmSync(home, { recursive: true, force: true })
    expect(guarded.map(fingerprint)).toEqual(before)
  })

  it(
    "creates, stops and deletes an environment",
    async () => {
      const bin = resolve(
        process.env.SH_DEVSY_BIN ?? "resources/bin/linux-x64/devsy",
      )
      runner = new CliRunner({
        binaryPath: bin,
        env: buildCliEnv({
          hostEnv: process.env,
          platform: process.platform,
          homeDir: homedir(),
          devsyHome: join(home, "devsy"),
        }),
      })
      const states: string[] = []
      let latest: Environment | undefined
      service = new EnvironmentService({
        client: new DevsyClient(runner),
        logs: new LogStore(join(home, "logs")),
        settings: () => DEFAULT_SETTINGS,
        ideOverride: "none",
        ideLaunch: "skip",
        sshConfigPath: join(home, "ssh_config"),
        listIntervalMs: 3_600_000,
        statusIntervalMs: 3_600_000,
        onChange: (envs) => {
          latest = envs.find((e) => e.id === "sh-it-try-python")
          const summary = latest
            ? `${latest.state}:${latest.operation?.steps.find((s) => s.state === "active")?.id ?? "-"}`
            : "gone"
          if (states.at(-1) !== summary) states.push(summary)
        },
        onLog: () => {},
      })
      const until = async (cond: () => boolean, what: string, ms: number) => {
        const end = Date.now() + ms
        while (!cond()) {
          if (Date.now() > end)
            throw new Error(
              `timed out waiting for ${what}; states: ${states.join(" → ")}; log: ${service
                ?.getLog("sh-it-try-python")
                .slice(-15)
                .map((l) => l.text)
                .join(" | ")}`,
            )
          await new Promise((r) => setTimeout(r, 250))
        }
      }

      const { id } = await service.create({
        repoUrl: REPO,
        name: "sh-it-try-python",
      })
      expect(id).toBe("sh-it-try-python")
      await until(
        () => latest?.state === "running" && !latest.operation,
        "running",
        600_000,
      )

      await service.stopEnv(id)
      await until(
        () => latest?.state === "stopped" && !latest.operation,
        "stopped",
        120_000,
      )

      await service.startEnv(id)
      await until(
        () => latest?.state === "running" && !latest.operation,
        "restarted",
        300_000,
      )

      await service.delete(id)
      await until(() => service?.get(id) === null, "deleted", 120_000)

      // The visible progress went through the expected steps.
      expect(states).toEqual(
        expect.arrayContaining([
          "busy:clone",
          "busy:start",
          "busy:prepare",
          "running:-",
          "stopped:-",
        ]),
      )
      console.log(`states: ${states.join(" → ")}`)
    },
    20 * 60_000,
  )
})

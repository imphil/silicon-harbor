// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { CliRunner, type CliStream } from "../devsy/runner"

const dir = mkdtempSync(join(tmpdir(), "sh-runner-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** A fake devsy: echoes its args/env as JSON, emits lines, honours a few commands. */
const script = join(dir, "fake-devsy.mjs")
writeFileSync(
  script,
  `
const args = process.argv.slice(2)
const cmd = args[0]
if (cmd === "echo") {
  console.log(JSON.stringify({ args, env: { LC_ALL: process.env.LC_ALL, DEVSY_HOME: process.env.DEVSY_HOME, SECRET: process.env.SECRET ?? null } }))
} else if (cmd === "lines") {
  console.log('{"kind":"status","phase":"a","state":"started"}')
  console.error('{"level":"error","msg":"bad"}')
  console.log("\\u001b[31mred\\u001b[0m")
  process.exit(3)
} else if (cmd === "sleep") {
  console.log("started")
  setTimeout(() => {}, 60000)
}
`,
)

const runner = new CliRunner({
  binaryPath: script,
  env: { PATH: process.env.PATH, LC_ALL: "C", DEVSY_HOME: "/tmp/sh-home" },
})

describe("CliRunner", () => {
  it("appends the protocol flags and passes only the given environment", async () => {
    process.env.SECRET = "do-not-leak"
    const result = await runner.exec(["echo"])
    delete process.env.SECRET
    const out = JSON.parse(result.stdout) as {
      args: string[]
      env: Record<string, string | null>
    }
    expect(out.args).toEqual([
      "echo",
      "--log-level",
      "info",
      "--log-output",
      "json",
      "--result-format",
      "json",
    ])
    expect(out.env).toEqual({
      LC_ALL: "C",
      DEVSY_HOME: "/tmp/sh-home",
      SECRET: null,
    })
  })

  it("omits --result-format when asked (task logs)", () => {
    expect(
      runner.protocolArgs(["workspace", "task", "logs", "x"], {
        resultFormat: false,
      }),
    ).not.toContain("--result-format")
  })

  it("leaves the arguments alone without protocol flags (devsy --version)", () => {
    expect(
      runner.protocolArgs(["--version"], { protocolFlags: false }),
    ).toEqual(["--version"])
  })

  it("does not duplicate flags given explicitly", () => {
    const args = runner.protocolArgs(["x", "--log-level", "debug"])
    expect(args.filter((a) => a === "--log-level")).toHaveLength(1)
  })

  it("streams stdout and stderr lines, strips ANSI and reports the exit code", async () => {
    const seen: Array<[string, CliStream]> = []
    const handle = runner.stream(["lines"], (line, stream) =>
      seen.push([line, stream]),
    )
    expect(await handle.done).toBe(3)
    expect(seen).toContainEqual([
      '{"kind":"status","phase":"a","state":"started"}',
      "stdout",
    ])
    expect(seen).toContainEqual(['{"level":"error","msg":"bad"}', "stderr"])
    expect(seen).toContainEqual(["red", "stdout"])
  })

  it("cancels a running process", async () => {
    let started!: () => void
    const ready = new Promise<void>((r) => {
      started = r
    })
    const handle = runner.stream(["sleep"], (line) => {
      if (line === "started") started()
    })
    await ready
    handle.cancel()
    expect(await handle.done).not.toBe(0)
  })

  it("reports a missing binary as a failed run with an error envelope", async () => {
    const missing = new CliRunner({
      binaryPath: join(dir, "no-such-devsy"),
      env: {},
    })
    const result = await missing.exec(["--version"])
    expect(result.code).toBe(-1)
    expect(result.stderr).toContain('"code":"spawn_failed"')
  })
})

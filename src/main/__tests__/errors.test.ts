// @vitest-environment node
import { describe, expect, it } from "vitest"
import { errorFromResult } from "../devsy/client"
import { type Classified, classifyFailure } from "../devsy/errors"
import { fixture } from "./fixtures"

function classifyFixture(name: string): Classified {
  const f = fixture(name)
  const error = errorFromResult(
    { code: f.code, stdout: f.stdout, stderr: f.stderr },
    "failed",
  )
  return classifyFailure({
    code: error.cliError?.code,
    message: error.cliError?.message ?? error.message,
    hint: error.cliError?.hint,
    logErrors: error.logErrors,
  })
}

function code(c: Classified): string {
  return c.cancelled ? "cancelled" : c.error.code
}

describe("error catalog", () => {
  it("recognises a failed clone without access as a Git sign-in problem", () => {
    const c = classifyFixture("i2-clone-fail-logs")
    expect(code(c)).toBe("git-auth")
    if (!c.cancelled) {
      expect(c.step).toBe("clone")
      expect(c.error.cliCode).toBe("UNKNOWN")
      expect(c.error.action).toBe("retry")
    }
  })

  it("recognises a denied image pull from a non-IBM registry", () => {
    const c = classifyFixture("j2-image-fail-logs")
    expect(code(c)).toBe("image-access-denied")
    if (!c.cancelled) expect(c.step).toBe("start")
  })

  it("asks to sign in again when icr.io denies the pull", () => {
    const c = classifyFailure({
      code: "BUILD_FAILED_RECOVERABLE",
      message:
        "build image: get image build info: retrieve image icr.io/chipdev/base:2.1: GET https://icr.io/oauth/token: DENIED: requested access to the resource is denied",
    })
    expect(code(c)).toBe("registry-auth")
    if (!c.cancelled) expect(c.error.action).toBe("sign-in-retry")
  })

  it("recognises an unreachable Docker daemon", () => {
    const c = classifyFixture("m2-docker-unreachable-logs")
    expect(code(c)).toBe("engine-unreachable")
    if (!c.cancelled) expect(c.error.action).toBe("open-settings")
  })

  it("finds the socket-path problem in the stderr log lines", () => {
    expect(code(classifyFixture("x-agent-socket-path-too-long-logs"))).toBe(
      "socket-path-too-long",
    )
  })

  it("treats a cancel as cancelled, not as an error", () => {
    expect(classifyFixture("k2-cancel-logs-follow").cancelled).toBe(true)
  })

  it("recognises a clone failure without auth hints", () => {
    const c = classifyFailure({
      code: "UNKNOWN",
      message:
        "prepare workspace client: inspect remote repository: git clone https://github.ibm.com/x/y /tmp/r: exit status 128: fatal: unable to access 'https://github.ibm.com/x/y/': Could not resolve host: github.ibm.com",
    })
    expect(code(c)).toBe("clone-failed")
  })

  it("falls back to an unknown error that quotes Devsy's first line", () => {
    const c = classifyFailure({ code: "UNKNOWN", message: "boom\nstack" })
    expect(code(c)).toBe("unknown")
    if (!c.cancelled) {
      expect(c.error.message).toBe("Devsy reported: boom")
      expect(c.error.action).toBe("copy-diagnostics")
    }
  })

  it("names the IDE when it cannot be opened", () => {
    const c = classifyFailure(
      { message: "launch ide: resolve executable: bobide not found" },
      { ide: "bob" },
    )
    expect(code(c)).toBe("ide-launch-failed")
    if (!c.cancelled) expect(c.error.title).toBe("IBM Bob could not be opened")
  })
})

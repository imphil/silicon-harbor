// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import type { CredentialsStatus } from "../../shared/api"
import {
  ARTIFACTORY_CHECK_URL,
  checkArtifactoryToken,
  TOKEN_SECRET,
  USER_SECRET,
} from "../credentials/artifactory"
import {
  checkGitHubAccount,
  GitHubSignIn,
  parseApiResponse,
  parseSignInLine,
} from "../credentials/github"
import {
  accountFromCredentials,
  ICR_REGISTRY,
  icrGet,
} from "../credentials/ibmcloud"
import { CredentialService, type SecretStore } from "../credentials/service"
import type { SecretEntry } from "../devsy/schemas"
import { FakeHost, type FakeProcess, fail, ok } from "./fake-host"

const GH = "/usr/bin/gh"
const BIN_DIR = "/home/dev/.local/bin"
const ICR = `${BIN_DIR}/docker-credential-icr`

/** A credential helper answer with an IAM-like JWT (unsigned, test only). */
function icrAnswer(claims: Record<string, unknown>): string {
  const part = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url")
  const jwt = `${part({ alg: "none" })}.${part(claims)}.sig`
  return JSON.stringify({
    ServerURL: "icr.io",
    Username: "iambearer",
    Secret: jwt,
  })
}
const HOSTS = "/home/dev/.config/gh/hosts.yml"
const SIGNED_IN = "github.ibm.com:\n    user: dev\n"
const USER_RESPONSE = [
  "HTTP/2.0 200 OK",
  "Content-Type: application/json; charset=utf-8",
  "X-Oauth-Scopes: gist, read:org, repo",
  "",
  JSON.stringify({ login: "dev", name: "Dev Eloper", email: "dev@ibm.com" }),
].join("\r\n")

function ghHost(extra: Record<string, ReturnType<typeof ok>> = {}) {
  return new FakeHost({
    platform: "linux",
    path: { gh: GH },
    files: { [HOSTS]: SIGNED_IN },
    commands: {
      [`${GH} api --hostname github.ibm.com --include user`]: ok(USER_RESPONSE),
      [`${GH} auth setup-git --hostname github.ibm.com`]: ok(""),
      ...extra,
    },
  })
}

describe("gh output", () => {
  it("reads the one-time code and the page from gh's non-interactive sign-in", () => {
    expect(
      parseSignInLine("! First copy your one-time code: AB12-CD34"),
    ).toEqual({ code: "AB12-CD34" })
    expect(
      parseSignInLine(
        "Open this URL to continue in your web browser: https://github.ibm.com/login/device",
      ),
    ).toEqual({ url: "https://github.ibm.com/login/device" })
    expect(parseSignInLine("✓ Authentication complete.")).toBeUndefined()
  })

  it("reads the account and scopes from `gh api --include user`", () => {
    expect(parseApiResponse(USER_RESPONSE)).toEqual({
      login: "dev",
      name: "Dev Eloper",
      email: "dev@ibm.com",
      scopes: ["gist", "read:org", "repo"],
    })
    expect(parseApiResponse("not a response")).toBeNull()
  })
})

describe("GitHub account check", () => {
  it("returns the account, quietly (no name or email in the setup log)", async () => {
    const host = ghHost()
    const runQuiet = vi.spyOn(host, "run")
    expect(await checkGitHubAccount(host, GH)).toEqual({
      kind: "ok",
      account: { login: "dev", name: "Dev Eloper", email: "dev@ibm.com" },
      scopes: ["gist", "read:org", "repo"],
    })
    expect(runQuiet.mock.calls[0]?.[2]).toMatchObject({ quiet: true })
  })

  it("tells a rejected token from an unreachable host", async () => {
    const key = `${GH} api --hostname github.ibm.com --include user`
    const rejected = ghHost({
      [key]: fail("gh: Bad credentials (HTTP 401)"),
    })
    expect((await checkGitHubAccount(rejected, GH)).kind).toBe("invalid")
    const offline = ghHost({
      [key]: fail("error connecting to github.ibm.com"),
    })
    expect(await checkGitHubAccount(offline, GH)).toEqual({
      kind: "unreachable",
      detail:
        "Could not reach github.ibm.com (error connecting to github.ibm.com).",
    })
    const signedOut = ghHost({
      [key]: fail(
        "To get started with GitHub CLI, please run:  gh auth login",
        4,
      ),
    })
    expect((await checkGitHubAccount(signedOut, GH)).kind).toBe("signed-out")
  })
})

describe("GitHub sign-in", () => {
  const LOGIN = `${GH} auth login --hostname github.ibm.com --git-protocol https --web`

  it("shows the code, opens the page, copies the code and sets up Git", async () => {
    const host = ghHost()
    const clipboard: string[] = []
    const changes: Array<{ active: boolean; code?: string }> = []
    const signIn: GitHubSignIn = new GitHubSignIn({
      host,
      writeClipboard: (text) => clipboard.push(text),
      onChange: () =>
        changes.push({ active: signIn.active, code: signIn.pending?.code }),
    })
    host.onStart[LOGIN] = (p) => {
      p.line("! First copy your one-time code: AB12-CD34")
      p.line(
        "Open this URL to continue in your web browser: https://github.ibm.com/login/device",
      )
      setTimeout(() => {
        p.line("✓ Authentication complete.")
        p.exit(0)
      }, 5)
    }
    const first = signIn.run()
    // A second caller joins the same sign-in.
    expect(signIn.run()).toBe(first)
    await first
    expect(host.starts).toEqual([LOGIN])
    expect(host.opened).toEqual(["https://github.ibm.com/login/device"])
    expect(clipboard).toEqual(["AB12-CD34"])
    expect(host.runs).toContain(
      `${GH} auth setup-git --hostname github.ibm.com`,
    )
    expect(changes).toEqual([
      { active: true, code: undefined },
      { active: true, code: "AB12-CD34" },
      { active: false, code: undefined },
    ])
    expect(signIn.active).toBe(false)
  })

  it("reports gh's last line when the sign-in fails", async () => {
    const host = ghHost()
    host.onStart[LOGIN] = (p) => {
      p.line("error: the device code expired")
      p.exit(1)
    }
    const signIn = new GitHubSignIn({ host, onChange: () => {} })
    await expect(signIn.run()).rejects.toThrow(
      "Signing in to github.ibm.com did not finish: error: the device code expired",
    )
    expect(host.runs).not.toContain(
      `${GH} auth setup-git --hostname github.ibm.com`,
    )
  })

  it("can be cancelled", async () => {
    const host = ghHost()
    host.onStart[LOGIN] = (p) =>
      p.line("! First copy your one-time code: AB12-CD34")
    const signIn = new GitHubSignIn({ host, onChange: () => {} })
    const running = signIn.run()
    await new Promise((r) => setTimeout(r, 5))
    signIn.cancel()
    await expect(running).resolves.toBeUndefined()
    expect(signIn.active).toBe(false)
  })

  it("needs gh", async () => {
    const host = new FakeHost({ platform: "linux" })
    const signIn = new GitHubSignIn({ host, onChange: () => {} })
    await expect(signIn.run()).rejects.toThrow(/not installed/)
  })
})

describe("Artifactory token check", () => {
  const respond = (status: number) =>
    vi.fn(
      async () => new Response(status === 200 ? "<repomd/>" : "", { status }),
    )

  it("accepts a token Artifactory accepts", async () => {
    const fetchFn = respond(200)
    expect(await checkArtifactoryToken("tok", fetchFn)).toEqual({ kind: "ok" })
    expect(fetchFn).toHaveBeenCalledWith(
      ARTIFACTORY_CHECK_URL,
      expect.objectContaining({
        headers: { Authorization: "Bearer tok" },
      }),
    )
  })

  it("tells a rejected token from an unreachable Artifactory", async () => {
    expect(await checkArtifactoryToken("tok", respond(401))).toEqual({
      kind: "invalid",
      status: 401,
    })
    expect(await checkArtifactoryToken("tok", respond(503))).toEqual({
      kind: "unknown",
      detail: "Artifactory answered HTTP 503.",
    })
    const offline = vi.fn(async () => {
      throw new TypeError("fetch failed", { cause: new Error("ENOTFOUND") })
    })
    expect(await checkArtifactoryToken("tok", offline)).toEqual({
      kind: "unknown",
      detail: "Could not reach Artifactory (ENOTFOUND).",
    })
  })
})

class FakeSecrets implements SecretStore {
  values = new Map<string, string>()
  availability: SecretEntry["availability"] = "available"
  sets: string[] = []
  async listSecrets(): Promise<SecretEntry[]> {
    return [...this.values.keys()].map((name) => ({
      name,
      availability: this.availability,
    }))
  }
  async getSecret(name: string) {
    const value = this.values.get(name)
    if (value === undefined) throw new Error(`secret ${name} not found`)
    return value
  }
  async setSecret(name: string, value: string) {
    this.sets.push(name)
    this.values.set(name, value)
  }
  async deleteSecret(name: string) {
    this.values.delete(name)
  }
}

describe("credential service", () => {
  function service(fetchStatus = 200) {
    const host = ghHost()
    const secrets = new FakeSecrets()
    const changes: CredentialsStatus[] = []
    const signIn = new GitHubSignIn({ host, onChange: () => {} })
    const fetchFn = vi.fn(async () => new Response("", { status: fetchStatus }))
    const clock = { now: Date.parse("2026-11-20T12:00:00Z") }
    const creds = new CredentialService({
      host,
      secrets,
      signIn,
      binDir: BIN_DIR,
      fetch: fetchFn,
      onChange: (s) => changes.push(s),
      now: () => clock.now,
    })
    return { host, secrets, creds, changes, fetchFn, clock }
  }

  it("shows the GitHub account and a missing Artifactory token", async () => {
    const { creds } = service()
    const status = await creds.get()
    expect(status.github).toEqual({
      checkedAt: "2026-11-20T12:00:00.000Z",
      host: "github.ibm.com",
      state: "ok",
      detail: "Signed in as dev (Dev Eloper).",
      account: { login: "dev", name: "Dev Eloper", email: "dev@ibm.com" },
      scopes: ["gist", "read:org", "repo"],
    })
    expect(status.artifactory).toEqual({
      url: "https://eu.artifactory.swg-devops.com/",
      state: "missing",
      detail: "No token stored.",
      checkedAt: "2026-11-20T12:00:00.000Z",
    })
  })

  it("stores the w3id and token, checks the token and mounts both", async () => {
    const { creds, secrets, fetchFn } = service()
    const status = await creds.saveArtifactory({
      user: " dev@ibm.com ",
      token: " tok123\n",
    })
    expect(secrets.values.get(TOKEN_SECRET)).toBe("tok123")
    expect(secrets.values.get(USER_SECRET)).toBe("dev@ibm.com")
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(status.artifactory).toMatchObject({
      state: "ok",
      user: "dev@ibm.com",
      detail: "Artifactory accepts the token.",
    })
    expect(await creds.upSecretFlags()).toEqual([
      "SH_IBM_USER,type=mount,target=IBM_USER",
      "SH_ARTIFACTORY_TOKEN,type=mount,target=ARTIFACTORY_TOKEN",
    ])
  })

  it("keeps the stored token when only the w3id changes", async () => {
    const { creds, secrets } = service()
    await creds.saveArtifactory({ user: "dev@ibm.com", token: "tok123" })
    await creds.saveArtifactory({ user: "other@ibm.com", token: "" })
    expect(secrets.values.get(TOKEN_SECRET)).toBe("tok123")
    expect(secrets.values.get(USER_SECRET)).toBe("other@ibm.com")
  })

  it("rejects an invalid w3id, or no token when none is stored", async () => {
    const { creds } = service()
    await creds.check()
    await expect(
      creds.saveArtifactory({ user: "dev", token: "tok" }),
    ).rejects.toThrow(/w3id/)
    await expect(
      creds.saveArtifactory({ user: "dev@ibm.com", token: "" }),
    ).rejects.toThrow(/Paste the token/)
  })

  it("reports a token Artifactory rejects", async () => {
    const { creds } = service(401)
    const status = await creds.saveArtifactory({
      user: "dev@ibm.com",
      token: "old",
    })
    expect(status.artifactory).toMatchObject({
      state: "invalid",
      detail:
        "Artifactory rejects the stored token (HTTP 401). Create a new one and save it here.",
    })
  })

  it("removes both secrets", async () => {
    const { creds, secrets } = service()
    await creds.saveArtifactory({ user: "dev@ibm.com", token: "tok" })
    const status = await creds.removeArtifactory()
    expect(secrets.values.size).toBe(0)
    expect(status.artifactory.state).toBe("missing")
    expect(await creds.upSecretFlags()).toEqual([])
  })

  it("starts environments without secrets when the store is locked or broken", async () => {
    const { creds, secrets } = service()
    await creds.saveArtifactory({ user: "dev@ibm.com", token: "tok" })
    secrets.availability = "locked"
    expect(await creds.upSecretFlags()).toEqual([])
    secrets.listSecrets = async () => {
      throw new Error("keyring unavailable")
    }
    expect(await creds.upSecretFlags()).toEqual([])
  })

  it("shows a signed-out GitHub CLI without asking github.ibm.com", async () => {
    const { creds, host } = service()
    delete host.files[HOSTS]
    const status = await creds.check()
    expect(status.github).toMatchObject({
      state: "signed-out",
      detail: "Not signed in.",
    })
    expect(host.runs.some((r) => r.includes("api"))).toBe(false)
  })
})

describe("IBM Cloud (docker-credential-icr)", () => {
  it("reads the account from the token, never more", () => {
    expect(
      accountFromCredentials(
        icrAnswer({ email: "dev@ibm.com", name: "Dev Eloper", exp: 1 }),
      ),
    ).toEqual({ email: "dev@ibm.com", name: "Dev Eloper" })
    expect(accountFromCredentials('{"Secret":"opaque"}')).toEqual({})
    expect(accountFromCredentials("not json")).toBeNull()
  })

  it("asks the helper for icr.io on stdin, like Docker", async () => {
    const host = ghHost()
    let input: string | undefined
    host.onStart[`${ICR} get`] = (p) => {
      input = p.input
      p.line(icrAnswer({ email: "dev@ibm.com" }), "stdout")
      p.exit(0)
    }
    expect(await icrGet(host, ICR).done).toEqual({
      kind: "ok",
      email: "dev@ibm.com",
    })
    expect(input).toBe(`${ICR_REGISTRY}\n`)
  })

  it("reports the helper's error, and a cancelled login", async () => {
    const host = ghHost()
    host.onStart[`${ICR} get`] = (p) => {
      p.line("OAuth flow failed: access denied", "stderr")
      p.exit(1)
    }
    expect(await icrGet(host, ICR).done).toEqual({
      kind: "failed",
      detail: "docker-credential-icr failed: OAuth flow failed: access denied",
    })
    host.onStart[`${ICR} get`] = () => {}
    const run = icrGet(host, ICR)
    run.cancel()
    expect(await run.done).toEqual({ kind: "cancelled" })
  })

  function withHelper(answer: (p: FakeProcess) => void) {
    const host = ghHost()
    host.files[ICR] = ""
    host.onStart[`${ICR} get`] = answer
    const changes: CredentialsStatus[] = []
    const creds = new CredentialService({
      host,
      secrets: new FakeSecrets(),
      signIn: new GitHubSignIn({ host, onChange: () => {} }),
      binDir: BIN_DIR,
      fetch: vi.fn(async () => new Response("", { status: 200 })),
      onChange: (s) => changes.push(s),
    })
    return { host, creds, changes }
  }

  it("checks the login with the other credentials, without waiting for it", async () => {
    const { creds, changes } = withHelper((p) => {
      setTimeout(() => {
        p.line(icrAnswer({ email: "dev@ibm.com", name: "Dev" }), "stdout")
        p.exit(0)
      }, 20)
    })
    const first = await creds.check()
    expect(first.ibmCloud.state).toBe("unknown")
    await vi.waitFor(() =>
      expect(changes.at(-1)?.ibmCloud).toMatchObject({
        state: "ok",
        detail: "Logged in as dev@ibm.com.",
        account: { email: "dev@ibm.com", name: "Dev" },
      }),
    )
  })

  it("shows when the helper waits for the login in the browser, and can stop it", async () => {
    vi.useFakeTimers()
    try {
      const { creds, changes } = withHelper(() => {})
      await creds.check()
      await vi.advanceTimersByTimeAsync(3_500)
      expect(changes.at(-1)?.ibmCloud.signingIn).toBe(true)
      creds.cancelIbmCloudSignIn()
      await vi.advanceTimersByTimeAsync(10)
      expect(changes.at(-1)?.ibmCloud).toMatchObject({
        state: "signed-out",
        detail: "Not logged in: the login was cancelled.",
      })
      expect(changes.at(-1)?.ibmCloud.signingIn).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it("points to This computer when the helper is missing", async () => {
    const host = ghHost()
    const changes: CredentialsStatus[] = []
    const creds = new CredentialService({
      host,
      secrets: new FakeSecrets(),
      signIn: new GitHubSignIn({ host, onChange: () => {} }),
      binDir: BIN_DIR,
      onChange: (s) => changes.push(s),
    })
    await creds.check()
    await vi.waitFor(() =>
      expect(changes.at(-1)?.ibmCloud.state).toBe("no-helper"),
    )
    expect(host.starts).toEqual([])
  })
})

describe("credential freshness", () => {
  it("checks again when the last check is over 10 minutes old", async () => {
    const host = ghHost()
    const clock = { now: Date.parse("2026-11-20T12:00:00Z") }
    const creds = new CredentialService({
      host,
      secrets: new FakeSecrets(),
      signIn: new GitHubSignIn({ host, onChange: () => {} }),
      binDir: BIN_DIR,
      fetch: vi.fn(async () => new Response("", { status: 200 })),
      onChange: () => {},
      now: () => clock.now,
    })
    const apiCalls = () => host.runs.filter((r) => r.includes(" api ")).length
    await creds.get()
    expect(apiCalls()).toBe(1)
    clock.now += 9 * 60_000
    await creds.get()
    expect(apiCalls()).toBe(1)
    clock.now += 2 * 60_000
    const status = await creds.get()
    expect(apiCalls()).toBe(2)
    expect(status.github.checkedAt).toBe("2026-11-20T12:11:00.000Z")
  })
})

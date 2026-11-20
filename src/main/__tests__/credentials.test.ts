// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import type { CredentialsStatus } from "../../shared/api"
import {
  ARTIFACTORY_CHECK_URL,
  checkArtifactoryToken,
} from "../credentials/artifactory"
import { SECRET } from "../credentials/artifactory-tokens"
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
import { CredentialService } from "../credentials/service"
import { FakeArtifactory, FakeStore, tokensFor } from "./fake-artifactory"
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

describe("credential service", () => {
  const USER = "dev@ibm.com"
  const DAY = 24 * 60 * 60

  function service() {
    const host = ghHost()
    const art = new FakeArtifactory()
    const store = new FakeStore()
    const { tokens } = tokensFor(store, art, { github: () => "gho_x" })
    const changes: CredentialsStatus[] = []
    const signIn = new GitHubSignIn({ host, onChange: () => {} })
    const deliveries: string[] = []
    let busy = 0
    const clock = { now: Date.parse("2026-11-20T12:00:00Z") }
    const creds = new CredentialService({
      host,
      secrets: store,
      signIn,
      tokens,
      deliver: async () => {
        deliveries.push("deliver")
        const result = { delivered: busy ? 0 : 1, busy, failed: 0 }
        busy = 0
        return result
      },
      binDir: BIN_DIR,
      fetch: art.fetch as typeof fetch,
      onChange: (s) => changes.push(s),
      now: () => clock.now,
    })
    return {
      host,
      art,
      store,
      creds,
      changes,
      deliveries,
      clock,
      busyOnce: () => {
        busy = 1
      },
    }
  }

  it("shows the GitHub account and that Artifactory is not set up", async () => {
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
      detail: "Not set up yet.",
      checkedAt: "2026-11-20T12:00:00.000Z",
    })
  })

  it("sets up with an identity token, delivers the files and shows both expiries", async () => {
    const { creds, art, deliveries } = service()
    const status = await creds.saveArtifactory({
      user: ` ${USER} `,
      token: ` ${art.identity}\n`,
    })
    expect(status.artifactory).toMatchObject({
      state: "ok",
      user: USER,
      detail:
        "Artifactory accepts the token. Silicon Harbor renews it while it runs.",
      tokenExpiresAt: new Date((art.clock.s + 7 * DAY) * 1000).toISOString(),
      parentExpiresAt: new Date((art.clock.s + 90 * DAY) * 1000).toISOString(),
    })
    expect(deliveries).toHaveLength(1)
    expect(await creds.upSecretFlags()).toEqual([
      "SH_IBM_USER,type=mount,target=IBM_USER",
      "SH_ARTIFACTORY_TOKEN,type=mount,target=ARTIFACTORY_TOKEN",
      "SH_NETRC,type=mount,target=netrc",
      "SH_JFROG_CONF,type=mount,target=jfrog-cli.conf",
      "SH_MARKER,type=mount,target=.silicon-harbor.json",
    ])
  })

  it("changes only the w3id and rebuilds the files", async () => {
    const { creds, art, store, deliveries } = service()
    await creds.saveArtifactory({ user: USER, token: art.identity })
    const posts = art.calls.filter((c) => c.startsWith("POST")).length
    await creds.saveArtifactory({ user: "other@ibm.com", token: "" })
    expect(art.calls.filter((c) => c.startsWith("POST"))).toHaveLength(posts)
    expect(store.values.get(SECRET.netrc)).toContain("login other@ibm.com")
    expect(deliveries).toHaveLength(2)
  })

  it("rejects an invalid w3id, a token with spaces, or no token when not set up", async () => {
    const { creds } = service()
    await expect(
      creds.saveArtifactory({ user: "dev", token: "tok" }),
    ).rejects.toThrow(/w3id/)
    await expect(
      creds.saveArtifactory({ user: USER, token: "a b" }),
    ).rejects.toThrow(/spaces/)
    await expect(
      creds.saveArtifactory({ user: USER, token: "" }),
    ).rejects.toThrow(/Paste the identity token/)
  })

  it("reports an identity token Artifactory rejects", async () => {
    const { creds } = service()
    await expect(
      creds.saveArtifactory({ user: USER, token: "wrong" }),
    ).rejects.toThrow("Artifactory rejected the token (HTTP 401).")
  })

  it("renews when due and delivers, retrying while environments are busy", async () => {
    const { creds, art, deliveries, busyOnce } = service()
    await creds.saveArtifactory({ user: USER, token: art.identity })
    deliveries.length = 0
    await creds.renewNow()
    expect(deliveries).toEqual([]) // nothing due
    art.clock.s += 4 * DAY
    busyOnce()
    await creds.renewNow()
    expect(deliveries).toHaveLength(1) // renewed, but one environment was busy
    await creds.renewNow()
    expect(deliveries).toHaveLength(2) // nothing due, delivered the pending files
    await creds.renewNow()
    expect(deliveries).toHaveLength(2)
  })

  it("shows a failed renewal and clears it once one succeeds", async () => {
    const { creds, art } = service()
    await creds.saveArtifactory({ user: USER, token: art.identity })
    art.clock.s += 4 * DAY
    art.down = true
    await creds.renewNow()
    let status = await creds.check()
    expect(status.artifactory.renewalError).toBe(
      "Could not reach Artifactory (fetch failed).",
    )
    art.down = false
    await creds.renewNow()
    status = await creds.check()
    expect(status.artifactory.renewalError).toBeUndefined()
    expect(status.artifactory.state).toBe("ok")
  })

  it("renews now on request", async () => {
    const { creds, art, store, deliveries } = service()
    await creds.saveArtifactory({ user: USER, token: art.identity })
    const before = store.values.get(SECRET.token)
    await creds.renewArtifactory()
    expect(store.values.get(SECRET.token)).not.toBe(before)
    expect(deliveries).toHaveLength(2)
  })

  it("removes: revokes the tokens, releases /run/secrets and delivers that", async () => {
    const { creds, art, deliveries } = service()
    await creds.saveArtifactory({ user: USER, token: art.identity })
    const status = await creds.removeArtifactory()
    expect(status.artifactory.state).toBe("missing")
    expect(art.tokens.every((t) => t.revoked)).toBe(true)
    expect(deliveries).toHaveLength(2)
    expect(await creds.upSecretFlags()).toEqual([
      "SH_MARKER,type=mount,target=.silicon-harbor.json",
    ])
  })

  it("starts environments without secrets when the store is broken", async () => {
    const { creds, art, store } = service()
    await creds.saveArtifactory({ user: USER, token: art.identity })
    store.listSecrets = async () => {
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
      secrets: new FakeStore(),
      tokens: tokensFor(new FakeStore(), new FakeArtifactory()).tokens,
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
      secrets: new FakeStore(),
      tokens: tokensFor(new FakeStore(), new FakeArtifactory()).tokens,
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
      secrets: new FakeStore(),
      tokens: tokensFor(new FakeStore(), new FakeArtifactory()).tokens,
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

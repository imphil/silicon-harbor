// @vitest-environment node
import { describe, expect, it } from "vitest"
import {
  buildJfrogConfig,
  buildMarker,
  buildNetrc,
  CONTAINER_LIFETIME_S,
  description,
  needsRenewal,
  PARENT_LIFETIME_S,
  RELEASED_MARKER,
  SECRET,
  tokenInfo,
} from "../credentials/artifactory-tokens"
import { FakeArtifactory, FakeStore, jwt, tokensFor } from "./fake-artifactory"

const DAY = 24 * 60 * 60
const USER = "dev@ibm.com"

async function setUp(opts: { github?: () => string | undefined } = {}) {
  const art = new FakeArtifactory()
  const store = new FakeStore()
  const { tokens, log } = tokensFor(store, art, opts)
  await tokens.setup(art.identity, USER)
  return { art, store, tokens, log }
}

describe("tokens", () => {
  it("reads id and expiry from a JWT, nothing from an identity token", () => {
    expect(tokenInfo(jwt({ jti: "a1", exp: 100 }))).toEqual({
      id: "a1",
      expiresAt: 100,
    })
    expect(tokenInfo("cmVmdGtuOjAxOjE3ODk")).toBeUndefined()
    expect(tokenInfo("a.b.c")).toBeUndefined()
  })

  it("renews an identity token at once, and a JWT when it is close to expiry", () => {
    expect(needsRenewal(undefined, 10, 0)).toBe(true)
    expect(needsRenewal("cmVmdGtuOjAx", 10, 0)).toBe(true)
    expect(needsRenewal(jwt({ jti: "a", exp: 100 }), 10, 85)).toBe(false)
    expect(needsRenewal(jwt({ jti: "a", exp: 100 }), 10, 95)).toBe(true)
  })
})

describe("files for /run/secrets", () => {
  it("netrc: both Artifactory hosts with the same token, GitHub when signed in", () => {
    expect(buildNetrc({ user: USER, token: "T", githubToken: "gho_x" })).toBe(
      "machine eu.artifactory.swg-devops.com login dev@ibm.com password T\n" +
        "machine na.artifactory.swg-devops.com login dev@ibm.com password T\n" +
        "machine github.ibm.com login dev@ibm.com password gho_x\n",
    )
    expect(buildNetrc({ user: USER, token: "T" })).not.toContain("github")
  })

  it("JFrog CLI config: today's format, no refresh fields", () => {
    expect(JSON.parse(buildJfrogConfig({ user: USER, token: "T" }))).toEqual({
      servers: [
        {
          url: "https://na.artifactory.swg-devops.com/",
          artifactoryUrl: "https://na.artifactory.swg-devops.com/artifactory/",
          user: USER,
          password: "T",
          serverId: "na-art",
          isDefault: true,
        },
      ],
      version: "6",
    })
  })

  it("marker: what the container helper reads", () => {
    expect(JSON.parse(buildMarker(1_800_000_000))).toEqual({
      version: 1,
      managedBy: "silicon-harbor",
      mode: "shared",
      expiresAt: 1_800_000_000,
      files: ["ARTIFACTORY_TOKEN", "IBM_USER", "netrc", "jfrog-cli.conf"],
    })
    expect(JSON.parse(RELEASED_MARKER).managedBy).toBe("none")
  })
})

describe("ArtifactoryTokens", () => {
  it("sets up: a parent from the identity token, a container token from the parent, the files", async () => {
    const { art, store, tokens } = await setUp({ github: () => "gho_x" })
    const computer = "c0ffee000001"
    const [parent] = art.live(description(computer, "parent"))
    const [shared] = art.live(description(computer, "shared"))
    expect(parent?.exp).toBe(art.clock.s + PARENT_LIFETIME_S)
    expect(shared?.exp).toBe(art.clock.s + CONTAINER_LIFETIME_S)
    expect(store.values.get(SECRET.parent)).toBe(parent?.jwt)
    expect(store.values.get(SECRET.token)).toBe(shared?.jwt)
    expect(store.values.get(SECRET.user)).toBe(USER)
    expect(store.values.get(SECRET.netrc)).toContain(
      `machine na.artifactory.swg-devops.com login ${USER} password ${shared?.jwt}`,
    )
    expect(store.values.get(SECRET.netrc)).toContain("gho_x")
    expect(JSON.parse(store.values.get(SECRET.marker) ?? "{}").expiresAt).toBe(
      shared?.exp,
    )
    // The marker is mounted last, so a container never sees it before the files.
    expect(await tokens.mounts()).toEqual([
      "SH_IBM_USER,type=mount,target=IBM_USER",
      "SH_ARTIFACTORY_TOKEN,type=mount,target=ARTIFACTORY_TOKEN",
      "SH_NETRC,type=mount,target=netrc",
      "SH_JFROG_CONF,type=mount,target=jfrog-cli.conf",
      "SH_MARKER,type=mount,target=.silicon-harbor.json",
    ])
    expect(await tokens.state()).toEqual({
      configured: true,
      user: USER,
      tokenExpiresAt: shared?.exp,
      parentExpiresAt: parent?.exp,
    })
  })

  it("does nothing while nothing is due", async () => {
    const { art, tokens } = await setUp()
    art.calls.length = 0
    art.clock.s += 3 * DAY
    expect(await tokens.renew()).toBe(false)
    expect(art.calls).toEqual([])
  })

  it("re-creates the container token after half its lifetime and keeps the old one valid", async () => {
    const { art, store, tokens } = await setUp()
    const shared = description("c0ffee000001", "shared")
    const old = store.values.get(SECRET.token)
    art.clock.s += 4 * DAY
    expect(await tokens.renew()).toBe(true)
    const now = store.values.get(SECRET.token)
    expect(now).not.toBe(old)
    // Containers that have not received the new files keep working.
    expect(art.live(shared)).toHaveLength(2)
    expect(art.valid(old ?? "")).toBe(true)
    expect(store.values.get(SECRET.netrc)).toContain(now ?? "-")
  })

  it("re-creates the parent 30 days before expiry and revokes the old parent", async () => {
    const { art, store, tokens } = await setUp()
    const parentDesc = description("c0ffee000001", "parent")
    const oldParent = store.values.get(SECRET.parent) ?? ""
    art.clock.s += 61 * DAY
    await tokens.renew()
    const newParent = store.values.get(SECRET.parent) ?? ""
    expect(newParent).not.toBe(oldParent)
    expect(art.live(parentDesc).map((t) => t.jwt)).toEqual([newParent])
  })

  it("leaves other computers' tokens alone", async () => {
    const art = new FakeArtifactory()
    const a = tokensFor(new FakeStore(), art, { computerId: "aaaaaaaaaaaa" })
    const b = tokensFor(new FakeStore(), art, { computerId: "bbbbbbbbbbbb" })
    await a.tokens.setup(art.identity, USER)
    await b.tokens.setup(art.identity, USER)
    art.clock.s += 61 * DAY
    await a.tokens.renew()
    expect(art.live(description("bbbbbbbbbbbb", "parent"))).toHaveLength(1)
    await a.tokens.remove()
    expect(art.live(description("bbbbbbbbbbbb", "shared"))).toHaveLength(1)
    expect(art.live(description("aaaaaaaaaaaa", "shared"))).toHaveLength(0)
  })

  it("rebuilds the files when gh's token changes", async () => {
    let gh = "gho_one"
    const { store, tokens } = await setUp({ github: () => gh })
    expect(await tokens.renew()).toBe(false)
    gh = "gho_two"
    expect(await tokens.renew()).toBe(true)
    expect(store.values.get(SECRET.netrc)).toContain("gho_two")
  })

  it("exchanges an identity token stored before v1 for a parent", async () => {
    const art = new FakeArtifactory()
    const store = new FakeStore()
    store.values.set(SECRET.token, art.identity)
    store.values.set(SECRET.user, USER)
    const { tokens } = tokensFor(store, art)
    expect(await tokens.renew()).toBe(true)
    expect(tokenInfo(store.values.get(SECRET.parent) ?? "")).toBeDefined()
    expect(tokenInfo(store.values.get(SECRET.token) ?? "")).toBeDefined()
    expect(store.values.has(SECRET.marker)).toBe(true)
  })

  it("is not configured without an identity token, and does nothing", async () => {
    const art = new FakeArtifactory()
    const { tokens } = tokensFor(new FakeStore(), art)
    expect(await tokens.renew()).toBe(false)
    expect(await tokens.state()).toEqual({ configured: false })
    expect(await tokens.mounts()).toEqual([])
    expect(art.calls).toEqual([])
  })

  it("removes: revokes this computer's tokens and releases /run/secrets", async () => {
    const { art, store, tokens } = await setUp()
    art.clock.s += 4 * DAY
    await tokens.renew() // two container tokens now
    await tokens.remove()
    expect(art.tokens.every((t) => t.revoked)).toBe(true)
    expect([...store.values.keys()]).toEqual([SECRET.marker])
    expect(store.values.get(SECRET.marker)).toBe(RELEASED_MARKER)
    // Containers get the released marker; the scripts take over again.
    expect(await tokens.mounts()).toEqual([
      "SH_MARKER,type=mount,target=.silicon-harbor.json",
    ])
  })

  it("runs one renewal at a time", async () => {
    const { art, tokens } = await setUp()
    art.clock.s += 4 * DAY
    art.calls.length = 0
    const [a, b] = await Promise.all([tokens.renew(), tokens.renew()])
    expect([a, b]).toEqual([true, false])
    expect(art.calls.filter((c) => c.startsWith("POST"))).toHaveLength(1)
  })

  it("reports a rejected identity token and keeps nothing", async () => {
    const art = new FakeArtifactory()
    const store = new FakeStore()
    const { tokens } = tokensFor(store, art)
    await expect(tokens.setup("wrong", USER)).rejects.toThrow(
      "Artifactory rejected the token (HTTP 401).",
    )
    expect(store.values.size).toBe(0)
  })
})

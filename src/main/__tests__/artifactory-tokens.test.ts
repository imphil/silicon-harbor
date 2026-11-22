// @vitest-environment node
import { describe, expect, it } from "vitest"
import {
  CONTAINER_LIFETIME_S,
  description,
  needsRenewal,
  PARENT_LIFETIME_S,
  SECRET,
  tokenInfo,
} from "../credentials/artifactory-tokens"
import { FakeArtifactory, FakeStore, jwt, tokensFor } from "./fake-artifactory"

const DAY = 24 * 60 * 60
const USER = "dev@ibm.com"

async function setUp() {
  const art = new FakeArtifactory()
  const store = new FakeStore()
  const { tokens, log } = tokensFor(store, art)
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

describe("ArtifactoryTokens", () => {
  it("sets up: a parent from the identity token, a container token from the parent", async () => {
    const { art, store, tokens } = await setUp()
    const computer = "c0ffee000001"
    const [parent] = art.live(description(computer, "parent"))
    const [shared] = art.live(description(computer, "shared"))
    expect(parent?.exp).toBe(art.clock.s + PARENT_LIFETIME_S)
    expect(shared?.exp).toBe(art.clock.s + CONTAINER_LIFETIME_S)
    expect(store.values.get(SECRET.parent)).toBe(parent?.jwt)
    expect(store.values.get(SECRET.token)).toBe(shared?.jwt)
    expect(store.values.get(SECRET.user)).toBe(USER)
    // Plain secrets only; the container's hook builds netrc and the JFrog
    // config. The marker is the core's (managed.ts), not this provider's.
    expect(store.values.has("SH_MANAGED")).toBe(false)
    expect(await tokens.secrets()).toEqual([
      "SH_IBM_USER,type=mount,target=IBM_USER",
      "SH_ARTIFACTORY_TOKEN,type=mount,target=ARTIFACTORY_TOKEN",
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
    // Containers that have not received the new token keep working.
    expect(art.live(shared)).toHaveLength(2)
    expect(art.valid(old ?? "")).toBe(true)
    expect(now).toBeDefined()
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

  it("is not configured without an identity token, and does nothing", async () => {
    const art = new FakeArtifactory()
    const { tokens } = tokensFor(new FakeStore(), art)
    expect(await tokens.renew()).toBe(false)
    expect(await tokens.state()).toEqual({ configured: false })
    expect(await tokens.mounts()).toEqual([])
    expect(art.calls).toEqual([])
  })

  it("removes: revokes this computer's tokens and forgets them", async () => {
    const { art, store, tokens } = await setUp()
    art.clock.s += 4 * DAY
    await tokens.renew() // two container tokens now
    await tokens.remove()
    expect(art.tokens.every((t) => t.revoked)).toBe(true)
    expect([...store.values.keys()]).toEqual([])
    expect(await tokens.secrets()).toEqual([])
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

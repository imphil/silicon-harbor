import { vi } from "vitest"
import { ARTIFACTORY_CHECK_URL } from "../credentials/artifactory"
import {
  ARTIFACTORY_API_URL,
  ArtifactoryApi,
  ArtifactoryTokens,
  type TokenStore,
} from "../credentials/artifactory-tokens"

/** Devsy's secret store: `get` returns exactly what was set. */
export class FakeStore implements TokenStore {
  values = new Map<string, string>()
  availability = "available"
  async listSecrets() {
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
    this.values.set(name, value)
  }
  async deleteSecret(name: string) {
    this.values.delete(name)
  }
}

interface FakeToken {
  id: string
  description: string
  exp: number
  jwt: string
  revoked: boolean
}

/** A JWT the way Artifactory's look to us: only `jti`, `exp`, `sub` matter. */
export function jwt(claims: Record<string, unknown>): string {
  const part = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url")
  return `${part({ alg: "RS256" })}.${part(claims)}.sig`
}

/**
 * The three Access API calls and the repository check URL, with real
 * expiry and revocation on a controllable clock (seconds).
 */
export class FakeArtifactory {
  clock = { s: 1_800_000_000 }
  tokens: FakeToken[] = []
  calls: string[] = []
  /** The identity token the user pastes (not a JWT). */
  identity = "cmVmdGtuOjAxOjE3ODk"
  private next = 1
  down = false

  valid(auth: string): boolean {
    if (auth === this.identity) return true
    const t = this.tokens.find((t) => t.jwt === auth)
    return t !== undefined && !t.revoked && t.exp > this.clock.s
  }

  live(description: string): FakeToken[] {
    return this.tokens.filter(
      (t) => t.description === description && !t.revoked,
    )
  }

  fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? "GET"
    const auth = String(
      (init?.headers as Record<string, string> | undefined)?.Authorization ??
        "",
    ).replace(/^Bearer /, "")
    this.calls.push(`${method} ${url.replace(ARTIFACTORY_API_URL, "")}`)
    if (this.down) throw new TypeError("fetch failed")
    if (url === ARTIFACTORY_CHECK_URL)
      return new Response("", { status: this.valid(auth) ? 200 : 401 })
    if (!this.valid(auth)) return new Response("", { status: 401 })
    const path = url.replace(ARTIFACTORY_API_URL, "")
    if (method === "POST" && path === "/access/api/v1/tokens") {
      const body = JSON.parse(String(init?.body)) as {
        description: string
        expires_in: number
      }
      const id = `tok-${this.next++}`
      const exp = this.clock.s + body.expires_in
      const token: FakeToken = {
        id,
        description: body.description,
        exp,
        jwt: jwt({ jti: id, exp, sub: "jfac@x/users/dev@ibm.com" }),
        revoked: false,
      }
      this.tokens.push(token)
      return Response.json({
        token_id: id,
        access_token: token.jwt,
        expires_in: body.expires_in,
        token_type: "Bearer",
      })
    }
    if (method === "GET" && path === "/access/api/v1/tokens")
      return Response.json({
        tokens: this.tokens
          .filter((t) => !t.revoked)
          .map((t) => ({ token_id: t.id, description: t.description })),
      })
    const del = /^\/access\/api\/v1\/tokens\/(.+)$/.exec(path)
    if (method === "DELETE" && del?.[1]) {
      const t = this.tokens.find(
        (t) => t.id === decodeURIComponent(del[1] ?? ""),
      )
      if (!t || t.revoked) return new Response("", { status: 404 })
      t.revoked = true
      return new Response(null, { status: 204 })
    }
    return new Response("", { status: 400 })
  })
}

export function tokensFor(
  store: FakeStore,
  art: FakeArtifactory,
  opts: { computerId?: string } = {},
) {
  const log: string[] = []
  const tokens = new ArtifactoryTokens({
    store,
    api: new ArtifactoryApi(art.fetch as typeof fetch),
    computerId: async () => opts.computerId ?? "c0ffee000001",
    nowS: () => art.clock.s,
    log: (entry) => log.push(entry),
  })
  return { tokens, log }
}

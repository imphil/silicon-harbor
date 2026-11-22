/**
 * Artifactory tokens for the shared design (docs/developer/credentials.md, design doc
 * "v1 implementation"): Silicon Harbor keeps a long-lived parent token on this
 * computer and creates short-lived container tokens with it. Containers get
 * the container token and the w3id through Devsy's secret mounts in
 * /run/secrets (while Silicon Harbor manages credentials, see managed.ts);
 * their onSecretsChangedCommand builds netrc and the JFrog CLI config.
 *
 * Tokens are re-created, not refreshed, the way the containers' own renewal
 * service has done it: create the next token with the current one, then
 * revoke the old one by id. That service proves a normal user may do all of
 * it on na.artifactory (create with a token, 90-day lifetime, list and revoke
 * own tokens).
 */

import type { ProviderStore, SecretProvider } from "./provider"

/** The Access API host (as the containers' renewal service uses). */
export const ARTIFACTORY_API_URL = "https://na.artifactory.swg-devops.com"

const DAY = 24 * 60 * 60

export const PARENT_LIFETIME_S = 90 * DAY
/** Re-create the parent when fewer than this many seconds remain (the renewal service's rule). */
export const PARENT_RENEW_BEFORE_S = 30 * DAY
export const CONTAINER_LIFETIME_S = 7 * DAY
/** Re-create the container token when less than half of its lifetime remains. */
export const CONTAINER_RENEW_BEFORE_S = CONTAINER_LIFETIME_S / 2

/** Devsy secret names (prefixed: the OS keyring is shared with other Devsy installs). */
export const SECRET = {
  parent: "SH_ARTIFACTORY_PARENT",
  token: "SH_ARTIFACTORY_TOKEN",
  user: "SH_IBM_USER",
} as const

/** File names in /run/secrets (what the container scripts read). */
export const TARGET = {
  token: "ARTIFACTORY_TOKEN",
  user: "IBM_USER",
} as const

export const MOUNTED: Array<{ secret: string; target: string }> = [
  { secret: SECRET.user, target: TARGET.user },
  { secret: SECRET.token, target: TARGET.token },
]

// ---------------------------------------------------------------------------
// Tokens

export interface TokenInfo {
  /** The token id Artifactory revokes by (JWT `jti`). */
  id: string
  /** Seconds since 1970 (JWT `exp`); undefined = never expires. */
  expiresAt?: number
}

/**
 * Id and expiry from an access token (a JWT). Undefined for a reference or
 * identity token, which is not a JWT: it is always exchanged for a new one.
 */
export function tokenInfo(token: string): TokenInfo | undefined {
  const parts = token.split(".")
  if (parts.length !== 3 || !parts[1]) return undefined
  try {
    const claims = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    ) as Record<string, unknown>
    if (typeof claims.jti !== "string" || !claims.jti) return undefined
    return {
      id: claims.jti,
      ...(typeof claims.exp === "number" ? { expiresAt: claims.exp } : {}),
    }
  } catch {
    return undefined
  }
}

/** Re-create when the token is not ours (no JWT) or expires within `before` seconds. */
export function needsRenewal(
  token: string | undefined,
  before: number,
  nowS: number,
): boolean {
  if (!token) return true
  const info = tokenInfo(token)
  if (!info) return true
  if (info.expiresAt === undefined) return false
  return info.expiresAt - nowS < before
}

/** Descriptions keep each computer's tokens apart, and the parent apart from the container token. */
export function description(computerId: string, kind: "parent" | "shared") {
  return `silicon-harbor:${computerId}:${kind}`
}

// ---------------------------------------------------------------------------
// Access API

export interface CreatedToken {
  token: string
  id: string
  expiresAt?: number
}

export interface ListedToken {
  id: string
  description?: string
}

export class ArtifactoryApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = "ArtifactoryApiError"
  }
}

/** The three Access API calls; authenticated with the token passed in, never logged. */
export class ArtifactoryApi {
  constructor(
    private readonly fetchFn: typeof fetch = fetch,
    private readonly baseUrl = ARTIFACTORY_API_URL,
  ) {}

  /** `POST /access/api/v1/tokens` for the authenticated user (as `jfrog atc`). */
  async createToken(
    auth: string,
    opts: { description: string; expiresIn: number },
  ): Promise<CreatedToken> {
    const res = await this.call("POST", "/access/api/v1/tokens", auth, {
      description: opts.description,
      expires_in: opts.expiresIn,
    })
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
    const token = typeof body.access_token === "string" ? body.access_token : ""
    if (!token)
      throw new ArtifactoryApiError(
        "Artifactory returned no token.",
        res.status,
      )
    const info = tokenInfo(token)
    const id =
      (typeof body.token_id === "string" && body.token_id) || info?.id || ""
    const expiresIn =
      typeof body.expires_in === "number" ? body.expires_in : undefined
    return {
      token,
      id,
      ...(info?.expiresAt !== undefined
        ? { expiresAt: info.expiresAt }
        : expiresIn !== undefined
          ? { expiresAt: Math.floor(Date.now() / 1000) + expiresIn }
          : {}),
    }
  }

  /** `GET /access/api/v1/tokens`: the authenticated user's own tokens. */
  async listTokens(auth: string): Promise<ListedToken[]> {
    const res = await this.call("GET", "/access/api/v1/tokens", auth)
    const body = (await res.json().catch(() => ({}))) as { tokens?: unknown }
    if (!Array.isArray(body.tokens)) return []
    return body.tokens.flatMap((t) => {
      const rec = t as Record<string, unknown>
      return typeof rec.token_id === "string"
        ? [
            {
              id: rec.token_id,
              ...(typeof rec.description === "string"
                ? { description: rec.description }
                : {}),
            },
          ]
        : []
    })
  }

  /** `DELETE /access/api/v1/tokens/<id>`; a token that is already gone is fine. */
  async revokeToken(auth: string, id: string): Promise<void> {
    await this.call(
      "DELETE",
      `/access/api/v1/tokens/${encodeURIComponent(id)}`,
      auth,
      undefined,
      [404],
    )
  }

  private async call(
    method: string,
    path: string,
    auth: string,
    body?: unknown,
    okStatuses: number[] = [],
  ): Promise<Response> {
    let res: Response
    try {
      res = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${auth}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(30_000),
      })
    } catch (error) {
      const reason =
        error instanceof Error
          ? error.cause instanceof Error
            ? error.cause.message
            : error.message
          : String(error)
      throw new ArtifactoryApiError(`Could not reach Artifactory (${reason}).`)
    }
    if (res.ok || okStatuses.includes(res.status)) return res
    await res.body?.cancel().catch(() => {})
    throw new ArtifactoryApiError(
      res.status === 401 || res.status === 403
        ? `Artifactory rejected the token (HTTP ${res.status}).`
        : `Artifactory answered HTTP ${res.status}.`,
      res.status,
    )
  }
}

// ---------------------------------------------------------------------------
// Engine

/** What we need from Devsy's secret store (DevsyClient). */
export type TokenStore = ProviderStore

export interface ArtifactoryTokensDeps {
  store: TokenStore
  api: ArtifactoryApi
  /** A stable id of this installation (descriptions, clean-up). */
  computerId(): Promise<string>
  nowS?(): number
  log?(entry: string): void
}

export interface TokenState {
  configured: boolean
  user?: string
  tokenExpiresAt?: number
  parentExpiresAt?: number
}

/**
 * Keeps the parent and container token current. Every call is
 * safe to repeat; concurrent callers share one run (a token may only be
 * re-created once at a time, or the clean-up revokes the other one's token).
 */
export class ArtifactoryTokens implements SecretProvider {
  readonly id = "artifactory"

  private running: Promise<boolean> | null = null

  constructor(private readonly deps: ArtifactoryTokensDeps) {}

  private now(): number {
    return this.deps.nowS?.() ?? Math.floor(Date.now() / 1000)
  }

  private log(entry: string): void {
    this.deps.log?.(`artifactory: ${entry}`)
  }

  private async read(name: string): Promise<string | undefined> {
    const entries = await this.deps.store.listSecrets()
    const entry = entries.find((e) => e.name === name)
    if (entry?.availability !== "available") return undefined
    return (await this.deps.store.getSecret(name)) || undefined
  }

  async state(): Promise<TokenState> {
    const [parent, token, user] = await Promise.all([
      this.read(SECRET.parent),
      this.read(SECRET.token),
      this.read(SECRET.user),
    ])
    return {
      configured: parent !== undefined,
      ...(user ? { user } : {}),
      ...(token && tokenInfo(token)?.expiresAt !== undefined
        ? { tokenExpiresAt: tokenInfo(token)?.expiresAt }
        : {}),
      ...(parent && tokenInfo(parent)?.expiresAt !== undefined
        ? { parentExpiresAt: tokenInfo(parent)?.expiresAt }
        : {}),
    }
  }

  /**
   * First setup (or a replacement): the identity token the user pasted
   * creates a new parent token; then a container token and the files.
   */
  async setup(identityToken: string, user: string): Promise<void> {
    await this.exclusive(async () => {
      const computerId = await this.deps.computerId()
      const parent = await this.deps.api.createToken(identityToken, {
        description: description(computerId, "parent"),
        expiresIn: PARENT_LIFETIME_S,
      })
      await this.deps.store.setSecret(SECRET.parent, parent.token)
      await this.deps.store.setSecret(SECRET.user, user)
      this.log("parent token created")
      await this.cleanUp(parent.token, computerId, "parent", parent.id)
      await this.renewContainerToken(parent.token, computerId, true)
      return true
    })
  }

  /**
   * Re-creates what is due. Resolves true when a mounted secret changed, so
   * running containers need it delivered.
   */
  renew(opts: { force?: boolean } = {}): Promise<boolean> {
    return this.exclusive(async () => {
      let parent = await this.read(SECRET.parent)
      if (!parent) return false
      const computerId = await this.deps.computerId()
      if (needsRenewal(parent, PARENT_RENEW_BEFORE_S, this.now())) {
        const next = await this.deps.api.createToken(parent, {
          description: description(computerId, "parent"),
          expiresIn: PARENT_LIFETIME_S,
        })
        await this.deps.store.setSecret(SECRET.parent, next.token)
        this.log("parent token re-created")
        await this.cleanUp(next.token, computerId, "parent", next.id)
        parent = next.token
      }
      const renewed = await this.renewContainerToken(
        parent,
        computerId,
        opts.force === true,
      )
      return renewed
    })
  }

  /**
   * "Remove": revoke this computer's tokens (all container tokens, then the
   * parent) and forget them.
   */
  async remove(): Promise<void> {
    await this.exclusive(async () => {
      const parent = await this.read(SECRET.parent)
      if (parent) {
        const computerId = await this.deps.computerId()
        const parentId = tokenInfo(parent)?.id
        try {
          const ours = (await this.deps.api.listTokens(parent)).filter(
            (t) =>
              t.description === description(computerId, "shared") ||
              (t.description === description(computerId, "parent") &&
                t.id !== parentId),
          )
          for (const t of ours) await this.deps.api.revokeToken(parent, t.id)
          if (parentId) await this.deps.api.revokeToken(parent, parentId)
        } catch (error) {
          this.log(`revoking failed: ${(error as Error).message}`)
        }
      }
      const stored = new Set(
        (await this.deps.store.listSecrets()).map((e) => e.name),
      )
      for (const name of [SECRET.parent, SECRET.token, SECRET.user])
        if (stored.has(name)) await this.deps.store.deleteSecret(name)
      this.log("tokens removed")
      return true
    })
  }

  /** SecretProvider: renewal as above. */
  refresh(opts: { force?: boolean } = {}): Promise<boolean> {
    return this.renew(opts)
  }

  /** SecretProvider: the `--secret` specs. */
  secrets(): Promise<string[]> {
    return this.mounts()
  }

  /** `--secret` specs for `up`: whichever secrets exist, the marker last. */
  async mounts(): Promise<string[]> {
    const available = new Set(
      (await this.deps.store.listSecrets())
        .filter((e) => e.availability === "available")
        .map((e) => e.name),
    )
    return MOUNTED.filter((m) => available.has(m.secret)).map(
      (m) => `${m.secret},type=mount,target=${m.target}`,
    )
  }

  // -------------------------------------------------------------------------

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = (this.running ?? Promise.resolve(false))
      .catch(() => false)
      .then(fn)
    this.running = run.then(
      () => false,
      () => false,
    )
    return run
  }

  private async renewContainerToken(
    parent: string,
    computerId: string,
    force: boolean,
  ): Promise<boolean> {
    const current = await this.read(SECRET.token)
    if (
      !force &&
      current &&
      tokenInfo(current) &&
      !needsRenewal(current, CONTAINER_RENEW_BEFORE_S, this.now())
    )
      return false
    const next = await this.deps.api.createToken(parent, {
      description: description(computerId, "shared"),
      expiresIn: CONTAINER_LIFETIME_S,
    })
    await this.deps.store.setSecret(SECRET.token, next.token)
    this.log("container token re-created")
    // The previous container token is not revoked: containers that have not
    // received the new files yet (busy, or without a shared volume) keep
    // working until it expires, at most half a lifetime later.
    return true
  }

  /**
   * Revokes this computer's other parent tokens, keeping `keepId`. Covers a
   * crash between creating a parent and revoking its predecessor.
   */
  private async cleanUp(
    auth: string,
    computerId: string,
    kind: "parent",
    keepId: string,
  ): Promise<void> {
    if (!keepId) return
    const wanted = description(computerId, kind)
    try {
      const tokens = await this.deps.api.listTokens(auth)
      for (const t of tokens)
        if (t.description === wanted && t.id !== keepId)
          await this.deps.api.revokeToken(auth, t.id)
    } catch (error) {
      // The old token expires on its own; never fail a renewal over it.
      this.log(`clean-up failed: ${(error as Error).message}`)
    }
  }
}

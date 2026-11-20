/**
 * Artifactory tokens for the shared design (docs/credentials.md, design doc
 * "v1 implementation"): Silicon Harbor keeps a long-lived parent token on this
 * computer and creates short-lived container tokens with it. Containers get
 * the container token and the files built from it (netrc, JFrog CLI config,
 * marker) through Devsy's secret mounts in /run/secrets.
 *
 * Tokens are re-created, not refreshed, the way the containers' own renewal
 * service has done it: create the next token with the current one, then
 * revoke the old one by id. That service proves a normal user may do all of
 * it on na.artifactory (create with a token, 90-day lifetime, list and revoke
 * own tokens).
 */

/** The Access API host (as the containers' renewal service uses). */
export const ARTIFACTORY_API_URL = "https://na.artifactory.swg-devops.com"

/** Hosts in netrc: both accept the same token. */
export const ARTIFACTORY_HOSTS = [
  "eu.artifactory.swg-devops.com",
  "na.artifactory.swg-devops.com",
] as const

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
  netrc: "SH_NETRC",
  jfrog: "SH_JFROG_CONF",
  marker: "SH_MARKER",
} as const

/** File names in /run/secrets (what the container scripts read). */
export const TARGET = {
  token: "ARTIFACTORY_TOKEN",
  user: "IBM_USER",
  netrc: "netrc",
  jfrog: "jfrog-cli.conf",
  marker: ".silicon-harbor.json",
} as const

/** Mount order: the marker last, so a container never sees it before the files. */
export const MOUNTED: Array<{ secret: string; target: string }> = [
  { secret: SECRET.user, target: TARGET.user },
  { secret: SECRET.token, target: TARGET.token },
  { secret: SECRET.netrc, target: TARGET.netrc },
  { secret: SECRET.jfrog, target: TARGET.jfrog },
  { secret: SECRET.marker, target: TARGET.marker },
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
// Files for /run/secrets

export function buildNetrc(input: {
  user: string
  token: string
  githubToken?: string
}): string {
  const lines = ARTIFACTORY_HOSTS.map(
    (host) => `machine ${host} login ${input.user} password ${input.token}`,
  )
  // Still read by a curl script; to be dropped once that is checked.
  if (input.githubToken)
    lines.push(
      `machine github.ibm.com login ${input.user} password ${input.githubToken}`,
    )
  return `${lines.join("\n")}\n`
}

/** The JFrog CLI config in the format the containers use today; no refresh fields, so jf never rewrites it. */
export function buildJfrogConfig(input: { user: string; token: string }) {
  const config = {
    servers: [
      {
        url: `${ARTIFACTORY_API_URL}/`,
        artifactoryUrl: `${ARTIFACTORY_API_URL}/artifactory/`,
        user: input.user,
        password: input.token,
        serverId: "na-art",
        isDefault: true,
      },
    ],
    version: "6",
  }
  return `${JSON.stringify(config, null, 2)}\n`
}

/** `.silicon-harbor.json`; the container helper reads `managedBy` and `expiresAt`. */
export function buildMarker(expiresAt: number): string {
  return `${JSON.stringify({
    version: 1,
    managedBy: "silicon-harbor",
    mode: "shared",
    expiresAt,
    files: [TARGET.token, TARGET.user, TARGET.netrc, TARGET.jfrog],
  })}\n`
}

/** Written by "Remove": the scripts treat it as absent and use today's path again. */
export const RELEASED_MARKER = `${JSON.stringify({ version: 1, managedBy: "none" })}\n`

// ---------------------------------------------------------------------------
// Engine

/** What we need from Devsy's secret store (DevsyClient). */
export interface TokenStore {
  listSecrets(): Promise<Array<{ name: string; availability: string }>>
  getSecret(name: string): Promise<string>
  setSecret(name: string, value: string): Promise<void>
  deleteSecret(name: string): Promise<void>
}

export interface ArtifactoryTokensDeps {
  store: TokenStore
  api: ArtifactoryApi
  /** A stable id of this installation (descriptions, clean-up). */
  computerId(): Promise<string>
  /** gh's token for github.ibm.com, for the netrc line; undefined when not signed in. */
  githubToken(): Promise<string | undefined>
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
 * Keeps the parent and container token and the files current. Every call is
 * safe to repeat; concurrent callers share one run (a token may only be
 * re-created once at a time, or the clean-up revokes the other one's token).
 */
export class ArtifactoryTokens {
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
      await this.writeFiles()
      return true
    })
  }

  /**
   * Re-creates what is due and rebuilds the files when anything changed
   * (also a new gh token or w3id). Resolves true when the files changed, so
   * running containers need them delivered.
   */
  renew(opts: { force?: boolean } = {}): Promise<boolean> {
    return this.exclusive(async () => {
      let parent = await this.read(SECRET.parent)
      if (!parent) {
        // Before v1 the pasted identity token was stored as the container
        // token: exchange it for a parent token once.
        const legacy = await this.read(SECRET.token)
        if (!legacy || tokenInfo(legacy)) return false
        const user = await this.read(SECRET.user)
        if (!user) return false
        this.log("exchanging the stored identity token for a parent token")
        const computerId = await this.deps.computerId()
        const created = await this.deps.api.createToken(legacy, {
          description: description(computerId, "parent"),
          expiresIn: PARENT_LIFETIME_S,
        })
        await this.deps.store.setSecret(SECRET.parent, created.token)
        parent = created.token
      }
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
      const filesChanged = await this.writeFiles()
      return renewed || filesChanged
    })
  }

  /**
   * "Remove": revoke this computer's tokens (all container tokens, then the
   * parent), forget them, and release /run/secrets back to the scripts.
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
      for (const name of [
        SECRET.parent,
        SECRET.token,
        SECRET.user,
        SECRET.netrc,
        SECRET.jfrog,
      ])
        if (stored.has(name)) await this.deps.store.deleteSecret(name)
      await this.deps.store.setSecret(SECRET.marker, RELEASED_MARKER)
      this.log("tokens removed; /run/secrets released")
      return true
    })
  }

  /** `--secret` specs for `up`: whichever files exist, the marker last. */
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

  /** Rebuilds netrc, JFrog config and marker; true when any of them changed. */
  private async writeFiles(): Promise<boolean> {
    const [token, user] = await Promise.all([
      this.read(SECRET.token),
      this.read(SECRET.user),
    ])
    if (!token || !user) return false
    const expiresAt = tokenInfo(token)?.expiresAt
    const githubToken = await this.deps.githubToken().catch(() => undefined)
    const files: Array<[string, string]> = [
      [SECRET.netrc, buildNetrc({ user, token, githubToken })],
      [SECRET.jfrog, buildJfrogConfig({ user, token })],
      [
        SECRET.marker,
        buildMarker(expiresAt ?? this.now() + CONTAINER_LIFETIME_S),
      ],
    ]
    let changed = false
    for (const [name, content] of files) {
      // setSecret sends the value plus one newline, which Devsy strips again,
      // and getSecret removes the one `secret get` prints: so `get` returns
      // exactly what was set.
      const current = await this.read(name).catch(() => undefined)
      if (current === content) continue
      await this.deps.store.setSecret(name, content)
      changed = true
    }
    if (changed) this.log("files rebuilt")
    return changed
  }
}

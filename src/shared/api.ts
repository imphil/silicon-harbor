/**
 * The typed contract between the main process and the renderer.
 *
 * The preload script exposes exactly this interface as `window.siliconHarbor`.
 * Every channel name lives here so main, preload and renderer cannot drift.
 *
 * Ownership: the main process (M1/M2) implements it; the renderer (M3) only
 * consumes it and ships a mock implementation for development and tests.
 * Change this file deliberately and keep both sides compiling.
 */

// ---------------------------------------------------------------------------
// App

export interface AppInfo {
  appVersion: string
  electronVersion: string
  platform: string
  arch: string
  /** Absolute path of the bundled Devsy CLI, or null when it is missing. */
  devsyPath: string | null
}

// ---------------------------------------------------------------------------
// Environments (backed by Devsy workspaces)

export type IdeId = "vscode" | "bob" | "codium"

/** Lifecycle state as shown to the user. Derived from `devsy workspace status`. */
export type EnvironmentState =
  | "running"
  | "stopped"
  /** An operation of ours is in progress (see `operation`). */
  | "busy"
  /** The last operation failed and left the environment unusable. */
  | "failed"
  | "unknown"

/** The five user-facing progress steps (PLAN.md §2, docs/devsy-contract.md). */
export type StepId =
  /** Checking this computer */
  | "check"
  /** Getting the repository */
  | "clone"
  /** Downloading and starting the environment */
  | "start"
  /** Preparing the environment (lifecycle hooks, agent) */
  | "prepare"
  /** Opening the IDE */
  | "ide"

export type StepState = "pending" | "active" | "done" | "failed" | "skipped"

export interface OperationStep {
  id: StepId
  state: StepState
  /** Short plain-language detail, e.g. "Running postCreateCommand". */
  detail?: string
}

export type OperationKind = "create" | "start" | "stop" | "rebuild" | "delete"

export interface Operation {
  /** Our own id for this operation (not the Devsy task id). */
  id: string
  kind: OperationKind
  state: "running" | "succeeded" | "failed" | "cancelled"
  /** Always all five steps in order; stop/delete only use "check". */
  steps: OperationStep[]
  error?: UserError
  /** ISO 8601 */
  startedAt: string
  /** ISO 8601 */
  finishedAt?: string
}

/** A failure translated into plain language (error catalog, PLAN.md §3). */
export interface UserError {
  /** Catalog key, e.g. "registry-auth", "git-auth", "clone-failed", "engine-unreachable", "unknown". */
  code: string
  title: string
  message: string
  /** Primary action the UI should offer. */
  action?: "sign-in-retry" | "retry" | "open-settings" | "copy-diagnostics"
  /** The raw Devsy cliError code, for diagnostics. */
  cliCode?: string
}

export interface Environment {
  /** Devsy workspace id. */
  id: string
  /** Display name (defaults to the repository name). */
  name: string
  repoUrl: string
  branch?: string
  ide: IdeId
  state: EnvironmentState
  /** Current operation, or the last one if it failed or was cancelled. */
  operation?: Operation
  /** ISO 8601 */
  createdAt?: string
  /** ISO 8601 */
  lastUsedAt?: string
}

export interface CreateEnvironmentRequest {
  repoUrl: string
  branch?: string
  name?: string
  /** Defaults to Settings.defaultIde. */
  ide?: IdeId
}

export interface LogLine {
  /** ISO 8601 */
  ts: string
  level: "info" | "warn" | "error"
  text: string
}

// ---------------------------------------------------------------------------
// Requirements ("This computer"; implemented in M2)

export type RequirementId =
  | "container-engine"
  | "wsl"
  | "xquartz"
  | "credential-helper"
  | "git-credentials"
  | "ide"

export interface RequirementStatus {
  id: RequirementId
  /** e.g. "Rancher Desktop", "Docker Engine", "XQuartz". */
  title: string
  state: "ok" | "warn" | "missing" | "working"
  version?: string
  /** Plain-language explanation of the current state. */
  detail: string
  /** Present when Silicon Harbor can fix or install it. */
  fix?: {
    label: string
    needsRelogin?: boolean
    needsReboot?: boolean
    /**
     * Safe to run without asking (no admin rights, no downloads), e.g.
     * starting an installed Rancher Desktop. Runs once per app session.
     */
    automatic?: boolean
  }
  /** Only on the "ide" requirement: every supported IDE, found or not. */
  ides?: IdeStatus[]
}

export interface IdeStatus {
  id: IdeId
  /** e.g. "IBM Bob", "Visual Studio Code". */
  label: string
  installed: boolean
  version?: string
  /** The vendor's download page (opened in the browser). */
  downloadUrl: string
  /** IBM Bob: the IDE we recommend. */
  recommended?: boolean
}

// ---------------------------------------------------------------------------
// Credentials (Settings › Credentials)

export interface GitHubAccount {
  login: string
  name?: string
  email?: string
}

/** The GitHub CLI sign-in for github.ibm.com, forwarded into environments. */
export interface GitHubCredential {
  /** e.g. "github.ibm.com" */
  host: string
  state:
    | "ok"
    /** gh is not installed (see "This computer"). */
    | "no-cli"
    | "signed-out"
    /** Stored, but the host rejects it. */
    | "invalid"
    /** Could not be checked (offline, host unreachable). */
    | "unknown"
  detail: string
  account?: GitHubAccount
  /** OAuth scopes of the token, e.g. ["gist", "read:org", "repo"]. */
  scopes?: string[]
  /** While a browser sign-in waits: the one-time code and the page to enter it on. */
  signIn?: { code?: string; url?: string }
}

/** The Artifactory identity token, mounted into environments. */
export interface ArtifactoryCredential {
  /** The Artifactory web page, e.g. "https://eu.artifactory.swg-devops.com/". */
  url: string
  state:
    | "ok"
    /** No token stored. */
    | "missing"
    /** Stored, but Artifactory rejects it. */
    | "invalid"
    /** Could not be checked (offline, Artifactory down, secret store locked). */
    | "unknown"
  detail: string
  /** The w3id (IBM email address) the token belongs to. */
  user?: string
}

export interface CredentialsStatus {
  github: GitHubCredential
  artifactory: ArtifactoryCredential
}

export interface SaveArtifactoryRequest {
  /** w3id (IBM email address). */
  user: string
  /** Empty keeps the stored token (only the w3id changes). */
  token: string
}

// ---------------------------------------------------------------------------
// Settings

export interface Settings {
  defaultIde: IdeId
  autoUpdateCheck: boolean
  /** Set once the first-run setup has been completed. */
  firstRunDone: boolean
}

// ---------------------------------------------------------------------------
// The API

export type Unsubscribe = () => void

export interface SiliconHarborApi {
  getAppInfo(): Promise<AppInfo>

  listEnvironments(): Promise<Environment[]>
  getEnvironment(id: string): Promise<Environment | null>
  /** Resolves as soon as the operation is submitted; progress arrives via onEnvironmentsChanged. */
  createEnvironment(req: CreateEnvironmentRequest): Promise<{ id: string }>
  /** Starts (if needed) and opens the IDE. */
  startEnvironment(id: string): Promise<void>
  stopEnvironment(id: string): Promise<void>
  rebuildEnvironment(id: string): Promise<void>
  deleteEnvironment(id: string): Promise<void>
  cancelOperation(id: string): Promise<void>
  /** Opens a running environment in its IDE (or the given one, which then becomes its IDE). */
  openInIde(id: string, ide?: IdeId): Promise<void>
  /** Opens the OS terminal with a shell inside the environment. */
  openTerminal(id: string): Promise<void>
  /** Log of the current/last operation (incl. setup output). */
  getLog(id: string): Promise<LogLine[]>
  /** Copies a redacted diagnostics text for this environment to the clipboard. */
  copyDiagnostics(id?: string): Promise<void>

  checkRequirements(): Promise<RequirementStatus[]>
  fixRequirement(id: RequirementId): Promise<void>

  /** Last known status (checks once on first call). */
  getCredentials(): Promise<CredentialsStatus>
  /** Checks again: asks github.ibm.com and Artifactory whether the sign-ins work. */
  checkCredentials(): Promise<CredentialsStatus>
  /** Starts the GitHub CLI browser sign-in; resolves when it finished or failed. */
  signInGitHub(): Promise<void>
  cancelGitHubSignIn(): Promise<void>
  /** Stores the w3id and token in Devsy's secret store and checks the token. */
  saveArtifactoryToken(req: SaveArtifactoryRequest): Promise<CredentialsStatus>
  removeArtifactoryToken(): Promise<CredentialsStatus>

  getSettings(): Promise<Settings>
  updateSettings(patch: Partial<Settings>): Promise<Settings>

  /** Full list on every change (state, operation progress). */
  onEnvironmentsChanged(cb: (envs: Environment[]) => void): Unsubscribe
  /** Live log lines for one environment. */
  onLog(id: string, cb: (line: LogLine) => void): Unsubscribe
  onRequirementsChanged(cb: (reqs: RequirementStatus[]) => void): Unsubscribe
  onCredentialsChanged(cb: (status: CredentialsStatus) => void): Unsubscribe
}

export const IpcChannel = {
  appInfo: "app:info",
  envList: "env:list",
  envGet: "env:get",
  envCreate: "env:create",
  envStart: "env:start",
  envStop: "env:stop",
  envRebuild: "env:rebuild",
  envDelete: "env:delete",
  envCancel: "env:cancel",
  envOpenIde: "env:open-ide",
  envOpenTerminal: "env:open-terminal",
  envLog: "env:log",
  diagnosticsCopy: "diagnostics:copy",
  reqCheck: "req:check",
  reqFix: "req:fix",
  credGet: "cred:get",
  credCheck: "cred:check",
  credGitHubSignIn: "cred:github-sign-in",
  credGitHubCancel: "cred:github-cancel",
  credArtifactorySave: "cred:artifactory-save",
  credArtifactoryRemove: "cred:artifactory-remove",
  settingsGet: "settings:get",
  settingsUpdate: "settings:update",
  // main → renderer events
  evtEnvironments: "evt:environments",
  evtLog: "evt:log",
  evtRequirements: "evt:requirements",
  evtCredentials: "evt:credentials",
} as const

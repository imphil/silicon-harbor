/**
 * In-memory implementation of SiliconHarborApi for development and tests.
 *
 * Timings, step sequences and failures follow the recorded Devsy behaviour in
 * test/fixtures/devsy and docs/devsy-contract.md:
 * - create: check → clone → start (image pull + container) → prepare → ide
 * - restart skips the clone; stop/delete only use "check"
 * - a repository URL containing "denied" fails like an expired icr.io login
 *   (BUILD_FAILED_RECOVERABLE, environment left in "failed")
 * - a URL containing "missing" fails the clone (UNKNOWN from git)
 * - cancel ends the operation; a cancelled create leaves a stopped environment
 *
 * Both failures happen once per environment, so "retry" succeeds afterwards.
 */
import type {
  AppInfo,
  CreateEnvironmentRequest,
  Environment,
  IdeId,
  LogLine,
  Operation,
  OperationKind,
  OperationStep,
  RequirementId,
  RequirementStatus,
  Settings,
  SiliconHarborApi,
  StepId,
  UserError,
} from "$shared/api"
import { ideLabels } from "./view"

export type MockScenario = "default" | "first-run" | "empty" | "all-ok"
export type MockPlatform = "mac" | "win" | "linux"

export interface MockOptions {
  scenario?: MockScenario
  platform?: MockPlatform
  /** Multiplies every delay; 0.05 makes operations near-instant for tests. */
  speed?: number
  /** Real app info when a bridge exists (versions etc.). */
  appInfo?: () => Promise<AppInfo>
  now?: () => number
}

const STEP_IDS: StepId[] = ["check", "clone", "start", "prepare", "ide"]

const ERRORS = {
  registryAuth: {
    code: "registry-auth",
    title: "Could not download the environment image",
    message:
      "Your IBM Cloud sign-in for icr.io has probably expired. Sign in again, then retry.",
    action: "sign-in-retry",
    cliCode: "BUILD_FAILED_RECOVERABLE",
  },
  cloneFailed: {
    code: "clone-failed",
    title: "Could not get the repository",
    message:
      "The repository does not exist or you do not have access to it. Check the address and that you can open it in your browser, then retry.",
    action: "retry",
    cliCode: "UNKNOWN",
  },
  cancelled: {
    code: "cancelled",
    title: "Cancelled",
    message:
      "You cancelled this operation. Start the environment when you are ready.",
    action: "retry",
    cliCode: "canceled",
  },
} satisfies Record<string, UserError>

type Phase = {
  step: StepId
  ms: number
  detail?: string
  logs: string[]
  fail?: UserError
}

type Running = {
  operationId: string
  timers: ReturnType<typeof setTimeout>[]
  /** What the environment becomes when the operation is cancelled. */
  cancelState: Environment["state"]
}

function requirementsFor(
  platform: MockPlatform,
  scenario: MockScenario,
): RequirementStatus[] {
  const allOk = scenario === "all-ok" || scenario === "empty"
  const firstRun = scenario === "first-run"
  const icr: RequirementStatus =
    firstRun && !allOk
      ? {
          id: "credential-helper",
          title: "docker-credential-icr",
          state: "missing",
          detail:
            "Not installed. Signs in to icr.io with your IBM Cloud login.",
          fix: { label: "Install" },
        }
      : {
          id: "credential-helper",
          title: "docker-credential-icr",
          state: "ok",
          version: "0.4.0",
          detail: "Signs in to icr.io with your IBM Cloud login.",
        }

  if (platform === "win") {
    return [
      {
        id: "wsl",
        title: "WSL 2",
        state: "ok",
        version: "2.6.1",
        detail: "WSLg shows graphical tools from your environments.",
      },
      firstRun
        ? {
            id: "container-engine",
            title: "Rancher Desktop",
            state: "missing",
            detail: "Not installed. Runs your environments.",
            fix: { label: "Install" },
          }
        : {
            id: "container-engine",
            title: "Rancher Desktop",
            state: "ok",
            version: "1.20.0",
            detail: "Running with dockerd (moby).",
          },
      icr,
      {
        id: "git-credentials",
        title: "Git for Windows",
        state: "ok",
        version: "2.51.0",
        detail: "Includes Git Credential Manager for github.ibm.com.",
      },
      { id: "ide", title: "IDE", state: "ok", detail: "IBM Bob" },
    ]
  }

  if (platform === "linux") {
    return [
      firstRun
        ? {
            id: "container-engine",
            title: "Docker Engine",
            state: "warn",
            version: "28.5",
            detail: "Installed, but your user is not in the docker group.",
            fix: { label: "Add me to the group", needsRelogin: true },
          }
        : {
            id: "container-engine",
            title: "Docker Engine",
            state: "ok",
            version: "28.5",
            detail: "Running.",
          },
      icr,
      {
        id: "ide",
        title: "IDE",
        state: "ok",
        version: "1.105",
        detail: "VSCodium",
      },
    ]
  }

  return [
    firstRun
      ? {
          id: "container-engine",
          title: "Rancher Desktop",
          state: "warn",
          version: "1.20.0",
          detail:
            "Uses the wrong engine (containerd). Silicon Harbor needs dockerd.",
          fix: { label: "Switch to dockerd" },
        }
      : {
          id: "container-engine",
          title: "Rancher Desktop",
          state: "ok",
          version: "1.20.0",
          detail: "Running with dockerd (moby).",
        },
    allOk
      ? {
          id: "xquartz",
          title: "XQuartz",
          state: "ok",
          version: "2.8.5",
          detail: "Shows graphical tools from your environments.",
        }
      : {
          id: "xquartz",
          title: "XQuartz",
          state: "missing",
          detail:
            "Not installed. Graphical tools in your environments will not open.",
          fix: { label: "Install", needsRelogin: true },
        },
    icr,
    {
      id: "git-credentials",
      title: "Git Credential Manager",
      state: "ok",
      version: "2.6.1",
      detail: "Signs in to github.ibm.com over HTTPS.",
    },
    {
      id: "ide",
      title: "IDE",
      state: "ok",
      version: "1.106",
      detail: "Visual Studio Code",
    },
  ]
}

// Wording after a fix, matching the real checks (src/main/requirements).
const FIXED_DETAIL: Partial<Record<RequirementId, string>> = {
  "container-engine": "Running with dockerd (moby).",
  xquartz: "Installed. Log out and back in once to finish.",
  "credential-helper": "Signs in to icr.io with your IBM Cloud login.",
}

/**
 * Fixes that still block environments until the user logs in again stay a
 * warning, as in the real backend (Linux docker group).
 */
function afterFix(
  platform: MockPlatform,
  req: RequirementStatus,
): Pick<RequirementStatus, "state" | "detail"> {
  if (platform === "linux" && req.id === "container-engine") {
    return {
      state: "warn",
      detail: "Added to the docker group. Log out and back in once to finish.",
    }
  }
  return {
    state: "ok",
    detail:
      FIXED_DETAIL[req.id] ??
      (req.fix?.needsRelogin
        ? "Done. Log out and back in once to finish."
        : "Done."),
  }
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "environment"
  )
}

function steps(): OperationStep[] {
  return STEP_IDS.map((id) => ({ id, state: "pending" }))
}

export function createMockApi(options: MockOptions = {}): SiliconHarborApi {
  const scenario = options.scenario ?? "default"
  const platform = options.platform ?? "mac"
  const speed = options.speed ?? 1
  const now = options.now ?? (() => Date.now())
  const iso = (offsetMs = 0) => new Date(now() - offsetMs).toISOString()

  const envs = new Map<string, Environment>()
  const logs = new Map<string, LogLine[]>()
  const running = new Map<string, Running>()
  /** Environments whose first operation fails (cleared after one failure). */
  const failOnce = new Map<string, "registry" | "clone">()

  let settings: Settings = {
    defaultIde: "vscode",
    autoUpdateCheck: true,
    firstRunDone: scenario !== "first-run",
  }
  let requirements = requirementsFor(platform, scenario)

  const envListeners = new Set<(envs: Environment[]) => void>()
  const logListeners = new Set<{ id: string; cb: (line: LogLine) => void }>()
  const reqListeners = new Set<(reqs: RequirementStatus[]) => void>()

  const delay = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, Math.round(ms * speed)))

  const list = () => [...envs.values()].map((e) => structuredClone(e))

  function emitEnvs(): void {
    const snapshot = list()
    for (const cb of envListeners) cb(snapshot)
  }

  function emitReqs(): void {
    const snapshot = structuredClone(requirements)
    for (const cb of reqListeners) cb(snapshot)
  }

  function log(
    id: string,
    text: string,
    level: LogLine["level"] = "info",
  ): void {
    const line: LogLine = { ts: iso(), level, text }
    const lines = logs.get(id) ?? []
    lines.push(line)
    logs.set(id, lines)
    for (const l of logListeners) if (l.id === id) l.cb(line)
  }

  function requireEnv(id: string): Environment {
    const env = envs.get(id)
    if (!env) throw new Error(`Environment "${id}" does not exist`)
    return env
  }

  function seed(): void {
    if (scenario === "first-run" || scenario === "empty") return
    const add = (env: Environment, lines: string[]) => {
      envs.set(env.id, env)
      logs.set(
        env.id,
        lines.map((text) => ({
          ts: env.lastUsedAt ?? iso(),
          level: "info",
          text,
        })),
      )
    }
    const done = (kind: OperationKind, ago: number): Operation => ({
      id: `op-seed-${kind}-${ago}`,
      kind,
      state: "succeeded",
      steps: STEP_IDS.map((id) => ({ id, state: "done" })),
      startedAt: iso(ago + 40_000),
      finishedAt: iso(ago),
    })
    add(
      {
        id: "core-rtl",
        name: "core-rtl",
        repoUrl: "https://github.ibm.com/chipdev/core-rtl",
        branch: "main",
        ide: "vscode",
        state: "running",
        operation: done("start", 2 * 3600_000),
        createdAt: iso(7 * 86400_000),
        lastUsedAt: iso(2 * 3600_000),
      },
      [
        "Starting environment core-rtl",
        "Environment is running",
        "Opened VS Code",
      ],
    )
    add(
      {
        id: "scan-flows",
        name: "scan-flows",
        repoUrl: "https://github.ibm.com/dft/scan-flows",
        branch: "feat/scan-compression",
        ide: "bob",
        state: "stopped",
        createdAt: iso(20 * 86400_000),
        lastUsedAt: iso(3 * 86400_000),
      },
      ["Stopped environment scan-flows"],
    )
    const failedOp: Operation = {
      id: "op-seed-failed",
      kind: "start",
      state: "failed",
      steps: [
        { id: "check", state: "done" },
        { id: "clone", state: "skipped" },
        {
          id: "start",
          state: "failed",
          detail: "Access to icr.io was denied.",
        },
        { id: "prepare", state: "pending" },
        { id: "ide", state: "pending" },
      ],
      error: ERRORS.registryAuth,
      startedAt: iso(86400_000 + 30_000),
      finishedAt: iso(86400_000),
    }
    add(
      {
        id: "cache-tb",
        name: "cache-tb",
        repoUrl: "https://github.ibm.com/chipdev/cache-tb",
        branch: "release/2.1",
        ide: "vscode",
        state: "failed",
        operation: failedOp,
        createdAt: iso(10 * 86400_000),
        lastUsedAt: iso(86400_000),
      },
      [
        "Starting environment cache-tb",
        "Downloading icr.io/chipdev/base:2.1",
        "docker-credential-icr: token expired, browser sign-in required",
        "Pull access denied for icr.io/chipdev/base: 401 Unauthorized",
      ],
    )
    failOnce.set("cache-tb", "registry")
  }
  seed()

  function plan(env: Environment, kind: OperationKind): Phase[] {
    const fail = failOnce.get(env.id)
    const ideName = ideLabels[env.ide]
    const phases: Phase[] = [
      {
        step: "check",
        ms: 300,
        logs: ["Checking Rancher Desktop … ready"],
      },
    ]
    if (kind === "create") {
      phases.push({
        step: "clone",
        ms: 1200,
        detail: `Cloning ${env.repoUrl.replace(/^https:\/\//, "")}`,
        logs: [
          `Cloning ${env.repoUrl}${env.branch ? ` (branch ${env.branch})` : ""}`,
          'git: using credential helper "manager"',
        ],
        fail: fail === "clone" ? ERRORS.cloneFailed : undefined,
      })
    }
    phases.push(
      {
        step: "start",
        ms: kind === "create" || kind === "rebuild" ? 2400 : 700,
        detail:
          kind === "create" || kind === "rebuild"
            ? "Downloading icr.io/chipdev/base · 2.1 GB"
            : "Starting the environment",
        logs: ["Pulling icr.io/chipdev/base:2.1", "Starting the environment"],
        fail: fail === "registry" ? ERRORS.registryAuth : undefined,
      },
      {
        step: "prepare",
        ms: kind === "start" ? 500 : 1600,
        detail:
          kind === "start"
            ? undefined
            : "Running postCreateCommand: make setup",
        logs: ["Injecting agent", "Running postCreateCommand: make setup"],
      },
      {
        step: "ide",
        ms: 500,
        logs: [`Opening ${ideName}`],
      },
    )
    return phases
  }

  function startOperation(env: Environment, kind: OperationKind): void {
    const opId = `op-${Math.random().toString(36).slice(2, 10)}`
    const op: Operation = {
      id: opId,
      kind,
      state: "running",
      steps: steps(),
      startedAt: iso(),
    }
    const cancelState: Environment["state"] =
      kind === "create"
        ? "stopped"
        : env.state === "failed"
          ? "stopped"
          : env.state
    env.state = "busy"
    env.operation = op
    const run: Running = { operationId: opId, timers: [], cancelState }
    running.set(env.id, run)
    emitEnvs()

    const verb: Record<OperationKind, string> = {
      create: "Creating",
      start: "Starting",
      stop: "Stopping",
      rebuild: "Rebuilding",
      delete: "Deleting",
    }
    log(env.id, `${verb[kind]} environment ${env.name}`)

    const finish = (
      state: Operation["state"],
      envState: Environment["state"],
      error?: UserError,
    ) => {
      op.state = state
      op.finishedAt = iso()
      if (error) op.error = error
      env.state = envState
      running.delete(env.id)
      emitEnvs()
    }

    if (kind === "stop" || kind === "delete") {
      op.steps = op.steps.map((s) =>
        s.id === "check"
          ? { ...s, state: "active" }
          : { ...s, state: "skipped" },
      )
      emitEnvs()
      run.timers.push(
        setTimeout(
          () => {
            op.steps[0].state = "done"
            if (kind === "delete") {
              running.delete(env.id)
              envs.delete(env.id)
              logs.delete(env.id)
              emitEnvs()
              return
            }
            log(env.id, "Environment stopped")
            finish("succeeded", "stopped")
          },
          Math.round(900 * speed),
        ),
      )
      return
    }

    const phases = plan(env, kind)
    const planned = new Set(phases.map((p) => p.step))
    for (const s of op.steps) if (!planned.has(s.id)) s.state = "skipped"

    let elapsed = 0
    phases.forEach((phase, index) => {
      const startAt = elapsed
      elapsed += phase.ms
      run.timers.push(
        setTimeout(
          () => {
            const step = op.steps.find((s) => s.id === phase.step)
            if (!step) return
            step.state = "active"
            step.detail = phase.detail
            for (const text of phase.logs) log(env.id, text)
            emitEnvs()
          },
          Math.round(startAt * speed),
        ),
      )
      run.timers.push(
        setTimeout(
          () => {
            const step = op.steps.find((s) => s.id === phase.step)
            if (!step) return
            if (phase.fail) {
              for (const t of run.timers) clearTimeout(t)
              step.state = "failed"
              step.detail =
                phase.fail.code === "registry-auth"
                  ? "Access to icr.io was denied."
                  : "The repository could not be cloned."
              log(
                env.id,
                `ERROR ${phase.fail.title}: ${phase.fail.message}`,
                "error",
              )
              failOnce.delete(env.id)
              finish("failed", "failed", phase.fail)
              return
            }
            step.state = "done"
            if (index === phases.length - 1) {
              env.lastUsedAt = iso()
              log(env.id, "Environment is ready")
              finish("succeeded", "running")
            } else {
              emitEnvs()
            }
          },
          Math.round(elapsed * speed),
        ),
      )
    })
  }

  function assertIdle(env: Environment): void {
    if (running.has(env.id)) {
      throw new Error(
        `${env.name} is busy. Wait until the current operation finishes.`,
      )
    }
  }

  const api: SiliconHarborApi = {
    async getAppInfo() {
      const mockPlatform =
        platform === "mac" ? "darwin" : platform === "win" ? "win32" : "linux"
      if (options.appInfo) {
        try {
          // Real versions, but the platform the mock simulates.
          return { ...(await options.appInfo()), platform: mockPlatform }
        } catch {
          // fall through to mock values
        }
      }
      return {
        appVersion: "0.0.0-mock",
        electronVersion: "mock",
        platform: mockPlatform,
        arch: "x64",
        devsyPath: null,
      }
    },

    async listEnvironments() {
      await delay(150)
      return list()
    },

    async getEnvironment(id) {
      const env = envs.get(id)
      return env ? structuredClone(env) : null
    },

    async createEnvironment(req: CreateEnvironmentRequest) {
      await delay(200)
      const base = slug(
        req.name?.trim() ||
          req.repoUrl
            .split("/")
            .pop()
            ?.replace(/\.git$/, "") ||
          "",
      )
      let id = base
      for (let n = 2; envs.has(id); n++) id = `${base}-${n}`
      const env: Environment = {
        id,
        name: req.name?.trim() || id,
        repoUrl: req.repoUrl.trim(),
        branch: req.branch?.trim() || undefined,
        ide: req.ide ?? settings.defaultIde,
        state: "busy",
        createdAt: iso(),
        lastUsedAt: iso(),
      }
      envs.set(id, env)
      if (/denied/i.test(env.repoUrl)) failOnce.set(id, "registry")
      if (/missing/i.test(env.repoUrl)) failOnce.set(id, "clone")
      startOperation(env, "create")
      return { id }
    },

    async startEnvironment(id) {
      const env = requireEnv(id)
      assertIdle(env)
      if (env.state === "running") {
        log(id, `Opening ${ideLabels[env.ide]}`)
        return
      }
      // A failed clone never produced an environment to start: retry the create.
      const failedCreate =
        env.operation?.kind === "create" &&
        env.operation.error?.code === "clone-failed"
      startOperation(env, failedCreate ? "create" : "start")
    },

    async stopEnvironment(id) {
      const env = requireEnv(id)
      assertIdle(env)
      startOperation(env, "stop")
    },

    async rebuildEnvironment(id) {
      const env = requireEnv(id)
      assertIdle(env)
      startOperation(env, "rebuild")
    },

    async deleteEnvironment(id) {
      const env = requireEnv(id)
      const run = running.get(id)
      if (run) {
        for (const t of run.timers) clearTimeout(t)
        running.delete(id)
      }
      startOperation(env, "delete")
    },

    async cancelOperation(id) {
      const env = requireEnv(id)
      const run = running.get(id)
      if (!run || !env.operation) return
      for (const t of run.timers) clearTimeout(t)
      running.delete(id)
      for (const s of env.operation.steps)
        if (s.state === "active") s.state = "pending"
      env.operation.state = "cancelled"
      env.operation.error = ERRORS.cancelled
      env.operation.finishedAt = iso()
      env.state = run.cancelState
      log(id, "Operation cancelled", "warn")
      emitEnvs()
    },

    async openInIde(id, ide?: IdeId) {
      const env = requireEnv(id)
      if (env.state !== "running") {
        throw new Error(`${env.name} is not running. Start it first.`)
      }
      if (ide) env.ide = ide
      env.lastUsedAt = iso()
      log(id, `Opening ${ideLabels[env.ide]}`)
      emitEnvs()
    },

    async openTerminal(id) {
      const env = requireEnv(id)
      if (env.state !== "running") {
        throw new Error(`${env.name} is not running. Start it first.`)
      }
      log(id, "Opened a terminal")
    },

    async getLog(id) {
      return structuredClone(logs.get(id) ?? [])
    },

    async copyDiagnostics(id) {
      const text = [
        "Silicon Harbor diagnostics (mock)",
        `platform: ${platform}`,
        ...(id
          ? (logs.get(id) ?? []).map((l) => `${l.ts} ${l.level} ${l.text}`)
          : []),
      ].join("\n")
      try {
        await navigator.clipboard?.writeText(text)
      } catch {
        // Clipboard access can be denied in tests; diagnostics are best effort.
      }
    },

    async checkRequirements() {
      await delay(400)
      return structuredClone(requirements)
    },

    async fixRequirement(id: RequirementId) {
      const req = requirements.find((r) => r.id === id)
      if (!req?.fix) return
      requirements = requirements.map((r) =>
        r.id === id ? { ...r, state: "working" } : r,
      )
      emitReqs()
      await delay(1200)
      requirements = requirements.map((r) =>
        r.id === id ? { ...r, ...afterFix(platform, r), fix: undefined } : r,
      )
      emitReqs()
    },

    async getSettings() {
      return { ...settings }
    },

    async updateSettings(patch) {
      settings = { ...settings, ...patch }
      return { ...settings }
    },

    onEnvironmentsChanged(cb) {
      envListeners.add(cb)
      return () => envListeners.delete(cb)
    },

    onLog(id, cb) {
      const entry = { id, cb }
      logListeners.add(entry)
      return () => logListeners.delete(entry)
    },

    onRequirementsChanged(cb) {
      reqListeners.add(cb)
      return () => reqListeners.delete(cb)
    },
  }
  return api
}

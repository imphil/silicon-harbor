import type { IdeId, StepId, UserError } from "../../shared/api"

/**
 * Error catalog: translates Devsy failures into plain language.
 *
 * Most failures arrive with code UNKNOWN (docs/developer/devsy/cli-contract.md §5), so we
 * match on the message as well. The CLI runs with LC_ALL=C, so git and Docker
 * messages are English.
 */

export interface FailureInput {
  code?: string
  message?: string
  hint?: string
  /** Error-level log lines from stderr; they often contain the real cause. */
  logErrors?: string[]
}

export type Classified =
  | { cancelled: true }
  | { cancelled: false; error: UserError; step?: StepId }

const IDE_NAMES: Record<IdeId, string> = {
  vscode: "VS Code",
  bob: "IBM Bob",
  codium: "VSCodium",
}

interface Rule {
  code: string
  test(input: { code: string; text: string }): boolean
  build(
    input: FailureInput & { ide?: IdeId },
  ): Omit<UserError, "code" | "cliCode">
  step?: StepId
}

const has = (text: string, ...patterns: RegExp[]) =>
  patterns.some((p) => p.test(text))

const RULES: Rule[] = [
  {
    code: "socket-path-too-long",
    test: ({ text }) => has(text, /socket path exceeds max/i),
    build: () => ({
      title: "Silicon Harbor's data folder path is too long",
      message:
        "The environment could not be connected because the folder Silicon Harbor uses is nested too deeply. Copy the diagnostics and contact the Silicon Harbor team.",
      action: "copy-diagnostics",
    }),
    step: "prepare",
  },
  {
    code: "engine-unreachable",
    test: ({ code, text }) =>
      code === "docker_daemon_unreachable" ||
      has(
        text,
        /failed to connect to the docker api/i,
        /cannot connect to the docker daemon/i,
        /is the docker daemon running/i,
        /error during connect/i,
        /docker cli is installed, but the selected/i,
      ),
    build: () => ({
      title: "The container engine is not running",
      message:
        "Silicon Harbor could not reach the container engine. Start Rancher Desktop (or Docker on Fedora) and try again.",
      action: "open-settings",
    }),
    step: "check",
  },
  {
    code: "registry-auth",
    test: ({ text }) =>
      has(text, /icr\.io/i) &&
      has(text, /denied/i, /unauthorized/i, /\b401\b/, /\b403\b/),
    build: () => ({
      title: "Your sign-in to IBM Container Registry has expired",
      message:
        "The environment image on icr.io could not be downloaded. Sign in with your IBM Cloud account again, then retry.",
      action: "sign-in-retry",
    }),
    step: "start",
  },
  {
    code: "image-access-denied",
    test: ({ code, text }) =>
      (code === "BUILD_FAILED_RECOVERABLE" ||
        has(text, /retrieve image|pull/i)) &&
      has(text, /denied/i, /unauthorized/i, /\b401\b/, /\b403\b/),
    build: () => ({
      title: "The environment image could not be downloaded",
      message:
        "Access to the image named in the repository's devcontainer.json was denied. Check that you have access to the registry, then retry.",
      action: "retry",
    }),
    step: "start",
  },
  {
    code: "image-not-found",
    test: ({ text }) =>
      has(text, /manifest unknown/i, /manifest for .* not found/i) ||
      (has(text, /retrieve image|pull/i) && has(text, /not found/i)),
    build: () => ({
      title: "The environment image does not exist",
      message:
        "The image named in the repository's devcontainer.json could not be found. Check the repository's environment definition.",
      action: "copy-diagnostics",
    }),
    step: "start",
  },
  {
    code: "git-auth",
    test: ({ text }) =>
      has(text, /git clone|inspect remote repository|clone repository/i) &&
      has(
        text,
        /authentication failed/i,
        /invalid username or (token|password)/i,
        /could not read username/i,
        /terminal prompts disabled/i,
        /\b403\b/,
        /permission denied/i,
      ),
    build: () => ({
      title: "Could not sign in to the Git server",
      message:
        "The repository could not be cloned because Git has no valid sign-in for it, or you have no access. Sign in to the Git server with Git once (for example by cloning the repository in a terminal), then retry.",
      action: "retry",
    }),
    step: "clone",
  },
  {
    code: "clone-failed",
    test: ({ text }) =>
      has(
        text,
        /git clone/i,
        /inspect remote repository/i,
        /clone repository/i,
        /repository not found/i,
      ),
    build: () => ({
      title: "The repository could not be cloned",
      message:
        "Check that the URL is correct and that you can reach the Git server (VPN), then retry.",
      action: "retry",
    }),
    step: "clone",
  },
  {
    code: "ide-launch-failed",
    test: ({ text }) =>
      has(
        text,
        /resolve executable/i,
        /install ssh extension/i,
        /cli dispatch/i,
        /uri dispatch/i,
      ),
    build: ({ ide }) => ({
      title: `${ide ? IDE_NAMES[ide] : "The IDE"} could not be opened`,
      message:
        "The environment is running, but the IDE could not be started. Check that it is installed, then use Open again.",
      action: "retry",
    }),
    step: "ide",
  },
  {
    code: "secrets-locked",
    test: ({ code }) => code === "unlock_required" || code === "unlock_failed",
    build: () => ({
      title: "Devsy's secret store is locked",
      message:
        "This environment needs secrets from Devsy's protected secret store. Copy the diagnostics and contact the Silicon Harbor team.",
      action: "copy-diagnostics",
    }),
  },
  {
    code: "rate-limited",
    test: ({ code }) => code === "RATE_LIMITED",
    build: () => ({
      title: "Too many requests",
      message:
        "A server rejected the request because of rate limiting. Wait a moment, then retry.",
      action: "retry",
    }),
  },
  {
    code: "timeout",
    test: ({ code }) => code === "deadline_exceeded",
    build: () => ({
      title: "The operation took too long",
      message:
        "A step did not finish in time. Check your network connection, then retry.",
      action: "retry",
    }),
  },
]

/** First line of a raw message, shortened for display. */
export function shortMessage(message: string, max = 300): string {
  const first = message.trim().split(/\r?\n/)[0] ?? ""
  return first.length > max ? `${first.slice(0, max - 1)}…` : first
}

export function classifyFailure(
  input: FailureInput,
  context: { ide?: IdeId } = {},
): Classified {
  const code = input.code ?? ""
  if (code === "canceled") return { cancelled: true }

  const text = [input.message, input.hint, ...(input.logErrors ?? [])]
    .filter(Boolean)
    .join("\n")

  for (const rule of RULES) {
    if (rule.test({ code, text })) {
      return {
        cancelled: false,
        error: {
          code: rule.code,
          cliCode: input.code,
          ...rule.build({ ...input, ide: context.ide }),
        },
        step: rule.step,
      }
    }
  }

  const detail = shortMessage(input.message ?? "")
  return {
    cancelled: false,
    error: {
      code: "unknown",
      cliCode: input.code,
      title: "Something went wrong",
      message:
        detail !== ""
          ? `Devsy reported: ${detail}`
          : "The operation failed without an error message.",
      action: "copy-diagnostics",
    },
  }
}

# The Devsy engine

How the main process implements `SiliconHarborApi` (`src/shared/api.ts`) on top of the Devsy CLI.
Background: [devsy-contract.md](cli-contract.md).

```
ipc.ts                  validates renderer input (zod), routes channels
  └─ environments.ts    EnvironmentService: state, operations, polling, events
       ├─ devsy/client.ts    typed commands, zod-validated output, DevsyError
       │    └─ devsy/runner.ts   spawns the CLI (protocol flags, streaming, cancel)
       ├─ devsy/progress.ts  Devsy phases → five user-facing steps (pure)
       ├─ devsy/errors.ts    error catalog → UserError (pure)
       └─ log-store.ts       per-environment JSON-lines logs in <userData>/logs
settings-store.ts · diagnostics.ts · terminal.ts
```

## CLI process

- Binary: `resources/bin/<os>-<arch>/devsy` (dev) or `<resources>/bin/devsy` (packaged).
- Flags on every call: `--log-level info --log-output json --result-format json` (not for `task logs`).
- Environment: **allow-list only** (`devsy/env.ts`) — Devsy stores its process environment in task state. Plus
  `LC_ALL=C` (stable English messages for the error catalog), `DEVSY_UI=true`,
  `DEVSY_HOME=~/.silicon-harbor` (`SH_DEVSY_HOME` overrides). macOS: `~/.rd/bin` and Homebrew added to `PATH`.

## Operations

| API               | Devsy                                                                                                                                        | Notes                                                                                                                                 |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| create            | `workspace up <url>[@branch] --id <id> [--display-name] --ide <ide> --ide-launch auto [--clone-into-volume] --detach` → `task logs --follow` | id is made unique first: `up --id` silently reuses an existing workspace. `--clone-into-volume` on macOS and Windows only (see below) |
| start / openInIde | `workspace up <id> --ide <ide> --detach` → follow                                                                                            | openInIde with another IDE runs `workspace set-ide` first                                                                             |
| rebuild           | `workspace up <id> --recreate --detach` → follow                                                                                             |                                                                                                                                       |
| stop / delete     | `workspace stop                                                                                                                              | delete <id>` (streams status events)                                                                                                  | delete of a missing workspace (exit 75) counts as success |
| cancel            | `workspace task cancel <taskId>` (or kills stop/delete)                                                                                      |                                                                                                                                       |
| re-attach         | `workspace task list` on start → follow running `up` tasks                                                                                   |                                                                                                                                       |

Before the first `up`: `provider list` → (`provider add docker --use=false`, `provider init docker`) →
`provider use docker`.

One operation per environment at a time (`BusyError`). A creation that fails before Devsy created a workspace
(e.g. clone failure) stays as a placeholder with the failed operation; Start retries it with the same id, Delete just
forgets it.

## State shown to the UI

`busy` while our operation runs; otherwise from `workspace status` (`Running`/`Stopped`/`Provisioning`/`Failed`).
After a cancelled `up`, Devsy may say `Running` although setup did not finish → shown as `failed` with the cancelled
operation. Polling: `workspace list --skip-platform` every 10 s plus `fs.watch` on `DEVSY_HOME`; `workspace status`
every 15 s, 4 in parallel, exponential backoff on failure (max 5 min).

Successful operations are cleared from `Environment.operation`; failed and cancelled ones stay until the next
operation. Setup output (`workspace logs --source setup --run <runId>`) is appended to the environment's log after each
`up`.

## Error catalog (`devsy/errors.ts`)

| code                                        | matched by                                           | action           |
| ------------------------------------------- | ---------------------------------------------------- | ---------------- |
| `registry-auth`                             | icr.io + denied/401/403                              | sign-in-retry    |
| `image-access-denied`                       | other registry denied                                | retry            |
| `image-not-found`                           | manifest unknown / not found                         | copy-diagnostics |
| `git-auth`                                  | git clone + auth failure text                        | retry            |
| `clone-failed`                              | other git clone failures                             | retry            |
| `engine-unreachable`                        | `docker_daemon_unreachable` or Docker connect errors | open-settings    |
| `socket-path-too-long`                      | "socket path exceeds max" (in stderr logs)           | copy-diagnostics |
| `ide-launch-failed`                         | opener stage prefixes                                | retry            |
| `secrets-locked`, `rate-limited`, `timeout` | Devsy codes                                          | —                |
| `unknown`                                   | everything else; quotes Devsy's first line           | copy-diagnostics |

## Tests

- Unit: `src/main/__tests__/*.test.ts`, mostly replaying `test/fixtures/devsy/` through `FixtureCli`.
- Integration (opt-in, real Docker, ~35 s with a cached image):
  `SH_INTEGRATION=1 SH_DEVSY_BIN=resources/bin/linux-x64/devsy npx vitest run src/main/__tests__/integration.test.ts`
  Uses a throwaway `/tmp/sh-*` home, `--ide none` and a private ssh config; asserts `~/.devsy` and
  `~/.ssh/config` are unchanged.

## Known gaps

- Live build output: setup logs are fetched after an `up`, not streamed while it runs.
- Requirements (`checkRequirements`/`fixRequirement`) are stubs until M2.
- `openTerminal` is untested on macOS/Windows.

## Source in a Docker volume (macOS, Windows)

On macOS and Windows, new environments are created with `--clone-into-volume`
(our Devsy fork). Devsy then clones the repository into a named Docker volume,
using a short-lived helper ("bootstrap") container, instead of into a
folder on the host that is bind-mounted into the container. Docker runs in a VM
on both platforms (Rancher Desktop, WSL 2), and file access across that
boundary is slow.

- The flag is only passed on create, and on a retried create. Devsy decides
  this once when it creates the workspace and ignores the flag, with a warning,
  for an existing one.
- No copy of the source exists on the host. Edits live in the volume and are
  visible only through the IDE or a terminal in the environment.
- All workspaces of the same repository share one content volume, each with its
  own worktree. Deleting an environment removes its worktree, and the volume
  once no worktree is left.
- Progress: the clone and container start run in a nested `up` inside the
  bootstrap container; the fork relays its phases. The bootstrap preparation
  (volume, helper image, helper container, agent) is reported as
  `cloning_repository` with the step "preparing the source volume". Fixture:
  `test/fixtures/devsy/n-volume-clone-logs-follow`.
- The helper container runs the nested `up`, including the repository's
  `initializeCommand` (there is no copy of the repository on the host to run
  it on). Like VS Code's "Clone Repository in Container Volume", which does
  the same. Its image follows VS Code's recipe
  (`cmd/internal/agentworkspace/bootstrap.Dockerfile` in the fork):
  `mcr.microsoft.com/devcontainers/base` Alpine (bash, git; pinned by digest)
  plus `git-lfs nodejs python3 npm make g++ docker-cli docker-cli-buildx
  docker-cli-compose`. The fork's release workflow publishes it (amd64 + arm64, public) as
  `ghcr.io/imphil/devsy-volume-bootstrap:<first 12 hex of the Dockerfile's
  sha256>`; Devsy pulls it on first use ("downloading the helper image") and
  only builds it locally if that fails. It has bash, which `#!/bin/bash`
  initialize scripts need.
- Setup output (lifecycle hooks such as `initializeCommand`, the image
  build) reaches the CLI through the helper container. Silicon
  Harbor reads it every 3 s during an `up` (`devsy workspace logs --source
  setup --run <id> --after <cursor>`; `--follow` can end before the run does)
  and shows it in the Log tab as it arrives.
- Every `up` passes `--wait-for postStartCommand`: all create and start hooks
  run before the IDE opens, with Git and GitHub CLI credentials
  ([](../credentials.md)). Their output is in the Log tab too.
- Not used on Fedora: Docker runs natively, and the host folder is fast and
  visible to host tools.

Set in `src/main/index.ts` (`cloneIntoVolumeFor`).

# The Devsy CLI contract (as observed)

Recorded 2026-11-19 against Devsy built from `devsy-org/devsy` @ `65c1a42` (`CGO_ENABLED=0 go build`, reports
`v0.0.0`), docker provider, local Docker 29.7 on Linux. Fixtures: [`test/fixtures/devsy/`](https://github.com/imphil/silicon-harbor/tree/main/test/fixtures/devsy).

Every call used the desktop app's protocol flags, `--log-level info --log-output json --result-format json`
(`--result-format` omitted for `task logs`), and the env `DEVSY_UI=true`, `DEVSY_HOME=<isolated dir>`.

Redactions in fixtures: `$DEVSY_HOME`, `$SCRATCH` (test folder), `$HOME`, `$USER`, `$HOSTNAME`. The host environment
inside `task list` results was removed (see "Security" below).

---

## 1. Commands

| Purpose             | Command                                                                                                                       | Output                                                                           | Typical time |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------ |
| Add docker provider | `provider add docker --use=false`                                                                                             | status events (`pipeline: provider`, `phase: installing_provider`)               | 0.5 s        |
| Init provider       | `provider init docker`                                                                                                        | status events (`ready`, `resolving_options`, `running_init`)                     | 70 ms        |
| Select provider     | `provider use docker`                                                                                                         | stderr log only                                                                  | 60 ms        |
| Create / start      | `workspace up <git-url\|local-path\|id> [--id ID] --ide <ide> --ide-launch auto\|headless\|skip [--ssh-config PATH] --detach` | one line: `{"kind":"task","id":"<taskId>","runId":"<uuid>"}`                     | 130 ms       |
| Follow progress     | `workspace task logs <taskId> --follow`                                                                                       | NDJSON status events, then one `result` (stdout) or `error` (stderr)             | until done   |
| Task snapshot       | `workspace task get <taskId>`                                                                                                 | latest status event (stdout), or the error envelope on stderr if failed (exit 1) | 70 ms        |
| All tasks           | `workspace task list`                                                                                                         | JSON array (status, phase, pid, result, …)                                       | 80 ms        |
| Cancel              | `workspace task cancel <taskId>`                                                                                              | task record with `status: failed`, `errorCode: canceled`                         | 110 ms       |
| List                | `workspace list --skip-platform`                                                                                              | JSON array of workspaces                                                         | 70 ms        |
| Status              | `workspace status <id> --timeout 15s`                                                                                         | `{"id","context","provider","state","lastOperation":{…}}`                        | 300–430 ms   |
| Stop                | `workspace stop <id>`                                                                                                         | status events directly on stdout (not detached)                                  | 1.7 s        |
| Delete              | `workspace delete <id>`                                                                                                       | status events directly on stdout                                                 | 0.8–2.4 s    |
| Setup log runs      | `workspace logs <id> --source setup --list --context default`                                                                 | `{"schemaVersion":1,"runs":[…],"hasMore"}`                                       | 70 ms        |
| Setup log read      | `workspace logs <id> --source setup --run <runId\|latest> --context default`                                                  | `{"schemaVersion":1,"run":{…},"records":[…]}`                                    | 0.6 s        |

Exit codes (`cmd/root.go`): `0` success · `1` failure · `75` retryable (workspace not found) ·
`79` `BUILD_FAILED_RECOVERABLE`.

Timings from this machine (image not cached): first `up` of `microsoft/vscode-remote-try-python` **32.6 s**
(clone 0.7 s, `starting_container` incl. ~1.4 GB image pull 34 s); restart of a stopped workspace **4.1 s**.

---

## 2. Envelopes

All NDJSON envelopes are on **stdout**; failures of `task logs` / `task get` put the final `error` envelope on
**stderr**. With `--log-output json`, `task logs` produced **no** zap log lines at all. The detailed build/hook
output lives in the setup log store (`workspace logs --source setup`), not in the task stream.

```json
// submit
{"kind":"task","id":"iqauycmxoilv","runId":"c70e50f1-…"}

// progress
{"kind":"status","schemaVersion":1,"pipeline":"workspace_up","operationId":"op-5","parentOperationId":"op-4",
 "phase":"starting_container","step":"…optional…","state":"started|succeeded|failed|skipped","durationMs":33958,
 "error":{"code":"BUILD_FAILED_RECOVERABLE","message":"…","hint":"…"}}

// success (last line)
{"kind":"result","outcome":"success","containerId":"782d…","remoteUser":"vscode",
 "remoteWorkspaceFolder":"/workspaces/try-python","runId":"c70e50f1-…"}

// failure (last line, stderr)
{"kind":"error","outcome":"error","code":"UNKNOWN|BUILD_FAILED_RECOVERABLE|canceled|…","message":"…",
 "hint":"…optional…","context":{"runId":"…"}}
```

Parsing rules that matter:
1. **Duplicates.** Many events appear twice: once with `pipeline: "workspace_up"` and once without `pipeline`
   (relayed from the inner worker). Dedupe on `(operationId, phase, state)`.
2. **`operationId` is not unique per stream.** `op-1…op-3` are reused after `preparing_devcontainer` finishes
   (outer vs. inner counters). Key progress by `phase`, not by `operationId`.
3. **`pipeline` is always `workspace_up`**, also for stop and delete. Use the command we ran, not `pipeline`.
4. **`step` is only set for stop/delete/provider** (human-readable strings like `"Waiting for workspace lock"`).
   `workspace up` emits phases only.
5. Image download has **no phase of its own**; it is inside `starting_container`.

---

## 3. Observed phase sequences

**Create (`up <git-url>`):**
`cloning_repository` → `resolving_config` → `initialize_command` → `preparing_devcontainer`
[ `starting_container` → `injecting_agent` → `running_lifecycle_hook` ] → `configuring_workspace` →
`launching_ide` → `ready`, then `result`.

**Start a stopped workspace (`up <id>`):** same without `cloning_repository`.

**Stop:** `stopping_workspace` with steps `Loading workspace`, `Waiting for workspace lock`,
`Checking workspace status`, `Checking shared machine`, `Stopping workspace resources`.

**Delete:** `deleting_workspace` with steps `Waiting for workspace lock`, `Checking workspace status`,
`Removing workspace resources`, `Cleaning local files`, plus nested `stopping_workspace` /
`Stopping before deletion`.

**Provider:** `installing_provider`; `ready` → `resolving_options` → `running_init`.

Defined but not observed (`pkg/status/status.go`): `building_image`, `configuring_ssh`, `importing_workspace`,
`rebuilding_workspace`, `resetting_workspace`, `running_command`, `starting_ssh_tunnel`, `waiting_for`, `failed`.

### Proposed mapping to Silicon Harbor's five steps

| User-facing step                    | Devsy phases                                                                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1 Checking this computer            | Silicon Harbor's own quick requirement check before submitting; shown as done when the first Devsy event arrives                                 |
| 2 Getting the repository            | `cloning_repository`, `importing_workspace` (skipped on restart)                                                                                 |
| 3 Downloading the environment image | `resolving_config`, `initialize_command`, `building_image`, `starting_container`                                                                 |
| 4 Preparing the environment         | `injecting_agent`, `running_lifecycle_hook`, `running_command`, `configuring_workspace`, `configuring_ssh`, `starting_ssh_tunnel`, `waiting_for` |
| 5 Opening the IDE                   | `launching_ide`, `ready`                                                                                                                         |

Because pulling and creating the container share `starting_container`, step 3 should be labelled
**"Downloading and starting the environment"** unless upstream adds a `pulling_image` phase.
Failure of any phase marks its step failed; `preparing_devcontainer` is only a parent and is not shown.

---

## 4. Status values

`workspace status` → `state`: observed `Provisioning` (during up), `Running`, `Stopped`, `Failed` (after the image
pull failure); defined also `Busy`, `NotFound`. `lastOperation` carries `{timestamp, pipeline, phase, state,
durationMillis, error?}`, so a `Failed` workspace already includes the error to show.

Not found → exit `75`, stderr `{"kind":"error","code":"UNKNOWN","message":"workspace not found for args: [id]"}`.

`workspace task list` → `status`: `running`, `succeeded`, `failed`, plus `phase`, `error`, `errorCode`, `errorHint`.

---

## 5. Failure cases

| Case                            | Fixture                          | What happens                                                                                                                                                                                                                                                                         |
| ------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Repo does not exist / no access | `i*-clone-fail-*`                | Fails **before any status event**, during "inspect remote repository" (`git clone --filter=blob:none --depth=1` into `/tmp/devsy-repo-inspect-*`, cleaned up). `code: UNKNOWN`, message contains git's raw stderr — **localized** (German on this machine). No workspace is created. |
| Image cannot be pulled          | `j*-image-fail-*`                | `starting_container` fails with `code: BUILD_FAILED_RECOVERABLE`, message `… DENIED: requested access to the resource is denied`; exit 79. Workspace remains with state `Failed`. This is what an expired icr.io login will look like.                                               |
| Cancel                          | `k*-cancel-*`                    | `task cancel` → stream ends with `{"code":"canceled","hint":"Retry the operation when ready."}`. **Pitfall:** afterwards `workspace status` says `Running` (the container was already up and the last recorded phase succeeded).                                                     |
| Docker unreachable              | `m*-docker-unreachable-*`        | `code: UNKNOWN` with the full `docker version` output as message — not the `docker_daemon_unreachable` code that exists in `pkg/clierr`.                                                                                                                                             |
| DEVSY_HOME path too long        | `x-agent-socket-path-too-long-*` | `up` fails: `agent socket path exceeds max (158 >= 104)`, `code: UNKNOWN`. See §6.                                                                                                                                                                                                   |

Defined codes (`pkg/clierr/errors.go`): `RATE_LIMITED`, `PANIC`, `UNKNOWN`, `BUILD_FAILED_RECOVERABLE`,
`docker_daemon_unreachable`, `canceled`, `deadline_exceeded`, `unlock_required`, `unlock_failed`,
`secret_backend_unavailable`, `secret_store_corrupt`, `secret_not_found`.
Observed: `UNKNOWN`, `BUILD_FAILED_RECOVERABLE`, `canceled`.

Consequence for the error catalog: git auth/clone failures and Docker-not-running arrive as `UNKNOWN`, so we need
message matching for now. Git's localized messages make that brittle → run the CLI with `LC_ALL=C` (or at least
`LC_MESSAGES=C`), and propose upstream codes (`git_clone_failed`/`git_auth_failed`, use of
`docker_daemon_unreachable`, `image_pull_denied`).

---

## 6. Isolation via DEVSY_HOME

Checked before/after: `~/.devsy` (recursive listing), `~/.cache`, `~/.ssh/config`, `~/.gitconfig`,
`~/.docker/config.json`, `/tmp/devsy*`, Docker containers and volumes. **Nothing outside DEVSY_HOME changed**, given
the two precautions below. `/tmp/devsy-local.sock` was never created (no daemon was started; the CLI does not need it).

Findings:
1. **Socket path length (blocker for the planned location).** Runtime sockets live in `$DEVSY_HOME/run/`
   (`devsy-ssh-agent-<8 hex>/listener.sock`); the limit is 104 bytes. A home under Electron's `userData`
   (`/Users/<user>/Library/Application Support/Silicon Harbor/devsy`) gives ~106 bytes on macOS and **fails**.
   → Use a short home, e.g. `~/.silicon-harbor` (≈73 bytes on macOS). Upstream option: separate env override for the
   runtime dir, or a shorter socket path.
2. **`~/.ssh/config` is written by default.** `workspace up` adds a `Host <id>.devsy` block (`--ssh-config`, default
   `~/.ssh/config`); delete removes it. The IDE's Remote-SSH extension reads that file, so Silicon Harbor should
   **keep the default** — this is an intended write outside DEVSY_HOME. The block contains:
   `ForwardAgent yes`, `ForwardX11 yes`, `ForwardX11Trusted yes` (→ X11 via SSH, hence XQuartz) and
   `ProxyCommand "<absolute path to devsy>" workspace ssh --stdio --context default --user <user> <id> --home "<DEVSY_HOME>"`.
   The bundled CLI path is therefore baked into the user's SSH config: it must stay stable across updates, and
   uninstall should remove the blocks.
3. **Temp clones** for remote inspection go to `os.TempDir()/devsy-repo-inspect-*` and are removed afterwards.
4. **Daemon socket** is hard-coded (`/tmp/devsy-local.sock`, `\\.\pipe\devsy-local.sock`), not derived from
   DEVSY_HOME. Not needed for CLI use; still an upstream fix before Silicon Harbor uses the daemon.
5. Without DEVSY_HOME, Linux uses `/tmp/devsy-<uid>` as runtime dir and macOS `~/.devsy/run`.

**Security:** `task list` returns, and `$DEVSY_HOME/state/tasks/<id>.json` (mode 0600) stores,
`result.SubstitutionContext.Env` — the **complete host environment** of the CLI process (182 variables here).
Silicon Harbor must not log or include `task list` output in diagnostics bundles unredacted, and should spawn the
CLI with a minimal environment. Worth raising upstream.

---

## 7. Provider setup

Fresh DEVSY_HOME has no providers. Desktop flow, reproduced: `provider add docker --use=false` →
`provider init docker` → `provider use docker`. Docker provider options include `DOCKER_HOST`, `DOCKER_CONTEXT`,
`DOCKER_PATH`, `DOCKER_BUILDER` and **`DOCKER_ELEVATION`** (`pkexec|sudo|doas|none`) for rootful daemons the user
cannot access. On Fedora that is an alternative to adding the user to the `docker` group. Per workspace:
`--provider-option KEY=VALUE` (e.g. pointing at Rancher Desktop's socket).

---

## 8. IDE launch (`--ide vscode|bob|codium`), from `pkg/ide/opener` and `pkg/ide/vscode`

Happens in phase `launching_ide`, unless `--ide-launch headless|skip`.

| `--ide`  | CLI looked up (PATH, then macOS app path)                  | URI scheme | SSH extension ensured         |
| -------- | ---------------------------------------------------------- | ---------- | ----------------------------- |
| `vscode` | `code` · `/Applications/Visual Studio Code.app/…/bin/code` | `vscode`   | `ms-vscode-remote.remote-ssh` |
| `codium` | `codium` · `/Applications/Codium.app/…/bin/codium`         | `codium`   | `jeanp413.open-remote-ssh`    |
| `bob`    | `bobide` · `/Applications/Bobide.app/…/bin/bobide`         | `bob`      | `jeanp413.open-remote-ssh`    |

Steps: resolve executable → list extensions → `--install-extension <ext>` if missing →
`<cli> --folder-uri vscode-remote://ssh-remote+<id>.devsy/<remoteWorkspaceFolder>`. If the CLI path fails, it falls
back to opening `<scheme>://vscode-remote/ssh-remote+<id>.devsy/<folder>` through the OS URL handler.
Error prefixes name the stage (`resolve executable`, `list extensions`, `install SSH extension`, `CLI dispatch`,
`URI dispatch`) — useful for the error catalog. Silicon Harbor's IDE check should look for the same CLI names and
paths.

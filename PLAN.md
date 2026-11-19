# Silicon Harbor — Project & Implementation Plan

An opinionated desktop frontend for [Devsy](https://github.com/devsy-org/devsy) for IBM chip developers.
Paste a Git URL → get a working environment open in your IDE. No container knowledge required.

- Status: planning, nothing implemented yet (2026-11-19)
- UI mockups (clickable): https://claude.ai/artifact/PQzbEuyTYp3fPAggPuVp3h

---

## 1. Decisions

| Topic                   | Decision                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App stack               | Electron + TypeScript, Svelte 5 + Carbon (`carbon-components-svelte`, `carbon-icons-svelte`), IBM Plex. Same toolchain as Devsy's desktop app (electron-vite, Biome, Vitest, Playwright) so code can move between the two                                                                                                                                           |
| Engine                  | Pinned Devsy CLI bundled in the app, invoked as subprocess with JSON output                                                                                                                                                                                                                                                                                         |
| Devsy context           | Isolated via `DEVSY_HOME=~/.silicon-harbor` (`%USERPROFILE%\.silicon-harbor` on Windows). Must be a **short** path: Devsy puts unix sockets under `$DEVSY_HOME/run/` and socket paths are limited to 104 bytes, so `~/Library/Application Support/…` fails. Daemon socket per home: fix on Devsy branch `sh/daemon-socket-per-home`; until merged, CLI-only polling |
| Devsy version           | Pinned per Silicon Harbor release _(default — confirm)_                                                                                                                                                                                                                                                                                                             |
| Provider                | Docker, local only. Remote machines later (SSH or custom provider, TBD)                                                                                                                                                                                                                                                                                             |
| Environment definition  | Repos ship a complete `devcontainer.json` (incl. X11). No fallback image, no extra mounts                                                                                                                                                                                                                                                                           |
| Git auth                | HTTPS only. macOS/Windows: via Git Credential Manager (GCM), checked and installed by us. Fedora: whatever git credential setup the user already has — not checked                                                                                                                                                                                                  |
| Registry auth           | `docker-credential-icr` for `icr.io` (works on macOS, Windows, Linux)                                                                                                                                                                                                                                                                                               |
| IDEs                    | VS Code, IBM Bob, VSCodium — Devsy installs open-remote-ssh into the IDE                                                                                                                                                                                                                                                                                            |
| Platforms               | macOS, Windows, Fedora (only Linux target)                                                                                                                                                                                                                                                                                                                          |
| Architectures           | macOS arm64 + x64, Windows x64, Fedora x86_64                                                                                                                                                                                                                                                                                                                       |
| Build                   | Linux-only CI; electron-builder cross-packages all targets                                                                                                                                                                                                                                                                                                          |
| Signing                 | None for now. macOS: ad-hoc signature (`rcodesign`) so it runs on Apple silicon. Windows: unsigned (SmartScreen warning accepted for beta)                                                                                                                                                                                                                          |
| Distribution            | Releases in a **private** repo on github.ibm.com. First install: user downloads in the browser                                                                                                                                                                                                                                                                      |
| Updates                 | Update check authenticates with the user's github.ibm.com credential from their git credential helper (`git credential fill`; GCM on macOS/Windows). Windows/Fedora: in-app update. macOS: "update available → download" until properly signed                                                                                                                      |
| Installs                | Users have admin rights. Vendor downloads only for now: checksum-verified, normal OS elevation prompt. IBM software catalog: not integrated (possible later)                                                                                                                                                                                                        |
| Fedora container engine | Fedora's `moby-engine` package, rootful, user in `docker` group                                                                                                                                                                                                                                                                                                     |

### Why Electron

Everything we ship is JS plus prebuilt binaries (Electron, Devsy CLI), so there is no native compile step per OS —
the only reliable way to build macOS and Windows from Linux. Wails needs CGo + the macOS SDK; Tauri does not
support macOS cross-builds. Same choice Devsy itself made.

**Rule: no native Node modules.** Devsy's desktop app needs native macOS/Windows CI runners mainly because of
`node-pty` (embedded terminal) and macOS signing/notarization/dmg. The Devsy CLI itself is `CGO_ENABLED=0` and
cross-compiles from Linux. Silicon Harbor therefore has no embedded terminal: "Open terminal" launches the OS terminal
running `devsy ssh <id>`.

---

## 2. UI structure

```
Top bar:  IBM Silicon Harbor | Environments | Settings |            ● Ready / ⚠ 1 issue
                                                                    └─ links to Settings › This computer
Environments (home)
  ├─ "New environment" dialog  ──► Environment page
  └─ Environment page  /environments/:id   states: starting · error · running · stopped
                                            tabs: Overview · Log
Settings  /settings/:section
  ├─ This computer   (requirements check — same component as first-run Setup)
  ├─ IDE             (default IDE)
  ├─ Updates
  └─ Support         (diagnostics bundle, log folder)
First run: "This computer" full-screen, no top bar, with "Continue" → Environments
```

Rules:
- Setup blocks only on first run. Later breakage shows a warning bar on Environments + header status, never blocks.
- "Open in <IDE>" on a running row opens the IDE directly; the environment page is for progress, problems, details.
- Closing the window quits the UI; environments keep running (Devsy/Docker own them). _(Tray icon: not planned.)_

---

## 3. Architecture

```
┌──────────────────────── Electron app ────────────────────────┐
│ Renderer (Svelte 5 + Carbon)                                 │
│   svelte-spa-router · rune-based stores · typed IPC client   │
├──────────────── preload (contextBridge, typed API) ──────────┤
│ Main process (Node/TS)                                       │
│   devsy/      run pinned CLI, parse JSON, stream logs        │
│   prereqs/    check · fix · install, per item, per OS        │
│   installers/ download, verify sha256, run elevated          │
│   ide/        detect Bob / VS Code / VSCodium                │
│   errors/     map raw failures → plain-language messages    │
│   updater/    GHE release check (auth via GCM)               │
│   diagnostics/ bundle logs + check results                   │
│   settings/   JSON settings file in userData                 │
└──────────────────────────────────────────────────────────────┘
          │ spawn                       │ spawn
     devsy CLI (bundled)          docker / rdctl / git / wsl / dnf …
```

Key design points:
- **Main process owns everything privileged.** Renderer has `contextIsolation`, no Node, a narrow typed API.
- **IPC contract in one place** (`src/shared/api.ts`): request/response calls + event streams (logs, progress, status).
  All CLI output validated with `zod` before it crosses into the UI.
- **Command runner abstraction** (`exec(cmd, args, opts)`): every external call goes through it → one place for
  logging, timeouts, env, and test fakes.
- **Isolated Devsy context:** set Devsy's home/config dir env var to `<userData>/devsy` (exact variable confirmed in M0).
- **Prerequisite module interface:**

  ```ts
  interface Requirement {
    id: string; title: string; platforms: Platform[];
    check(ctx): Promise<CheckResult>;          // ok | warn | missing, version, detail
    fix?(ctx, progress): Promise<FixResult>;    // may require relogin/reboot
    catalogUrl?: string;
  }
  ```
- **Error catalog:** known failure patterns (expired icr.io token, GCM auth failure, engine not running, disk full,
  network/VPN, devcontainer build failure) → title, explanation, primary action. Unknown errors → generic message +
  "Copy diagnostics".

## 3a. How Devsy's desktop app talks to the CLI (verified against devsy @ 65c1a42)

Source: `devsy/desktop/src/main/{cli,daemon-client,daemon-manager,watcher,ipc}.ts`, `src/shared/{cli-error,workspace-operation}.ts`.

**Two channels**
1. **CLI subprocess** (`CliRunner`) for everything. Each call adds `--log-output json` (zap JSON lines on stderr),
   `--result-format json` (result on stdout) and `--log-level`. Env: `DEVSY_UI=true`. At most 50 concurrent calls.
2. **Local daemon**, for fast list reads only: `devsy internal daemon-local` (spawned detached, health-checked every
   30 s) serves HTTP over `/tmp/devsy-local.sock` or `\\.\pipe\devsy-local.sock`: `/health`, `/list[?fresh=true]`,
   `/provider/list`, `/machine/list`, `/context/list`. Every daemon read falls back to the CLI.

**Long operations (up / start / rebuild / reset) — detached tasks**
```
devsy workspace up <git-url|id> [--id ID] [--provider P] [--ide bob|vscode|codium] [--ide-launch auto|headless|skip] --detach
  → stdout: {"kind": "...", "id": "<taskId>", "runId": "..."}
devsy workspace task logs <taskId> --follow      # NDJSON on stdout, zap logs on stderr
devsy workspace task cancel <taskId>
devsy workspace task list                        # re-attach after app restart
devsy workspace stop <id> · devsy workspace set-ide <id> <ide>
```
NDJSON envelopes on stdout:
- `{"kind":"status","schemaVersion":1,"phase","pipeline?","step?","state":"started|succeeded|failed|skipped","durationMs?","error?":{code,message,hint,context}}`
- `{"kind":"result","outcome":"success","containerId","remoteUser","remoteWorkspaceFolder","url?","warnings?","runId?"}`
- `{"kind":"error", …}`

→ This maps cleanly onto our five user-facing steps. M0 only has to collect the real `phase`/`step` values.

**Status**
- List: `devsy workspace list --skip-platform` (or daemon `/list`), polled; plus a chokidar watch on `~/.devsy` that
  triggers a re-poll.
- Per workspace: `devsy workspace status <id> --result-format json --timeout 15s` → `{"state": "Running|Busy|Stopped|…"}`,
  6 in parallel, exponential backoff on failure.

**Errors**: structured `cliError {code, message, hint?, context?}` in the zap stderr lines and in envelopes. These
codes are the input for our plain-language error catalog.

**Secrets**: Devsy has a passphrase-protected secret store. `workspace up` can fail with `unlock_required`.
Silicon Harbor will not enable protection; if it hits that error anyway, it shows a passphrase dialog.

**IDEs**: `bob` (IBM Bob), `vscode`, `codium` are built-in IDE ids. Bob's macOS path is `/Applications/Bobide.app`.

**Isolation finding**: `DEVSY_HOME` roots config, data and cache. **But** the daemon socket path is hard-coded
(`/tmp/devsy-local.sock`, `\\.\pipe\devsy-local.sock`), so a second home would talk to the _other_ home's daemon.
Devsy's desktop app also hard-codes `~/.devsy` for its file watch and logs.
→ Upstream fix: derive the socket name from `DEVSY_HOME`. Until then: CLI-only polling (enough for a handful of
environments) and our own file watch on `$DEVSY_HOME`.

### Corrections from the recorded fixtures (see `docs/devsy-contract.md`, `test/fixtures/devsy/`)

- **Phase order** of a first `up`: `cloning_repository` → `resolving_config` → `initialize_command` →
  `preparing_devcontainer` (with `starting_container`, `injecting_agent`, `running_lifecycle_hook`) →
  `configuring_workspace` → `launching_ide` → `ready`. Restart skips the clone (4 s vs. 33 s for a first create).
- **No separate image-pull phase**: pulling happens inside `starting_container`. Our step 3 becomes
  "Downloading and starting the environment" (upstream candidate: a `pulling_image` phase).
- **Parser rules**: dedupe events on operationId + phase + state (many arrive twice); key progress by `phase`, not
  `operationId` (reused); ignore `pipeline` (always `workspace_up`); `step` only set for stop/delete/provider ops.
- **Logs**: `task logs --follow` carries only envelopes; build output comes from `workspace logs --source setup`.
- **Errors**: clone failures (incl. no access), unreachable Docker and the socket-length error all come back as
  `UNKNOWN`; image pull denied → `BUILD_FAILED_RECOVERABLE` (exit 79, message contains "DENIED") — that's the expired
  icr.io case. Messages are localized → **run the CLI with `LC_ALL=C`**. Deleted workspace → exit 75.
- **State after failures**: failed clone creates no workspace; failed pull leaves one in `Failed` with
  `lastOperation.error`. After a cancel, `workspace status` may say `Running` → the UI tracks cancellation itself.
- **`~/.ssh/config`**: `up` adds a `Host <id>.devsy` block (with `ForwardX11 yes` and a ProxyCommand containing the
  absolute devsy path and `--home`). The IDE's remote-SSH extension depends on it → keep it; the bundled CLI path must
  stay stable across app updates (true for the macOS app bundle, the NSIS per-user install and the RPM); uninstall must
  remove our blocks.
- **Security**: `task list` output and `$DEVSY_HOME/state/tasks/*.json` contain the full host environment. → spawn
  the CLI with a minimal allow-listed environment, and redact task data in diagnostics bundles.
- **Fedora**: the docker provider has a `DOCKER_ELEVATION` option (pkexec/sudo/doas) — alternative to the `docker`
  group if adding users to it is unwanted.
- **IDE launch**: same for all three — Devsy finds `code` / `codium` / `bobide` on PATH (or the macOS app path),
  installs the remote-SSH extension if missing (`ms-vscode-remote.remote-ssh` for VS Code,
  `jeanp413.open-remote-ssh` for Codium and Bob), runs it with
  `--folder-uri vscode-remote://ssh-remote+<id>.devsy/<folder>`, falling back to the IDE's URL scheme.

**What we reuse**: port (MPL-2.0, file-level copyleft — fine for an internal tool) or, better, extract upstream into
a small shared client package:
- `CliRunner` (spawn, protocol flags, streaming, cancellation, redaction)
- envelope and `cliError` types/parsers
- the detached-up + follow-task flow (`runDetachedUp`)

We do **not** fork the desktop app: most of its ~12k lines of main process handle things we deliberately hide
(providers, contexts, machines, secrets UI, PTY, tray).

### Proposed repo layout

```
silicon-harbor/
  src/
    main/          Electron main: devsy/, prereqs/, installers/, ide/, errors/, updater/, diagnostics/, settings/
    preload/       contextBridge API
    renderer/      Svelte 5 + Carbon UI (routes, components, stores)
    shared/        IPC contract, types, zod schemas
  resources/
    devsy/         pinned version + checksums (binaries fetched at build time, not committed)
    installers/    manifest: per-prerequisite URLs, versions, sha256
  packaging/       electron-builder config, afterPack hook (rcodesign), release script
  test/
    unit/          vitest, fake command runner
    e2e/           Playwright (Electron) smoke tests
  docs/            user guide, spike results, release checklist
  .github/workflows/
```

---

## 4. Prerequisites — check and fix per platform

| Requirement               | macOS                                                                                                                                                          | Windows                                                                                      | Fedora                                                                                                                                                                                                     |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Container engine**      | Rancher Desktop. Check: app present, `rdctl` reachable, engine = moby, `docker info` ok. Fix: install dmg; `rdctl set --container-engine.name=moby`; start app | Rancher Desktop. Same checks. Fix: install MSI; switch to moby; start                        | `moby-engine`. Check: package installed, service active, user in `docker` group, `docker info` ok. Fix: `pkexec dnf install moby-engine`, `systemctl enable --now docker`, `usermod -aG docker` → re-login |
| **WSL 2 (+WSLg)**         | –                                                                                                                                                              | Check: `wsl --status`, version ≥ 2. Fix: elevated `wsl --install --no-distribution` → reboot | –                                                                                                                                                                                                          |
| **XQuartz**               | Check: `/Applications/Utilities/XQuartz.app`. Fix: pkg install (admin) → logout                                                                                | –                                                                                            | –                                                                                                                                                                                                          |
| **docker-credential-icr** | Check: on PATH, `credHelpers["icr.io"]="icr"` in `~/.docker/config.json`. Fix: download release to a dir on PATH, merge config (never overwrite other keys)    | same (Windows paths)                                                                         | same                                                                                                                                                                                                       |
| **Git + GCM**             | Check: `git`, `git credential-manager --version`, helper configured for github.ibm.com. Fix: install GCM pkg, `git credential-manager configure`               | Git for Windows (includes GCM). Fix: install Git for Windows                                 | Not checked — user's existing git setup                                                                                                                                                                    |
| **IDE (one of)**          | Detect Bob / VS Code / VSCodium in standard locations + PATH. Fix: link to installer / catalog                                                                 | same                                                                                         | same                                                                                                                                                                                                       |

Handling "needs re-login / reboot": record pending state in settings; show "Log out and back in to finish" and
re-check on next launch.

---

## 5. Milestones

Team: **two developers.** Two parallel tracks after M0:
- **Track A — engine & machine:** M1 Devsy integration → M2 Requirements → updater, diagnostics.
- **Track B — app & delivery:** packaging/CI (M0) → M3 UI against a mocked IPC API → wire to the real backend.

The mocked IPC API (fixture-driven, recorded Devsy outputs) lets Track B build the full UI before Track A finishes.
Plan: **beta (M4) at the end of week 8, pilot until week 10.** Week numbers below are calendar weeks with both
tracks running.

### M0 — Foundations & spikes (weeks 1–2, both)

Goal: remove the big unknowns and prove the build pipeline before writing features.
Much of the Devsy contract is already known (§3a), so task 3 shrinks to collecting real outputs and fixtures.

Tasks
1. Repo skeleton, mirroring Devsy's `desktop/` setup: electron-vite, TypeScript strict, Svelte 5 +
   `carbon-components-svelte`, Biome, Vitest, Playwright, svelte-check.
   Spike: `carbon-components-svelte` (0.114) is still written in Svelte 4 syntax (`export let`, slots,
   `on:` events). Svelte 5 compiles it alongside runes components. Check that the components we need work from runes
   pages, and note any deprecation warnings: DataTable with custom cells, Modal, ComposedModal, Tabs, SideNav,
   Header, InlineNotification, ToastNotification, ProgressIndicator, TextInput, Select, RadioTile.
2. CI on Linux producing installable artifacts:
   - macOS: `.app` → ad-hoc sign with `rcodesign` in an afterPack hook → `.zip` (x64 + arm64).
     (`.dmg` needs macOS tooling — ship zip for now.)
   - Windows: NSIS installer (`signAndEditExecutable: false` to avoid needing Wine; verify icon/metadata).
   - Fedora: `.rpm` (built in a Fedora container).
3. Devsy contract — record real outputs as test fixtures (`test/fixtures/devsy/`):
   - full `workspace up --detach` + `task logs --follow` runs (success, icr.io 401, clone auth failure, build failure)
   - the real set of `phase`/`step` values → mapping to our five steps
   - `workspace list` / `status` outputs; `cliError.code` values seen
   - `DEVSY_HOME` isolation in practice; the docker provider pointed at Rancher Desktop / moby
   - upstream PR: daemon socket path derived from `DEVSY_HOME`
4. Credential spike: private github.ibm.com repo over HTTPS inside the container (GCM on macOS/Windows, the
   user's existing helper on Fedora);
   `icr.io` pull with docker-credential-icr including the expired-token path.
5. IDE spike: open the same environment in Bob, VS Code, VSCodium on each OS.
6. X11 spike: one GUI tool from a container on XQuartz, WSLg, Fedora Wayland.
7. Update spike: read latest release + download asset from the private github.ibm.com repo using a token from
   `git credential fill`.

Exit criteria: hello-world Carbon app installs and starts on all 3 OS from Linux CI artifacts; devsy contract
documented; all spikes green or with a written workaround.

### M0 status (2026-11-19)

- Devsy contract recorded: 43 fixture cases + `docs/devsy-contract.md`.
- Upstream daemon-socket fix written and tested (branch `sh/daemon-socket-per-home` in the Devsy repo, uncommitted).
- Skeleton done: Electron + Svelte 5 + Carbon, typed IPC, lint/check/unit tests (11) and Playwright smoke tests (6)
  green. Carbon/Svelte 5 verdict: go (`docs/spikes/carbon-svelte5.md`).
- Packaging from Linux (`docs/spikes/packaging.md`): macOS zip x64 + arm64 ad-hoc signed with rcodesign ✔, Fedora RPM ✔,
  Windows zip ✔. **Windows NSIS installer needs Wine** (electron-builder builds the uninstaller with it) — not yet
  verified; CI installs Wine on the ubuntu runner.
- Devsy binaries pinned (v1.27.1) and fetched with sha256 check by `scripts/fetch-devsy.mjs`.
- Remaining M0: NSIS via Wine; first manual install on the macOS and Windows test machines; real-world spikes
  (github.ibm.com repo + icr.io + IDEs + X11) on those machines; app icons.

### M1 + M3 status (2026-11-19)

- M1 engine done (`docs/engine.md`): CLI runner with allow-listed env + `LC_ALL=C`, docker provider bootstrap,
  detached up/stop/delete/cancel with re-attach, five-step progress, status polling + file watch, per-environment
  logs, error catalog, settings, diagnostics, open IDE/terminal. Opt-in Docker integration test passed locally.
- M3 UI done: all screens from the mockups, mock backend (`npm run dev:mock`) with fixture-based scenarios.
- Integrated: 102 unit tests + 14 e2e tests (mock flows and the real backend) green; tests use a throwaway Electron
  profile and Devsy home.
- Known gaps: setup/build output reaches the log only after an `up` finishes; "Open terminal" untested on
  macOS/Windows; Check-for-updates disabled; contract wishes from M3 — `copyDiagnostics` should report what was
  copied, and a way to dismiss a failed create without deleting it.
- Risk noted: proxy variables with embedded credentials are passed to Devsy and end up in its task state.

### M2 status (2026-11-19)

- Requirements implemented (`docs/requirements.md`): Rancher Desktop (macOS/Windows), Docker Engine / Fedora
  `moby-engine` + docker group, WSL 2, XQuartz, docker-credential-icr + Docker config merge, Git Credential Manager
  (macOS) / Git for Windows, IDE detection. Checks run at start and on demand; fixes via the OS prompt; pending
  re-login/reboot remembered.
- Installer manifest with real versions and sha256 from GitHub release metadata: Rancher Desktop 1.25.0,
  XQuartz 2.8.6, GCM 3.0.2, Git for Windows 2.56.1. **docker-credential-icr has no published release** → no
  automatic install yet (installer refuses; the check says to put it on PATH).
- Verified here: unit tests with fakes for all three platforms; read-only checks on this Linux machine (Docker ok,
  credential helper missing, VS Code found). Not verified: any real fix/installer — needs the macOS, Windows and
  Fedora test machines.
- docker-credential-icr installs into a directory on the user's own PATH (macOS `/usr/local/bin` with admin prompt, Fedora `~/.local/bin`, Windows per-user folder added to the user PATH), so the shared `credHelpers` entry also works in the user's own terminal; that directory is also prepended to the Devsy CLI's PATH.

### M1 — Engine integration (weeks 3–4, Track A)

Tasks
1. Command runner: port `CliRunner` (protocol flags, streaming, cancellation, redaction).
2. Devsy module: resolve the bundled binary, set `DEVSY_HOME`, bootstrap the docker provider on first use.
3. Operations via detached tasks: create/start/rebuild = `workspace up … --detach` + `task logs --follow`;
   stop, delete, `set-ide`, cancel; re-attach to running tasks on app start (`task list`).
4. Status: polling `workspace list` + `workspace status` with backoff; file watch on `$DEVSY_HOME`.
5. Progress model: status envelopes → five user-facing steps; full log to a per-environment log file.
6. Error catalog v1, keyed by `cliError.code`.
7. Typed IPC API + zod schemas; unit tests against the M0 fixtures.

Exit criteria: from a dev build, a test script creates, opens, stops and deletes a real chip repo environment on all
3 OS through the main-process API.

### M2 — Prerequisites (weeks 4–7, Track A)

Tasks
1. Requirement interface + registry; platform detection (OS, arch, Fedora version).
2. Check implementations for every row in §4.
3. Installer framework: manifest (URL, version, sha256 per OS/arch), download with progress, verify, elevated run
   (macOS `installer` via admin prompt, Windows UAC, Fedora `pkexec`).
4. Fix implementations: Rancher Desktop → moby, docker group, `credHelpers` merge, GCM configure (macOS).
5. Pending re-login/reboot handling.
6. Software-catalog links as alternative per item.

Exit criteria: a fresh VM per OS goes from nothing to all-green using only the app plus OS prompts.

### M3 — User interface (weeks 3–7, Track B; built against the mocked API first, real backend from week 5)

Tasks
1. App shell: top bar navigation, health status indicator, routing.
2. First-run Setup (full-screen "This computer").
3. Environments list: status tags, primary action per state, overflow menu, empty state, issue warning bar, search.
4. New environment dialog: URL validation (HTTPS only), derived name, options (branch, name, IDE).
5. Environment page: states starting / error / running / stopped; Overview + Log tabs; delete confirmation.
6. Settings: This computer, IDE, Updates, Support.
7. Live updates: status polling/events, toasts for background completions.
8. Accessibility pass (keyboard, focus, screen-reader labels) — Carbon gives most of it.

Exit criteria: every flow in the mockups works end-to-end against the real backend on all 3 OS.

### M4 — Updates, diagnostics, beta (weeks 7–8, both)

Tasks
1. Updater: authenticated release check; Windows/Fedora in-app install; macOS notify + download.
2. Diagnostics bundle: app log, Devsy logs, check results, versions — no source, no credentials (redaction tests).
3. Crash/unhandled-error handling with a user-visible "something went wrong" + bundle.
4. E2E smoke tests (Playwright for Electron) in CI on Linux; manual test checklist for macOS/Windows.
5. User docs: install (incl. Gatekeeper/SmartScreen first-launch steps), troubleshooting.
6. Release script: tag → CI → draft release on github.ibm.com with all artifacts + checksums.

Exit criteria: `v0.1.0` beta published; installs and updates to `v0.1.1` on all 3 OS.

### M5 — Pilot (weeks 9–10)

One team (5–10 developers), weekly fixes, error catalog extended from real failures, decide on 1.0 scope.

### Later

Remote machines (provider TBD) · `silicon-harbor://open?repo=…` deep links ("Open in Silicon Harbor" buttons in
READMEs) · proper code signing + macOS auto-update · dark theme (Carbon g100).

---

## 6. Testing strategy

| Level         | What                                                                                                                             | Where                                                                                                                                       |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit          | Requirement checks/fixes, Devsy output parsing, error catalog, config merging — all via fake command runner and recorded outputs | CI (Linux)                                                                                                                                  |
| Integration   | Devsy module against real Docker in a Fedora container                                                                           | CI (Linux)                                                                                                                                  |
| E2E smoke     | App starts, navigation, New-environment flow with stubbed backend                                                                | CI (Linux, Playwright)                                                                                                                      |
| Manual matrix | Fresh install → setup → create → open in each IDE → update                                                                       | Available macOS (arm64 + x64) and Windows test machines, plus Fedora — per release, using a written checklist (`docs/release-checklist.md`) |

---

## 7. Upstream Devsy contributions (candidates)

- **Daemon socket path derived from `DEVSY_HOME`** — done on branch `sh/daemon-socket-per-home` (CLI + desktop client
  - tests), ready for review.
- Specific `cliError` codes for clone/auth failure, Docker unreachable, socket path too long.
- A `pulling_image` phase (with progress) so the UI can show the download separately.
- Don't persist the full host environment in task state / `task list` output.
- Desktop app: derive the watched dir and log dir from `DEVSY_HOME` instead of `~/.devsy` (consistency).
- Optional: extract `CliRunner` + envelope types into a reusable package shared by both frontends.
- Whatever M0 shows is missing (e.g. stable `phase` names documented as an API).

Already available upstream (no work needed): structured status/result/error envelopes, `cliError` codes, detached
tasks, IBM Bob / VSCodium IDE support.

---

## 8. Risks

| Risk                                                      | Impact                    | Mitigation                                                           |
| --------------------------------------------------------- | ------------------------- | -------------------------------------------------------------------- |
| Devsy CLI output changes between versions                 | UI breaks                 | Pin version; contract tests on recorded output; upstream stable JSON |
| macOS Gatekeeper friction with ad-hoc signing             | Users can't start the app | Documented first-launch step; prioritise IBM signing once available  |
| Rancher Desktop config/engine drift (users switch engine) | Environments fail         | Check on every launch; one-click fix                                 |
| GCM credential not usable inside container on some OS     | Clone/push fails          | M0 spike; fallback documented                                        |
| Corporate network/VPN/proxy issues                        | Pulls/clones fail         | Error catalog entry; proxy settings passed through if needed         |
| Electron app size (~100 MB+)                              | Download size             | Acceptable for internal tool                                         |

---

## 9. Open questions

1. Isolated Devsy context (`DEVSY_HOME`) and one pinned Devsy version per release — proceeding with this as default.

Decided:
- UI framework: Svelte 5 + `carbon-components-svelte`, so components and stores can be lifted from Devsy's desktop app.
- Architectures: macOS arm64 + x64; Windows and Fedora x86_64 only.
- Installers: vendor downloads; no software-catalog integration for now.
- Fedora: no GCM check or install.
- Testing: macOS and Windows machines available for manual tests; no macOS/Windows CI runners assumed.

Deferred: repository name and location.

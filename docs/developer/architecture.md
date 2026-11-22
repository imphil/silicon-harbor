# Architecture

```text
┌──────────────────────── Electron app ────────────────────────┐
│ Renderer  src/renderer   Svelte 5 + Carbon, rune-based stores │
├──────────── preload  src/preload  (contextBridge, typed API) ─┤
│ Main process  src/main                                        │
│   devsy/         run the pinned CLI, parse its JSON, errors   │
│   environments   operations, status, delivery of secrets      │
│   requirements/  check · fix per item and platform            │
│   installers/    download, verify sha256, run elevated        │
│   credentials/   github.ibm.com, Artifactory, IBM Cloud        │
│   diagnostics, settings-store, log-store, terminal            │
└───────────────────────────────────────────────────────────────┘
          │ spawn                         │ spawn
     devsy CLI (bundled)          docker / rdctl / git / gh / wsl / dnf …
```

- **The main process owns everything privileged.** The renderer runs with context isolation and no
  Node; it sees only the typed API of the preload script.
- **One IPC contract:** `src/shared/api.ts` defines every call and event. All CLI output is validated
  with zod (`src/main/devsy/schemas.ts`) before it reaches the UI.
- **One command runner:** every external command goes through `Host`
  (`src/main/requirements/host.ts`) or the Devsy client, so logging, timeouts, environment and test
  fakes live in one place.
- **An isolated Devsy home** (`~/.silicon-harbor`), separate from a user's own Devsy.
- **An error catalog** (`src/main/devsy/errors.ts`) turns known failures into a title, a
  plain-language message and one action; anything else becomes "Something went wrong" with
  **Copy diagnostics**.

## UI structure

```text
Top bar:  Silicon Harbor | Environments | Settings |                ● Ready / ⚠ 1 issue
                                                                    └─ links to Settings › This computer
Environments (home)
  ├─ "New environment" dialog  ──► Environment page
  └─ Environment page  /environments/:id   states: starting · error · running · stopped
                                            tabs: Overview · Log
Settings  /settings/:section
  ├─ This computer   (requirements check, same component as first-run setup)
  ├─ Credentials     (github.ibm.com, Artifactory, IBM Cloud)
  ├─ IDE             (default IDE)
  ├─ Updates
  └─ Support         (diagnostics)
First run: "This computer" full-screen, no top bar, with "Continue" → Environments
```

- Setup blocks only on first run. Later breakage shows a warning bar on Environments and the header
  status, and never blocks.
- "Open in <IDE>" on a running row opens the IDE directly; the environment page is for progress,
  problems and details.
- Closing the window quits the UI; environments keep running (Devsy and Docker own them).

## Where to read on

- [](devsy/engine.md): how operations, status and logs are driven through the Devsy CLI.
- [](devsy/cli-contract.md): what the CLI actually prints, recorded.
- [](requirements.md): the computer check and its fixes.
- [](credentials.md): sign-ins, Artifactory tokens and secrets in environments.

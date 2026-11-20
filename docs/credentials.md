# Credentials in environments

Settings › Credentials shows the sign-ins environments use and whether they work.
Code: `src/main/credentials/` (main process), `CredentialsPane.svelte` (renderer).

## GitHub (github.ibm.com)

The GitHub CLI (gh) on the host is the only GitHub sign-in, on every platform.

| Where                               | How it gets the sign-in                                                                                                                                                                                                                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Git on the host (clone during `up`) | `gh auth setup-git --hostname github.ibm.com` makes gh Git's credential helper for that host. Devsy's Git credential forwarding (context option `SSH_INJECT_GIT_CREDENTIALS`, on by default) runs the host's `git credential fill`, which gh answers.                                                   |
| Git in the environment              | The same forwarding, while the IDE or a terminal is connected (`devsy workspace ssh` starts the credentials server).                                                                                                                                                                                    |
| gh in the environment               | Devsy's GitHub CLI forwarding, context option `SSH_INJECT_GITHUB_CREDENTIALS=true`. Silicon Harbor sets it on its own Devsy home the first time it runs `up` (`EnvironmentService.ensureProvider`). The environment needs gh installed; Devsy wraps it. Works while the IDE or a terminal is connected. |

The forwarded token reaches every host account gh knows (also a github.com login, if the user has one). Code in the
environment can use it for the GitHub API.

### Sign-in

`gh auth login --hostname github.ibm.com --git-protocol https --web` runs without a terminal. gh then prints
`First copy your one-time code: XXXX-XXXX` and `Open this URL to continue in your web browser: <url>` and waits
(cli/cli `internal/authflow/flow.go`). Silicon Harbor reads both lines, opens the page, copies the code to the
clipboard and shows it in the pane. When gh exits successfully, it runs `gh auth setup-git`. The "Sign in" fix on
"This computer" uses the same sign-in (`GitHubSignIn`, one at a time).

### Status check

`gh api --hostname github.ibm.com --include user` returns the account (login, name, email) and the token's scopes
(`X-OAuth-Scopes`). It runs quiet: the setup log records the command, not the account details. A 401 is
"rejected, sign in again"; exit 4 or a missing `hosts.yml` entry is "not signed in"; anything else is "not checked"
with gh's message.

## Artifactory

Artifactory has no sign-in flow Silicon Harbor can drive. The pane shows how to create an identity token on
<https://eu.artifactory.swg-devops.com/> and stores what the user pastes:

| Value                                         | Devsy secret           | In the environment               |
| --------------------------------------------- | ---------------------- | -------------------------------- |
| Token                                         | `SH_ARTIFACTORY_TOKEN` | `/run/secrets/ARTIFACTORY_TOKEN` |
| w3id (defaults to the GitHub account's email) | `SH_IBM_USER`          | `/run/secrets/IBM_USER`          |

- **Storage:** `devsy secret set NAME --stdin`; the value never appears on a command line. Devsy's `auto` backend
  uses the OS password store (Windows Credential Manager, macOS Keychain, Secret Service); without one, an
  age-encrypted file in the Devsy home. The keychain entry is not separate per Devsy home, hence the `SH_` prefix.
- **Check:** `GET` on a file in the electric-vapor RPM repository with the token as bearer; 200 is valid, 401/403
  rejected.
- **Into environments:** every `up` (create, start, rebuild) gets
  `--secret SH_IBM_USER,type=mount,target=IBM_USER --secret SH_ARTIFACTORY_TOKEN,type=mount,target=ARTIFACTORY_TOKEN`
  for the secrets that exist. Only names are passed; a locked or unreadable store means no flags, never a failed
  `up`.

### What the environment sees (verified 2026-11-20, Linux, `--clone-into-volume`, Devsy phw.6)

- `/run/secrets` is a tmpfs (`mode=755`, `noexec`) owned by root; each file is `0600`, owned by the container user.
- If `devcontainer.json` mounts its own volume at `/run/secrets` (electric-vapor's `electric-vapor-secrets`, shared
  by its containers), Devsy writes the files into that volume instead (fork, from phw.8; before, Docker failed
  with "Duplicate mount point"). They then persist there and every container with that volume sees a new value at
  once. No recreation is needed. Verified 2026-11-20 on Linux with a volume clone.
- The files exist before the lifecycle hooks run: a deferred `postCreateCommand` read both as the container user.
- `mkdir -p /run/secrets` succeeds; new files cannot be created there (root-owned directory), existing ones can be
  overwritten by the container user.
- Every `up` rewrites the files, so a new token reaches an environment at its next start (per Devsy's source,
  `pkg/devcontainer/setup/setup.go`; not tested yet).
- Devsy masks the values in hook output and setup history (`***`), including the w3id.
- Without such a volume, an environment created without these secrets is recreated once when it first starts with
  them (Devsy needs the tmpfs mount); changes outside the source folder are lost then. The pane says so.

## IBM Cloud (icr.io)

docker-credential-icr holds the IBM Cloud login Docker uses for icr.io images (environment images, the volume-clone
helper). It stores the token in the OS password store, refreshes it, and opens the IBM Cloud login in the browser
when it has no valid one.

- **Check:** Silicon Harbor asks the helper like Docker does (`docker-credential-icr get`, `icr.io` on stdin). A
  stored or refreshed token answers within seconds. Otherwise the pane shows "Log in to IBM Cloud in the browser
  window that opened" with Cancel, so the login comes there and not in the middle of creating an environment.
  It stops waiting after 10 minutes.
- **Account:** read from the token (an IAM JWT: `email`, `name`; not verified, only shown). The answer is never
  logged or passed on.
- **When:** with the other credentials, when the pane opens (and the last check is over 10 minutes old) or on
  "Check again". Never in the background: that could open a browser unexpectedly.

## How current the states are

| Page          | Checked                                                                                                                                                                                            |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| This computer | At app start, after each fix, on "Check again", when the page opens and the last check is over 10 minutes old, and every hour in the background (keeps the header's Ready / issue status current). |
| Credentials   | When the pane opens and the last check is over 10 minutes old, on "Check again", after a sign-in or a saved token. Not in the background.                                                          |

Each entry shows "Checked … ago".

## Lifecycle hooks: what they can use

Silicon Harbor runs every `up` with `--wait-for postStartCommand` (Devsy fork, v1.27.1-phw.7): `onCreateCommand`,
`updateContentCommand`, `postCreateCommand` and `postStartCommand` run before `up` returns and the IDE opens, while
the connection to this computer is open.

| Credential                                    | In those hooks                                                                                                                               | In `postAttachCommand`      |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Artifactory token and w3id (`/run/secrets/…`) | Yes (written before the hooks run)                                                                                                           | Yes                         |
| Git (HTTPS to github.ibm.com)                 | Yes: Devsy keeps its credential helper configured until container setup ends                                                                 | No (runs in the background) |
| gh                                            | Yes: `GH_ENTERPRISE_TOKEN` / `GH_TOKEN` from the host's gh accounts, `GH_HOST` for a single account; masked in output, never written to disk | No                          |

Verified 2026-11-20 on Linux with a volume clone and a local build of phw.7: the Git helper was configured during
`postCreateCommand` and gone afterwards; gh got a token (`GH_HOST=github.com` here, the only account of this
machine's gh); the Artifactory file was there. Hooks that a repository's `waitFor` puts later still run before `up`
returns: `--wait-for` only raises it.

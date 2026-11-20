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

Design: "Credentials for dev containers: design" (team doc), tab "v1 implementation". v1 covers the shared mode on
local containers; per-container tokens and remote environments come later.

Artifactory has no sign-in flow Silicon Harbor can drive. The pane shows how to create an identity token on
<https://eu.artifactory.swg-devops.com/>. Silicon Harbor uses it **once**, to create tokens of its own; the user can
revoke it afterwards. Code: `artifactory-tokens.ts` (tokens, files), `service.ts` (schedule, delivery).

### Two tokens

Both are access tokens created through the Access API on `na.artifactory.swg-devops.com`
(`POST /access/api/v1/tokens` with `{description, expires_in}`, the current token as bearer). eu and na accept the
same token. Artifactory has no refresh tokens: a token is renewed by creating a new one with it.

| Token     | Created from                     | Lifetime | Re-created                  | Description                          | Kept                                           |
| --------- | -------------------------------- | -------- | --------------------------- | ------------------------------------ | ---------------------------------------------- |
| Parent    | the identity token, later itself | 90 days  | when under 30 days are left | `silicon-harbor:<computerId>:parent` | `SH_ARTIFACTORY_PARENT`; never leaves the host |
| Container | the parent                       | 7 days   | when under half is left     | `silicon-harbor:<computerId>:shared` | `SH_ARTIFACTORY_TOKEN`; in every environment   |

- `<computerId>` is 12 random hex digits in `<userData>/computer-id`, so two computers of one user never touch each
  other's tokens.
- After a new parent, the old one is revoked (listed by description, `DELETE /access/api/v1/tokens/<id>`). An old
  container token is **not** revoked: environments that have not received the new one keep working until it
  expires on its own.
- Expiry and id come from the token (a JWT: `exp`, `jti`). A stored value that is not a JWT is an identity token
  saved before v1; the first renewal exchanges it for a parent.
- **Remove** revokes all of this computer's tokens (container tokens first, then the parent), deletes the secrets
  and leaves the released marker (below), so the repository's own scripts take over again.

### When it renews

`CredentialService.renewNow()`: 30 seconds after start, every hour, after the computer wakes up (`powerMonitor`
"resume"), and before each `up`. Each run creates only what is due, so almost all runs make no request. Runs are
serialized. A failure (offline, token rejected) is kept as `renewalError`, shown in the pane, and tried again at the
next run; it never fails an `up`. "Renew now" forces a new container token.

### Files in /run/secrets

| Devsy secret           | File                   | Content                                                                                        |
| ---------------------- | ---------------------- | ---------------------------------------------------------------------------------------------- |
| `SH_IBM_USER`          | `IBM_USER`             | w3id (defaults to the GitHub account's email)                                                  |
| `SH_ARTIFACTORY_TOKEN` | `ARTIFACTORY_TOKEN`    | the container token                                                                            |
| `SH_NETRC`             | `netrc`                | eu and na Artifactory with the container token; github.ibm.com with gh's token, if signed in   |
| `SH_JFROG_CONF`        | `jfrog-cli.conf`       | JFrog CLI config, version 6, one server `na-art` (default) with the container token            |
| `SH_MARKER`            | `.silicon-harbor.json` | `{"version":1,"managedBy":"silicon-harbor","mode":"shared","expiresAt":<epoch s>,"files":[…]}` |

- The files are rebuilt after every run and stored only when their content changed (also for a new gh token or
  w3id). A change makes Silicon Harbor deliver them.
- Every `up` gets `--secret <name>,type=mount,target=<file>` for the secrets that exist, the marker last. Only names
  are passed; a locked or unreadable store means no flags, never a failed `up`.
- Storage: `devsy secret set NAME --stdin`; values never appear on a command line. Devsy's `auto` backend uses the
  OS password store (Windows Credential Manager, macOS Keychain, Secret Service); without one, an age-encrypted file
  in the Devsy home. The keychain entry is not separate per Devsy home, hence the `SH_` prefix.
- After Remove the marker is `{"version":1,"managedBy":"none"}`, which tells the scripts to manage the files again.
- Container scripts check the marker with the helper in the design doc ("v1 implementation" tab) and skip their own
  token handling while it says `silicon-harbor` and has not expired.

### Delivery to running environments

Devsy writes the files on `up` only. When the files change, `EnvironmentService.deliverSecrets()` runs a quiet `up`
(no IDE launch, same `--wait-for` and secrets) for every environment in the "running" state. Environments busy with
another operation are skipped and tried again at the next renewal run; stopped ones get the files at their next
start. Devsy (fork, phw.9) replaces each file in one step (temp file and rename), so a reader never sees half a
token. Verified 2026-11-20 on Linux with a volume clone and a local build of phw.9, with Devsy's tmpfs and with a
`/run/secrets` volume from `devcontainer.json`: the second `up` replaced both files (new inodes) in the same
container, without recreating it.

### Status check

`GET` on a file in the electric-vapor RPM repository with the container token as bearer; 200 is valid, 401/403
rejected. The pane also shows when the container and the parent token expire.

### What the environment sees (verified 2026-11-20, Linux, `--clone-into-volume`, Devsy phw.6)

- `/run/secrets` is a tmpfs (`mode=755`, `noexec`) owned by root; each file is `0600`, owned by the container user.
- If `devcontainer.json` mounts its own volume at `/run/secrets` (electric-vapor's `electric-vapor-secrets`, shared
  by its containers), Devsy writes the files into that volume instead (fork, from phw.8; before, Docker failed
  with "Duplicate mount point"). They then persist there and every container with that volume sees a new value at
  once. No recreation is needed. Verified 2026-11-20 on Linux with a volume clone.
- The files exist before the lifecycle hooks run: a deferred `postCreateCommand` read both as the container user.
- `mkdir -p /run/secrets` succeeds; new files cannot be created there (root-owned directory), existing ones can be
  overwritten by the container user.
- Every `up` rewrites the files (per Devsy's source, `pkg/devcontainer/setup/setup.go`); delivery to running
  environments relies on that.
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
| Credentials   | When the pane opens and the last check is over 10 minutes old, on "Check again", after a sign-in, a saved token or "Renew now". Not in the background (Artifactory renewal is, see above).         |

Each entry shows "Checked … ago".

## Lifecycle hooks: what they can use

Silicon Harbor runs every `up` with `--wait-for postStartCommand` (Devsy fork, v1.27.1-phw.7): `onCreateCommand`,
`updateContentCommand`, `postCreateCommand` and `postStartCommand` run before `up` returns and the IDE opens, while
the connection to this computer is open.

| Credential                           | In those hooks                                                                                                                               | In `postAttachCommand`      |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Artifactory files (`/run/secrets/…`) | Yes (written before the hooks run)                                                                                                           | Yes                         |
| Git (HTTPS to github.ibm.com)        | Yes: Devsy keeps its credential helper configured until container setup ends                                                                 | No (runs in the background) |
| gh                                   | Yes: `GH_ENTERPRISE_TOKEN` / `GH_TOKEN` from the host's gh accounts, `GH_HOST` for a single account; masked in output, never written to disk | No                          |

Verified 2026-11-20 on Linux with a volume clone and a local build of phw.7: the Git helper was configured during
`postCreateCommand` and gone afterwards; gh got a token (`GH_HOST=github.com` here, the only account of this
machine's gh); the Artifactory file was there. Hooks that a repository's `waitFor` puts later still run before `up`
returns: `--wait-for` only raises it.

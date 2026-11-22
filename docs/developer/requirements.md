# The computer check: check · fix · install

What "This computer" (Settings) and first-run setup check, and what the fix
buttons do. Code: `src/main/requirements/`, `src/main/installers/`,
manifest: `resources/installers/manifest.json`.

## Principles

- **Checks only read.** They run at app start and on "Check again".
- **Fixes run only on a click**, except starting an installed Rancher Desktop (no admin rights, no download), which runs by itself once per app session. Privileged steps use the normal OS prompt:
  macOS password dialog (`osascript … with administrator privileges`), Windows
  UAC (`Start-Process -Verb RunAs`), Linux polkit (`pkexec`). No own helper or
  service.
- **Installers are pinned and verified.** Every download is HTTPS, hashed while
  writing, and only run when its sha256 matches the manifest. An entry without a
  checksum is never run.
- **The Docker config is merged, never replaced.** Only
  `credHelpers["icr.io"] = "icr"` is added; a backup is written next to it
  (`config.json.silicon-harbor-backup`); writes are atomic. An unreadable config
  is left alone.
- **Re-login / reboot.** Fixes that need one are remembered in
  `<userData>/requirements-pending.json`. A check clears its entry once it sees
  the change took effect; a reboot clears all entries.
- All external commands go through `Host` (`src/main/requirements/host.ts`), so
  every check and fix is unit-tested with a fake per platform
  (`src/main/__tests__/requirements.test.ts`).

## Per requirement

| Requirement                           | Platforms      | Check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Container engine: Rancher Desktop** | macOS, Windows | App / `rdctl` present (macOS `/Applications`, `~/Applications`; Windows per-user `%LOCALAPPDATA%\Programs\Rancher Desktop` or per-machine). `rdctl list-settings` answers (running) and `containerEngine.name == "moby"`. `docker info` answers.                                                                                                                                                                                                                                                                                                                                                  | Missing → download + install (macOS: dmg, copy app to /Applications, password prompt only if needed; Windows: MSI via UAC), then `rdctl start --container-engine.name=moby`. Stopped → `rdctl start …`, **automatically** (no click) once per app session, since it needs no admin rights. containerd → `rdctl set --container-engine.name=moby`. Not responding → `rdctl shutdown` + start. Then waits up to 3 min for `docker info`.                                                                                             |
| **Container engine: Docker Engine**   | Linux (Fedora) | `docker` on PATH; `docker info` answers → ok. Else: `systemctl is-active docker`; `id -nG` contains `docker` (if `getent group docker` lists the user but the session doesn't: "log out and back in").                                                                                                                                                                                                                                                                                                                                                                                            | One `pkexec /bin/sh -c …` (single password prompt) with the needed steps: `dnf install -y moby-engine`, `systemctl enable --now docker`, `usermod -aG docker <user>` → needs re-login. Install only offered on Fedora (`/etc/os-release`).                                                                                                                                                                                                                                                                                         |
| **WSL 2**                             | Windows        | `wsl.exe --version` (UTF-16 output) ≥ 2. In-box WSL answers only `--status` → "old".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Missing → `wsl --install --no-distribution` via UAC → needs reboot. Old → `wsl --update` via UAC.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **XQuartz**                           | macOS          | `/Applications/Utilities/XQuartz.app` (or `/Applications/XQuartz.app`); version from `Info.plist`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Download + `installer -pkg … -target /` (password prompt) → needs re-login. Until `DISPLAY` is set it shows ok with "Log out and back in once to finish." (does not block first run).                                                                                                                                                                                                                                                                                                                                              |
| **docker-credential-icr**             | all            | Binary on PATH or in the user bin dir (version from `--version`) (macOS `/usr/local/bin`, Fedora `~/.local/bin`, Windows `%LOCALAPPDATA%\Programs\docker-credential-icr`; also prepended to the Devsy CLI's PATH); `credHelpers["icr.io"] == "icr"` in `$DOCKER_CONFIG/config.json` or `~/.docker/config.json`.                                                                                                                                                                                                                                                                                   | Missing binary → download, then install into the user bin dir: macOS via the admin prompt (staged in a temp dir), Windows plus adding the folder to the user's PATH. Releases are archives: the binary is unpacked with the system `tar` (Windows' built-in `tar.exe` also reads zip). It must be on the user's own PATH because the `credHelpers` entry is shared with their own `docker`. Then merge the config (backup + atomic write).                                                                                         |
| **Git sign-in: GitHub CLI**           | all            | Git present (macOS: command line tools via `xcode-select -p` or Homebrew git; Windows: `git --version`; Linux: on PATH). `gh` on PATH or where its installer puts it (`%ProgramFiles%\GitHub CLI`, `/usr/local/bin`). `github.ibm.com` listed in gh's `hosts.yml` (`$GH_CONFIG_DIR`, else `%AppData%\GitHub CLI` or `~/.config/gh`; read as a file, so no token reaches the setup log); `gh auth git-credential` as Git's credential helper for `https://github.ibm.com` (or globally); warns about a `url.*.insteadOf` rule that rewrites `https://github.ibm.com` (e.g. to SSH), without a fix. | No Git → macOS: `xcode-select --install` (Apple's dialog); Windows: Git for Windows (Inno Setup, silent, UAC). No gh → macOS: pinned pkg (password prompt); Windows: pinned MSI (UAC); Fedora: `pkexec dnf install -y gh git`. Not signed in → the browser sign-in of Settings › Credentials (`gh auth login --web` without a terminal; the one-time code is shown and copied, the page opens), then `gh auth setup-git --hostname github.ibm.com`. Signed in but not used by Git → `gh auth setup-git --hostname github.ibm.com`. |
| **IDE**                               | all            | Like Devsy (`pkg/ide/vscode/open.go`): `code` / `bobide` / `codium` on PATH, then the macOS app paths; `--version`. Ok when the default IDE (Settings › IDE, IBM Bob unless changed) is found. A single installed IDE is always ok and becomes the default. Warn only when several are found and the default is not among them.                                                                                                                                                                                                                                                                   | None found → opens the IBM Bob download page (`https://bob.ibm.com/download?bob=ide`). No automatic install. Settings › IDE lists each IDE (installed, version, "Use by default", or a Download button to the vendor's page).                                                                                                                                                                                                                                                                                                      |

The GitHub CLI is the sign-in to github.ibm.com on every platform: it is Git's credential helper for github.ibm.com, and Devsy forwards its token into environments (see [credentials.md](credentials.md)).

The docker provider also supports `DOCKER_ELEVATION` (pkexec/sudo/doas) as an
alternative to the `docker` group on Linux. Not used by Silicon Harbor; the
group is the default because it works without prompts on every start.

## Installer manifest

`resources/installers/manifest.json`, validated with zod at load
(`src/main/installers/manifest.ts`), bundled into the main process at build
time.

| Item                  | Version | Targets                                                | Checksum source                                                                            |
| --------------------- | ------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Rancher Desktop       | 1.25.0  | darwin-arm64/x64 (dmg), win32-x64 (msi)                | GitHub release asset `digest` (sha256)                                                     |
| XQuartz               | 2.8.6   | darwin-arm64/x64 (pkg, universal)                      | GitHub release asset `digest`                                                              |
| GitHub CLI            | 2.105.0 | darwin-arm64/x64 (pkg, universal), win32-x64 (msi)     | GitHub release asset `digest`                                                              |
| Git for Windows       | 2.56.1  | win32-x64 (Inno Setup exe)                             | GitHub release asset `digest`                                                              |
| docker-credential-icr | 0.1.0   | tar.gz (macOS arm64/x64, Linux x64), zip (Windows x64) | sha256 from the GitHub release asset digests; `archive` + `member` name the binary inside. |

### Updating an entry

1. Read the release's asset metadata, e.g.
   `curl -s https://api.github.com/repos/<owner>/<repo>/releases/latest`.
   github.com returns a `digest: "sha256:…"` per asset; vendors' own checksum files
   (`*.sha256`, `SHA256SUMS`) are equally fine. Don't hash a download you made
   yourself — that only proves what you received.
2. Update `version`, `url` and `sha256` per target, and `updated`.
3. `npm test` (validates the manifest), then try the fix on a test machine.

docker-credential-icr assets are `"kind": "binary"` with `"archive": "tar.gz" | "zip"`
and `"member"` (the binary's file name inside the archive, no paths). Its
release publishes no checksum files; take the sha256 from each asset's
`digest` in the GitHub release API.

## Trying it

- Unit tests: `npm test` (fakes for macOS, Windows, Linux).
- Read-only checks on this machine:
  `SH_REAL_CHECK=1 SH_REAL_CHECK_OUT=/tmp/checks.json npx vitest run src/main/__tests__/real-check.test.ts`
- Fixes and installers can only be verified on the macOS/Windows/Fedora test
  machines (manual release checklist).

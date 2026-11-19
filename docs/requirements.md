# Requirements: check · fix · install (M2)

What "This computer" (Settings) and first-run setup check, and what the fix
buttons do. Code: `src/main/requirements/`, `src/main/installers/`,
manifest: `resources/installers/manifest.json`.

## Principles

- **Checks only read.** They run at app start and on "Check again".
- **Fixes run only on a click.** Privileged steps use the normal OS prompt:
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

| Requirement                             | Platforms      | Check                                                                                                                                                                                                                                            | Fix                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Container engine: Rancher Desktop**   | macOS, Windows | App / `rdctl` present (macOS `/Applications`, `~/Applications`; Windows per-user `%LOCALAPPDATA%\Programs\Rancher Desktop` or per-machine). `rdctl list-settings` answers (running) and `containerEngine.name == "moby"`. `docker info` answers. | Missing → download + install (macOS: dmg, copy app to /Applications, password prompt only if needed; Windows: MSI via UAC), then `rdctl start --container-engine.name=moby`. Stopped → `rdctl start …`. containerd → `rdctl set --container-engine.name=moby`. Not responding → `rdctl shutdown` + start. Then waits up to 3 min for `docker info`. |
| **Container engine: Docker Engine**     | Linux (Fedora) | `docker` on PATH; `docker info` answers → ok. Else: `systemctl is-active docker`; `id -nG` contains `docker` (if `getent group docker` lists the user but the session doesn't: "log out and back in").                                           | One `pkexec /bin/sh -c …` (single password prompt) with the needed steps: `dnf install -y moby-engine`, `systemctl enable --now docker`, `usermod -aG docker <user>` → needs re-login. Install only offered on Fedora (`/etc/os-release`).                                                                                                          |
| **WSL 2**                               | Windows        | `wsl.exe --version` (UTF-16 output) ≥ 2. In-box WSL answers only `--status` → "old".                                                                                                                                                             | Missing → `wsl --install --no-distribution` via UAC → needs reboot. Old → `wsl --update` via UAC.                                                                                                                                                                                                                                                   |
| **XQuartz**                             | macOS          | `/Applications/Utilities/XQuartz.app` (or `/Applications/XQuartz.app`); version from `Info.plist`.                                                                                                                                               | Download + `installer -pkg … -target /` (password prompt) → needs re-login. Until `DISPLAY` is set it shows ok with "Log out and back in once to finish." (does not block first run).                                                                                                                                                               |
| **docker-credential-icr**               | all            | Binary on PATH or in our bin dir (`$DEVSY_HOME/bin`, prepended to the Devsy CLI's PATH); `credHelpers["icr.io"] == "icr"` in `$DOCKER_CONFIG/config.json` or `~/.docker/config.json`.                                                            | Missing binary → download + copy to `$DEVSY_HOME/bin` (**not available yet**, see manifest). Then merge the config (backup + atomic write).                                                                                                                                                                                                         |
| **Git sign-in: Git Credential Manager** | macOS          | Command line tools (`xcode-select -p`) or Homebrew git; `git credential-manager --version`; `git config --get-all credential.helper` contains "manager".                                                                                         | No Git → `xcode-select --install` (Apple's dialog). No GCM → download + pkg install (password prompt) + `git credential-manager configure`. Not configured → `git credential-manager configure`.                                                                                                                                                    |
| **Git sign-in: Git for Windows**        | Windows        | `git --version`; GCM present and configured as above.                                                                                                                                                                                            | Download + Inno Setup installer silently via UAC (`/VERYSILENT /NORESTART …`); it bundles and configures GCM.                                                                                                                                                                                                                                       |
| **IDE**                                 | all            | Like Devsy (`pkg/ide/vscode/open.go`): `code` / `bobide` / `codium` on PATH, then the macOS app paths; `--version`. Ok when the default IDE (Settings › IDE) is found; warn when only others are found.                                          | None found → opens the VS Code download page. No automatic install.                                                                                                                                                                                                                                                                                 |

Not checked on Fedora: Git Credential Manager (PLAN.md §1).

The docker provider also supports `DOCKER_ELEVATION` (pkexec/sudo/doas) as an
alternative to the `docker` group on Linux. Not used by Silicon Harbor; the
group is the default because it works without prompts on every start.

## Installer manifest

`resources/installers/manifest.json`, validated with zod at load
(`src/main/installers/manifest.ts`), bundled into the main process at build
time.

| Item                   | Version | Targets                                 | Checksum source                                                                                                                                                                                      |
| ---------------------- | ------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rancher Desktop        | 1.25.0  | darwin-arm64/x64 (dmg), win32-x64 (msi) | GitHub release asset `digest` (sha256)                                                                                                                                                               |
| XQuartz                | 2.8.6   | darwin-arm64/x64 (pkg, universal)       | GitHub release asset `digest`                                                                                                                                                                        |
| Git Credential Manager | 3.0.2   | darwin-arm64/x64 (pkg)                  | GitHub release asset `digest`                                                                                                                                                                        |
| Git for Windows        | 2.56.1  | win32-x64 (Inno Setup exe)              | GitHub release asset `digest`                                                                                                                                                                        |
| docker-credential-icr  | —       | —                                       | **TODO: no release published yet** (github.com/imphil/docker-credential-icr has no releases or tags, checked 2026-11-19). The installer refuses; the check tells the user to put the binary on PATH. |

### Updating an entry

1. Read the release's asset metadata, e.g.
   `curl -s https://api.github.com/repos/<owner>/<repo>/releases/latest`.
   GitHub returns a `digest: "sha256:…"` per asset; vendors' own checksum files
   (`*.sha256`, `SHA256SUMS`) are equally fine. Don't hash a download you made
   yourself — that only proves what you received.
2. Update `version`, `url` and `sha256` per target, and `updated`.
3. `npm test` (validates the manifest), then try the fix on a test machine.

When docker-credential-icr publishes releases: add `assets` per target with
`"kind": "binary"` (or an archive kind, if it ships archives — needs a small
extension in `install.ts`), the version and the checksums, and remove `todo`.

## Trying it

- Unit tests: `npm test` (fakes for macOS, Windows, Linux).
- Read-only checks on this machine:
  `SH_REAL_CHECK=1 SH_REAL_CHECK_OUT=/tmp/checks.json npx vitest run src/main/__tests__/real-check.test.ts`
- Fixes and installers can only be verified on the macOS/Windows/Fedora test
  machines (manual release checklist).

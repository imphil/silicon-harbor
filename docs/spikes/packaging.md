# Spike: packaging every platform on Linux

Date: 2026-11-19 · electron 44.5.1 · electron-builder 26.17.0 · rcodesign 0.29.0 ·
Devsy CLI v1.27.1 · host: openSUSE Tumbleweed x86_64

## Result

| Target                 | Command                            | Artifact                           | Size   | Built here    | Verified                                                                    |
| ---------------------- | ---------------------------------- | ---------------------------------- | ------ | ------------- | --------------------------------------------------------------------------- |
| macOS x64              | `RCODESIGN=… npm run package:mac`  | `SiliconHarbor_mac_x64.zip`        | 180 MB | ✅            | ad-hoc signature on app + devsy, x86_64 Mach-O, symlinks kept               |
| macOS arm64            | (same run)                         | `SiliconHarbor_mac_arm64.zip`      | 170 MB | ✅            | ad-hoc signature on app + devsy, arm64 Mach-O, symlinks kept                |
| Windows x64            | `npm run package:win`              | `SiliconHarbor_win_x64.exe` (NSIS) | —      | ❌ needs Wine | —                                                                           |
| Windows x64 (fallback) | `electron-builder --win zip --x64` | `SiliconHarbor_win_x64.zip`        | 200 MB | ✅            | contains `Silicon Harbor.exe` + `resources/bin/devsy.exe`                   |
| Fedora x64             | `npm run package:linux`            | `SiliconHarbor_linux_x86_64.rpm`   | 120 MB | ✅            | `rpm -qip` ok; packaged app launched under Xvfb and found its bundled devsy |

**Not yet tested on real macOS/Windows machines.** That is the next manual step
(test machines are available).

## How it works

1. `npm run build` — electron-vite builds main, preload and renderer (pure JS).
2. `scripts/fetch-devsy.mjs --targets …` — downloads the Devsy release binary
   pinned in `resources/devsy/devsy.json`, verifies SHA-256, writes
   `resources/bin/<os>-<arch>/devsy[.exe]`. Cached in `.cache/devsy/<version>/`.
3. `electron-builder` — downloads prebuilt Electron for each target and
   copies `resources/bin/${os}-${arch}/` to `<app>/resources/bin/` (extraResources).
4. macOS only: `scripts/after-pack.cjs` runs `rcodesign sign <app>` (ad-hoc,
   no certificate), which signs all helpers, frameworks and
   `Contents/Resources/bin/devsy`, then asserts the ad-hoc flag with
   `rcodesign print-signature-info`.

No step compiles native code: there are no native Node modules, the Devsy CLI is
`CGO_ENABLED=0`, and Electron is prebuilt.

## Required tools

| Tool            | For          | Notes                                                                                                                                                                                                                                                                               |
| --------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node 24 + npm   | everything   |                                                                                                                                                                                                                                                                                     |
| rcodesign       | macOS        | static Linux binary from github.com/indygreg/apple-platform-rs releases (`apple-codesign-0.29.0-x86_64-unknown-linux-musl.tar.gz`, sha256 `dbe85ced…0002`, checked against the published `.sha256`). Path via `$RCODESIGN` or PATH; the hook fails with a clear message if missing. |
| Wine (+ 32-bit) | Windows NSIS | electron-builder runs the 32-bit NSIS stub under Wine to produce the uninstaller. **Required even with `signAndEditExecutable: false`.**                                                                                                                                            |
| rpmbuild        | Fedora RPM   | electron-builder uses its bundled fpm; `rpm` package provides rpmbuild.                                                                                                                                                                                                             |

## Caveats and findings

- **Wine is needed for the NSIS installer.** Wine isn't installed on this
  machine, and running `electronuserland/builder:22-wine-10.26` locally was
  blocked by the sandbox, so the installer itself is **not verified yet**.
  Everything before the uninstaller step works: the NSIS app archive was
  produced, and the zip target proves the Windows app layout.
  CI installs Wine via apt (unverified). The fallback is to run the Windows
  packaging step in the `electronuserland/builder:wine` image.
  Once Wine is available anyway, `signAndEditExecutable` could be turned back
  on to set the exe icon and version info (signing stays off).
- **No exe metadata or icon on Windows** (`signAndEditExecutable: false`): the
  exe shows Electron's default icon and version info.
- **No app icons anywhere yet.** All three use Electron's default icon. Add
  `build/icon.icns`, `build/icon.ico` and `build/icons/*.png`.
- **macOS first launch:** an ad-hoc signed, quarantined app is blocked by
  Gatekeeper. Users must allow it once (System Settings → Privacy & Security →
  "Open Anyway", or `xattr -dr com.apple.quarantine "/Applications/Silicon Harbor.app"`).
  Document this in the install guide.
- **`rcodesign verify` cannot check ad-hoc signatures.** It expects a CMS blob
  and fails with "CMS error", and it doesn't accept bundles. The hook uses
  `print-signature-info` instead.
- **macOS dmg** is not produced; dmg creation needs macOS tooling. A zip is
  enough for now.
- **Sizes are dominated by Devsy:** each Devsy binary is 157–166 MB
  uncompressed (Go, static). Installed RPM size is 461 MB. Worth raising
  upstream (strip / `-ldflags="-s -w"` / UPX are options).
- **RPM installs to `/opt/Silicon Harbor/`** (path with a space, from
  productName). Consider `/opt/silicon-harbor` before release.
- **RPM metadata:** `homepage` is a placeholder (`https://www.ibm.com/`) until the
  repository location is decided; electron-builder refuses to build an RPM without
  one. License shows "unknown".
- **Devsy binary checksums** come from the asset `digest` in the GitHub release
  API of our fork `imphil/devsy`. (Originally, for upstream v1.27.1, they were
  trust-on-first-use hashes of our own downloads.)
- **`DEVSY_LOCAL_DIST`** lets you package a local Devsy build for testing, but
  it isn't checksum-verified (a warning is printed). Windows: the local Devsy
  `dist/` has no `devsy-dev_windows_*` output, so local mode fails for
  `win-x64` with a clear error. Use the pinned release instead.
- **Packaging time:** zip/NSIS compression of ~200 MB payloads takes a few
  minutes per target.

## CI

`.github/workflows/build.yml` on GitHub Actions
([imphil/silicon-harbor](https://github.com/imphil/silicon-harbor)), ubuntu-24.04
runners only:
- `check` job: lint, svelte-check + tsc, Vitest, build, Playwright e2e under Xvfb
  (after allowing unprivileged user namespaces, which Ubuntu 24.04 blocks and
  Chromium's sandbox needs).
- `package` job, a matrix over mac/win/linux: installs rcodesign (checksum-verified) /
  Wine / rpm as needed, runs `npm run package:<target> -- --publish never`, and
  uploads the package as a run artifact. Devsy downloads are cached per pin.
- `release` job, only for `v*` tags: checks that the tag matches
  `package.json`'s version, then creates a **draft** GitHub release with the
  three packages and a `SHA256SUMS` file. Publish it by hand.

To release: bump `version` in `package.json`, commit, tag `v<version>`, push the tag.

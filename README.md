# Silicon Harbor

Development environments for IBM chip developers: paste a Git URL, get a working
environment open in IBM Bob, VS Code or VSCodium. Built on
[Devsy](https://github.com/devsy-org/devsy).

Status: M0 (foundations). See [PLAN.md](PLAN.md).

## Stack

Electron + TypeScript, Svelte 5 + [carbon-components-svelte](https://svelte.carbondesignsystem.com),
electron-vite, Biome, Vitest, Playwright. The pinned Devsy CLI is bundled in
the app. No native Node modules, so every platform is packaged on Linux.

```
src/main/       Electron main process
src/preload/    contextBridge API (window.siliconHarbor)
src/renderer/   Svelte + Carbon UI
src/shared/     types shared by main and renderer (IPC contract)
resources/devsy/devsy.json   pinned Devsy version + SHA-256 per target
scripts/        fetch-devsy.mjs, after-pack.cjs (macOS ad-hoc signing)
e2e/            Playwright smoke tests against real Electron
docs/spikes/    M0 spike results
```

## Development

Requires Node 24.

```sh
npm install                 # also downloads the Electron binary (postinstall)
npm run fetch-devsy         # Devsy CLI for this machine → resources/bin/<os>-<arch>/
npm run dev                 # app with hot reload, real Devsy backend
npm run dev:mock            # UI against the built-in mock backend (no Devsy, no Docker)
```

The real backend uses `~/.silicon-harbor` as Devsy home. Override with
`SH_DEVSY_HOME=/tmp/sh-dev` (keep it short: Devsy's unix sockets are limited to
104 bytes) and the Electron profile with `SH_USER_DATA_DIR`. Mock scenarios:
append `?mock=1&scenario=default|first-run|empty|all-ok&platform=mac|win|linux`
to the renderer URL.

Running from a terminal inside VS Code? Its extension host may export
`ELECTRON_RUN_AS_NODE=1`, which makes Electron start as plain Node. Use
`env -u ELECTRON_RUN_AS_NODE npm run dev`.

Checks:

```sh
npm run lint                # Biome
npm run check               # svelte-check + tsc
npm test                    # Vitest unit tests
npm run build && npm run test:e2e   # Playwright; on headless Linux: xvfb-run -a npm run test:e2e
```

### Using a local Devsy build

```sh
DEVSY_LOCAL_DIST=../devsy/dist npm run fetch-devsy
```

Copies `devsy-dev_<goos>_<goarch>*/devsy` from a goreleaser `dist/` directory
instead of the pinned release. Not checksum-verified, so never release a
package built this way.

## Packaging (all on Linux)

```sh
RCODESIGN=/path/to/rcodesign npm run package:mac    # zip, x64 + arm64, ad-hoc signed
npm run package:win                                  # NSIS installer, x64 — needs Wine
npm run package:linux                                # Fedora RPM, x64 — needs rpmbuild
```

Output goes to `release/`. Tool requirements and caveats are in
[docs/spikes/packaging.md](docs/spikes/packaging.md). CI runs the same commands
on ubuntu runners: [.github/workflows/build.yml](.github/workflows/build.yml).

To update Devsy: change `version` in `resources/devsy/devsy.json`, put the new
SHA-256 for each asset there, and run `npm run fetch-devsy`.

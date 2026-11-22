# Development setup

Silicon Harbor is an Electron app in TypeScript: Svelte 5 with
[carbon-components-svelte](https://svelte.carbondesignsystem.com) for the UI, built with
electron-vite, checked with Biome, tested with Vitest and Playwright. The pinned Devsy CLI is
bundled with the app. There are no native Node modules, so every platform is packaged on Linux.

Requires Node 24, and Python 3.10 or later for the documentation.

```sh
npm install                 # also downloads the Electron binary (postinstall)
npm run fetch-devsy         # Devsy CLI for this machine → resources/bin/<os>-<arch>/
npm run dev                 # app with hot reload, real Devsy backend
npm run dev:mock            # UI against the built-in mock backend (no Devsy, no Docker)
```

## Isolation

The real backend uses `~/.silicon-harbor` as Devsy home. Override it with
`SH_DEVSY_HOME=/tmp/sh-dev` (keep it short: Devsy's unix sockets are limited to 104 bytes) and the
Electron profile with `SH_USER_DATA_DIR`.

Running from a terminal inside VS Code? Its extension host may export `ELECTRON_RUN_AS_NODE=1`,
which makes Electron start as plain Node. Use `env -u ELECTRON_RUN_AS_NODE npm run dev`.

## The mock backend

`npm run dev:mock` replaces the main process API with `src/renderer/src/lib/mock-api.ts`. Choose a
scenario by appending to the renderer URL:
`?mock=1&scenario=default|first-run|empty|all-ok&platform=mac|win|linux`.

## Checks

```sh
npm run lint                # Biome
npm run check               # svelte-check + tsc
npm test                    # Vitest unit tests
npm run test:e2e            # builds, then Playwright; on headless Linux: xvfb-run -a npm run test:e2e
```

## Documentation

```sh
python3 -m venv docs/.venv
docs/.venv/bin/pip install -r docs/requirements.txt
PATH="$PWD/docs/.venv/bin:$PATH" npm run docs   # → docs/_build/html/index.html
```

The build treats warnings as errors. Pages are Markdown ([MyST](https://myst-parser.readthedocs.io));
the theme is [sphinx-carbon-theme](https://github.com/imphil/sphinx-carbon-theme).

## A local Devsy build

```sh
DEVSY_LOCAL_DIST=../devsy/dist npm run fetch-devsy
```

Copies `devsy-dev_<goos>_<goarch>*/devsy` from a goreleaser `dist/` directory instead of the pinned
release. It is not checksum-verified, so never release a package built this way. See also
[](devsy/fork.md).

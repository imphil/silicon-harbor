# Silicon Harbor

Development environments for IBM chip developers: paste a Git URL, get a working
environment open in IBM Bob, VS Code or VSCodium. Built on
[Devsy](https://github.com/devsy-org/devsy), using the CLI from our fork
[imphil/devsy](https://github.com/imphil/devsy).

## Documentation

The documentation lives in [docs/](docs/) and is built with Sphinx:

- [User guide](docs/user/index.md): install, set up, create environments, credentials,
  troubleshooting, preparing a repository.
- [Developer guide](docs/developer/index.md): development setup, architecture, the
  Devsy engine and fork, tests, packaging and releases.

```sh
python3 -m venv docs/.venv && docs/.venv/bin/pip install -r docs/requirements.txt
PATH="$PWD/docs/.venv/bin:$PATH" npm run docs     # → docs/_build/html/index.html
```

## Quick start for developers

Requires Node 24.

```sh
npm install
npm run fetch-devsy         # the pinned Devsy CLI for this machine
npm run dev                 # app with hot reload, real Devsy backend
npm run dev:mock            # UI against the built-in mock backend
```

Project plan and status: [PLAN.md](PLAN.md).

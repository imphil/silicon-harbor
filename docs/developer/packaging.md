# Packaging and releases

Every platform is packaged on Linux:

```sh
RCODESIGN=/path/to/rcodesign npm run package:mac    # zip, x64 + arm64, ad-hoc signed
npm run package:win                                  # NSIS installer, x64; needs Wine
npm run package:linux                                # Fedora RPM, x64; needs rpmbuild
```

Output goes to `release/`. Tool requirements and caveats are in [](spikes/packaging.md). GitHub
Actions runs the same commands on Ubuntu runners and builds a draft release for `v*` tags
(`.github/workflows/build.yml`).

## The bundled Devsy CLI

`resources/devsy/devsy.json` pins the Devsy version and the SHA-256 of each platform's binary;
`npm run fetch-devsy` downloads and verifies it. To move to a new release of the fork:

1. Release it in [imphil/devsy](https://github.com/imphil/devsy) (see [](devsy/fork.md)).
2. Set `version` in `devsy.json` and each asset's SHA-256: the `digest` of the asset in the GitHub
   release API, not a hash of your own download.
3. Run `npm run fetch-devsy` and check `resources/bin/<os>-<arch>/devsy --version`.

The fork's CLI downloads its in-container agent from the same release, so the release must keep its
Linux assets.

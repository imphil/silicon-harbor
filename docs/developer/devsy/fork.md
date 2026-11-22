# The Devsy fork

Silicon Harbor bundles the CLI of [imphil/devsy](https://github.com/imphil/devsy), a fork of
[Devsy](https://github.com/devsy-org/devsy) on branch `main-fork`. Releases are tagged
`v<upstream version>-phw.<n>`; the agent inside containers is downloaded from the same release.

## What the fork adds

| In     | Change                                                                                                                                                                                   |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| phw.6  | Releases from a fork (the release repository is a build-time setting; unsigned macOS builds without Apple secrets; CLI binaries and the volume bootstrap image published by the release) |
| phw.6  | Workspace source cloned into a Docker volume (`--clone-into-volume`), X11 forwarding, a separate local daemon socket per Devsy home, Windows fixes for SSH and IDE launch                |
| phw.7  | `--wait-for <phase>`: lifecycle hooks up to that phase run before `up` returns; Git and GitHub CLI credentials in lifecycle hooks; complete setup history for volume clones              |
| phw.8  | File secrets written into a `/run/secrets` mount from `devcontainer.json`                                                                                                                |
| phw.9  | Secret files replaced in one step (temporary file, then rename)                                                                                                                          |
| phw.10 | `customizations.devsy.onSecretsChangedCommand`                                                                                                                                           |

## Making a release

1. Commit to `main-fork` and push it to `imphil`.
2. Tag `v1.27.1-phw.<n>` and push the tag.
3. Publish a GitHub release for the tag (`gh release create … --verify-tag --generate-notes`); this
   starts the build. macOS runners can be slow to start; re-run a cancelled job.
4. When the CLI binaries are attached, pin them in Silicon Harbor ([](../packaging.md)).

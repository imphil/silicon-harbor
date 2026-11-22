# Testing

| Level             | What                                                                                                                                                                                             | Command            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| Unit              | Requirement checks and fixes per platform, Devsy output parsing, the error catalog, credentials and token renewal, view helpers; external commands through fakes (`FakeHost`, `FakeArtifactory`) | `npm test`         |
| Recorded fixtures | Real Devsy CLI output in `test/fixtures/devsy/`, replayed by the parser tests                                                                                                                    | part of `npm test` |
| End-to-end        | The built app in Electron with Playwright: smoke tests against the real backend, user flows against the mock API                                                                                 | `npm run test:e2e` |
| Manual            | Fresh install, setup, create, open in each IDE, on macOS, Windows and Fedora                                                                                                                     | per release        |

CI (`.github/workflows/build.yml`) runs lint, type checks, unit tests and the build on every push,
then packages every platform.

## Screenshots

The flow tests save screenshots when `SH_SCREENSHOT_DIR` is set:

```sh
SH_SCREENSHOT_DIR=/tmp/shots npm run test:e2e
```

## Real containers

Changes to how environments are created or how secrets reach them are worth one run against a real
Docker. Rules that keep such a run from touching your own setup:

- Use a throwaway, short Devsy home (`DEVSY_HOME=$(mktemp -d /tmp/shx-XXXX)`) and pass
  `--ssh-config` to a file in a temporary folder, never `~/.ssh/config`.
- Use the file secret backend (`DEVSY_SECRETS_BACKEND=file`, `DEVSY_SECRETS_PASSPHRASE=…`), not the
  OS keychain, which is shared by all Devsy homes.
- Serve a test repository locally over HTTP (`git http-backend`) and clone it with
  `--clone-into-volume`.
- Record `docker ps -aq`, `docker volume ls -q` and `docker images -q` before, and remove what is new
  afterwards.

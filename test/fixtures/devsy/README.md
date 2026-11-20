# Devsy CLI fixtures

Recorded outputs of the real Devsy CLI. See [docs/devsy-contract.md](../../../docs/devsy-contract.md) for the analysis.

Each case directory has `cmd.txt` (command line + `# duration-ms`), `stdout.ndjson`, `stderr.ndjson`, `exit-code.txt`.
Redacted placeholders: `$DEVSY_HOME`, `$SCRATCH`, `$HOME`, `$USER`, `$HOSTNAME`. The host environment in
`c2-task-list-after-up` was replaced by a placeholder.

| Prefix | Scenario |
|---|---|
| `provider-*` | add / init / use / list the docker provider |
| `a`, `b` | create from a git URL: detached submit, `task logs --follow` (success) |
| `c*` | `task list` during and after `up`, `task get` during `up` |
| `d*` | `workspace list` during up / running / stopped / after delete |
| `e*` | `workspace status` during up / running / stopped / after delete |
| `f` | stop |
| `g*` | restart a stopped workspace (detached + follow) |
| `h` | delete |
| `i*` | repository does not exist / no access (clone failure) |
| `j*` | image cannot be pulled (local folder source) |
| `k*` | cancel a running `up` |
| `l*` | setup log store: list runs, read latest run |
| `m*` | Docker daemon unreachable |
| `n*` | `up --clone-into-volume` (source in a Docker volume, via a bootstrap container); our fork with the bootstrap status fix |
| `s*` | `context set -o SSH_INJECT_GITHUB_CREDENTIALS=true`; `secret list` (empty, one entry), `secret set --stdin`, `secret get`, `secret delete` (dummy value; recorded with the OS keyring backend, entry deleted again) |
| `x-*` | DEVSY_HOME too long → agent socket path limit (recorded with a long home) |

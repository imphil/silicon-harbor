# Prepare a repository

For maintainers of a repository's `.devcontainer/devcontainer.json`. Silicon Harbor runs it with
the Devsy engine like any dev container configuration, and adds credentials that your setup
scripts can use.

## What a repository needs

- The repository is reachable over HTTPS on github.ibm.com.
- `devcontainer.json` names an image users can pull, for example from `icr.io` (Docker uses the
  user's IBM Cloud login) or builds one from a `Dockerfile`.
- The GitHub CLI (`gh`) in the image, if your scripts use it: Devsy forwards the user's sign-in to
  it.

## Credentials in /run/secrets

Before any lifecycle command runs, Devsy writes these files, owned by the container user with mode
`0600`:

| File                                | Contents                                                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `/run/secrets/ARTIFACTORY_TOKEN`    | Short-lived Artifactory access token (7 days, renewed while Silicon Harbor runs); eu. and na.artifactory accept it |
| `/run/secrets/IBM_USER`             | The user's w3id                                                                                                    |
| `/run/secrets/GITHUB_IBM_COM_TOKEN` | The user's GitHub CLI token for github.ibm.com                                                                     |
| `/run/secrets/SILICON_HARBOR`       | `managed`                                                                                                          |

`/run/secrets` is an in-memory file system, unless `devcontainer.json` mounts a volume there itself
(for example one shared by all your containers): then Devsy writes into that volume. Values are
masked as `***` in hook output and setup history.

When a value changes (a renewed token, a new github.ibm.com sign-in), Silicon Harbor writes the new files
into running environments without restarting them. Each file is replaced in one step, so a reader
never sees half a token.

## Build your files when secrets change

Tools usually want credentials in their own files. Name a command that builds them in
`customizations.devsy.onSecretsChangedCommand`:

```json
{
  "customizations": {
    "devsy": { "onSecretsChangedCommand": ".devcontainer/secrets-changed.sh" }
  }
}
```

- It runs as the container user right after Devsy writes `/run/secrets`: on the first start,
  before `onCreateCommand`, and then whenever a value changed, also in a running environment.
- It takes the same forms as the lifecycle commands (a string, an array, or an object of named
  commands).
- If it fails, the failure is logged and the remaining setup goes on. It runs again with the next
  change.
- Other dev container tools ignore it.

Make it safe to run again, and write each file in one step, so tools never read a half-written
file. A complete example for Artifactory (eu and na), github.ibm.com and the JFrog CLI:

```sh
#!/bin/sh
# .devcontainer/secrets-changed.sh: build the tools' files from /run/secrets.
set -eu
S=/run/secrets
[ -r "$S/ARTIFACTORY_TOKEN" ] && [ -r "$S/IBM_USER" ] || exit 0
user=$(cat "$S/IBM_USER")
token=$(cat "$S/ARTIFACTORY_TOKEN")

# put FILE: write stdin to FILE in one step, mode 0600.
put() {
  tmp=$(mktemp "$1.XXXXXX")
  cat > "$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$1"
}

{
  printf 'machine eu.artifactory.swg-devops.com login %s password %s\n' "$user" "$token"
  printf 'machine na.artifactory.swg-devops.com login %s password %s\n' "$user" "$token"
  if [ -r "$S/GITHUB_IBM_COM_TOKEN" ]; then
    printf 'machine github.ibm.com login %s password %s\n' "$user" "$(cat "$S/GITHUB_IBM_COM_TOKEN")"
  fi
} | put "$HOME/.netrc"

mkdir -p "$HOME/.jfrog"
jq -n --arg user "$user" --arg token "$token" '{
  servers: [{
    url: "https://na.artifactory.swg-devops.com/",
    artifactoryUrl: "https://na.artifactory.swg-devops.com/artifactory/",
    user: $user, password: $token, serverId: "na-art", isDefault: true
  }],
  version: "6"
}' | put "$HOME/.jfrog/jfrog-cli.conf"
```

Don't add a `refreshToken` to the JFrog CLI configuration: the CLI would renew the token itself and
compete with Silicon Harbor.

## Leave logins to Silicon Harbor

Scripts that ask for an Artifactory login or renew tokens themselves should step aside when
Silicon Harbor provides the credentials:

```sh
sh_managed() { [ "$(cat /run/secrets/SILICON_HARBOR 2>/dev/null)" = managed ]; }

if sh_managed; then
  echo "Credentials are managed by Silicon Harbor (Settings > Credentials)." >&2
  exit 0
fi
# ... your existing login or renewal ...
```

Without Silicon Harbor (for example in VS Code's Dev Containers extension) the file is missing, and
your scripts work as before.

## Lifecycle commands and credentials

Silicon Harbor runs `onCreateCommand`, `updateContentCommand`, `postCreateCommand` and
`postStartCommand` before it opens the IDE, while it is connected to the environment:

| Credential                              | In those commands | In `postAttachCommand` |
| --------------------------------------- | ----------------- | ---------------------- |
| Files in `/run/secrets`                 | Yes               | Yes                    |
| Git over HTTPS to github.ibm.com        | Yes               | No                     |
| `gh` (`GH_ENTERPRISE_TOKEN`, `GH_HOST`) | Yes               | No                     |

In the IDE and in terminals from Silicon Harbor, Git and `gh` always work: they ask the user's
computer each time.

# Credentials

**Settings › Credentials** shows the sign-ins your environments use and whether they work. They
are kept in your system's password store (macOS Keychain, Windows Credential Manager, the Secret
Service on Linux) and given to environments when they start. Each entry says when it was last
checked; **Check again** checks all of them now.

## github.ibm.com

Silicon Harbor uses the GitHub CLI (`gh`) on your computer for github.ibm.com.

1. Click **Sign in**. Your browser opens github.ibm.com, and Silicon Harbor shows a one-time code
   and copies it to the clipboard.
2. Paste the code on the page and approve the sign-in.

Git then uses this sign-in for github.ibm.com, also outside Silicon Harbor. Environments get it
for Git and `gh` while their setup runs and while your IDE or a terminal is connected, and as
`/run/secrets/GITHUB_IBM_COM_TOKEN` for tools that read a file.

## Artifactory

Artifactory has no sign-in Silicon Harbor can open for you, so you create an identity token once:

1. Open [eu.artifactory.swg-devops.com](https://eu.artifactory.swg-devops.com/) and log in with your
   w3id.
2. Click the icon with your initial at the top right, then **Edit Profile**.
3. Click **Generate an Identity Token**.
4. Enter **Silicon Harbor** as the description and click **Next**.
5. Copy the token and paste it into Silicon Harbor, with your w3id (your IBM email address), then
   click **Save and check**.

Silicon Harbor uses this token once, to create tokens of its own; you can revoke the identity token
afterwards. It keeps a long-lived token on your computer and gives environments a short-lived one
(7 days), which it replaces while it runs and passes to running environments straight away. The
pane shows when both expire.

- **Renew now** replaces the environments' token immediately.
- **Replace token** sets Artifactory up again with a new identity token, for example after you
  revoked the old one.
- **Remove token** revokes Silicon Harbor's tokens for this computer.

```{note}
If Silicon Harbor has not run for longer than a week, the environments' token has expired. Start
Silicon Harbor: it renews the token and passes it on.
```

## IBM Cloud (icr.io)

Docker downloads environment images from `icr.io` with your IBM Cloud login, through
`docker-credential-icr`. The helper keeps the login and renews it; when it no longer can, it asks
you to log in again in the browser. Silicon Harbor asks it when you open the pane, so the login
happens there and not in the middle of creating an environment. **Log in** starts it if needed.

## What environments find

Every environment gets these files in `/run/secrets`:

| File                   | Contents                                                                     |
| ---------------------- | ---------------------------------------------------------------------------- |
| `ARTIFACTORY_TOKEN`    | The short-lived Artifactory token                                            |
| `IBM_USER`             | Your w3id                                                                    |
| `GITHUB_IBM_COM_TOKEN` | Your GitHub CLI token for github.ibm.com                                     |
| `SILICON_HARBOR`       | `managed`: tells the repository's scripts that Silicon Harbor handles logins |

The repository's own scripts turn them into what its tools need, such as `~/.netrc` or the JFrog
CLI configuration; see [](repositories.md).

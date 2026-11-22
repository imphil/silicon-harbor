# Troubleshooting

When something fails, the environment shows **Problem** and a message that says what went wrong
and what to do, with a button for the next step. The **Log** tab has the full output.

| Message                                            | What to do                                                                                                                 |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| The container engine is not running                | Start Rancher Desktop (or Docker on Fedora), or use **Settings › This computer**, then retry.                              |
| Your sign-in to IBM Container Registry has expired | Log in to IBM Cloud again (**Settings › Credentials**), then retry.                                                        |
| The environment image could not be downloaded      | You have no access to the image named in the repository's `devcontainer.json`. Check your registry access, then retry.     |
| The environment image does not exist               | The repository's environment definition names an image that cannot be found. Tell the repository's maintainers.            |
| Could not sign in to the Git server                | Sign in to github.ibm.com again (**Settings › Credentials**) and check that you have access to the repository, then retry. |
| The repository could not be cloned                 | Check the address and that you can reach the Git server (VPN), then retry.                                                 |
| … could not be opened                              | The environment runs, but the IDE did not start. Check that it is installed (**Settings › IDE**), then use **Open** again. |
| Too many requests                                  | A server is rate limiting. Wait a moment, then retry.                                                                      |
| The operation took too long                        | Check your network connection, then retry.                                                                                 |
| Something went wrong                               | Use **Copy diagnostics** and send them to the Silicon Harbor team.                                                         |

## An environment was re-created

Silicon Harbor starts every environment with credentials mounted at `/run/secrets`. If an
environment's container was created without that mount, for example by another tool, Devsy
re-creates the container once to add it. Changes outside the repository folder are lost then.

## Credentials in an environment stopped working

- **Artifactory:** start Silicon Harbor. It renews the token and passes it to running
  environments. Check **Settings › Credentials** for a renewal error.
- **github.ibm.com:** check that you are signed in (**Settings › Credentials**). Git and `gh` inside the
  environment ask your computer each time, so they work again as soon as the sign-in does.

## Asking for help

**Settings › Support › Copy diagnostics** copies the app and engine logs and the results of the
computer check (no source code or passwords). Paste them into your support request.

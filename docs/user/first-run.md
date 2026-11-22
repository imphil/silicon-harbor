# Set up your computer

On its first start Silicon Harbor shows **Set up your machine**: the tools needed to run
development environments, each with its state. Nothing is installed or changed until you click
a button.

- The button next to an item fixes just that item; it says what it does: **Install**, **Start**,
  **Update**, **Sign in**, **Switch to dockerd**, **Add me to the group**. **Fix all** does every
  item that can be fixed. Steps that need administrator rights ask with your system's usual
  password or permission prompt.
- **Continue** takes you to your environments once everything is ready. **Skip for now** goes
  there anyway; the header then shows how many issues are left.

You can come back to this list at any time: **Settings › This computer**. It is checked again
every time the app starts.

## What is checked

| Item                            | macOS                                                          | Windows                                  | Fedora                                                        |
| ------------------------------- | -------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------- |
| **Container engine**            | Rancher Desktop, set to the `dockerd (moby)` engine            | Rancher Desktop, set to `dockerd (moby)` | Docker Engine (`moby-engine`), with you in the `docker` group |
| **WSL 2**                       | –                                                              | Needed by Rancher Desktop                | –                                                             |
| **XQuartz**                     | For graphical tools in environments                            | –                                        | –                                                             |
| **IBM Cloud credential helper** | `docker-credential-icr`, used by Docker for images on `icr.io` | same                                     | same                                                          |
| **Git and GitHub CLI**          | Git and `gh`, signed in to github.ibm.com and used by Git      | same                                     | same                                                          |
| **IDE**                         | IBM Bob, VS Code or VSCodium                                   | same                                     | same                                                          |

Some fixes finish only after you log out and back in (XQuartz, the `docker` group on Fedora) or
restart Windows (WSL 2). Silicon Harbor remembers that and says so until it sees the change.

If Rancher Desktop is installed but not running, Silicon Harbor starts it for you.

```{note}
Silicon Harbor does not install an IDE for you. If none is found, **Get IBM Bob** opens the IBM
Bob download page. You can choose the IDE in **Settings › IDE**.
```

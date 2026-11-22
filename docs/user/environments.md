# Environments

An environment is a development container built from a repository's `devcontainer.json`, with the
repository checked out inside it. It runs on your computer and keeps running when you close
Silicon Harbor or your IDE.

## Create one

1. On **Environments**, click **New environment**.
2. Paste the repository's HTTPS address, the one you would use for `git clone`, for example
   `https://github.ibm.com/org/repo`.
3. Optional, under **Options**: a **Branch** (default: the repository's default branch), a
   **Name** (default: derived from the address) and the IDE to **Open with**.
4. Click **Create and open**.

Silicon Harbor shows the progress in five steps:

| Step                                     | What happens                                                                             |
| ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| Checking this computer                   | The container engine and sign-ins are ready.                                             |
| Getting the repository                   | The repository is cloned, with your github.ibm.com sign-in.                              |
| Downloading and starting the environment | The container image is downloaded (from `icr.io` with your IBM Cloud login) and started. |
| Preparing the environment                | The repository's setup commands run, with your credentials available.                    |
| Opening the IDE                          | IBM Bob, VS Code or VSCodium opens, connected to the environment.                        |

The first environment from an image takes longest, since the image is downloaded once. The
**Log** tab shows every line of output while it runs.

## Work with environments

The list on **Environments** shows each environment's state: **Running**, **Stopped**, a busy
state such as **Starting…**, or **Problem**. Its main button does the obvious next thing:

- **Open in IBM Bob** (or your IDE) on a running environment.
- **Start** on a stopped one.
- **View progress** while something is happening; **See problem** after a failure.

The environment's own page has **Overview** and **Log** tabs and these actions:

| Action            | What it does                                                                                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Open in …**     | Opens the IDE again.                                                                                                                                                   |
| **Open terminal** | A terminal inside the environment.                                                                                                                                     |
| **Stop**          | Stops the container; your files stay.                                                                                                                                  |
| **Rebuild**       | Re-creates the environment from the repository's current definition. Your files in the repository are kept; anything installed by hand inside the environment is lost. |
| **Delete…**       | Removes the environment from this computer. Changes you have not pushed are lost; the repository itself is not affected.                                               |

```{tip}
Push your work regularly. Deleting an environment, and in some cases rebuilding it, loses what
exists only inside it.
```

## Where your files are

The repository lives inside the environment (on macOS and Windows in a Docker volume, which is
much faster than sharing a folder with the container). Work on it through the IDE or a terminal
from Silicon Harbor; commit and push with Git as usual.

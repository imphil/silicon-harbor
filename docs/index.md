# Silicon Harbor

Silicon Harbor gives IBM chip developers a ready-to-use development environment from a Git
repository: paste the repository's address, and a few minutes later it is open in IBM Bob,
VS Code or VSCodium, with the tools, sign-ins and credentials the repository needs.

Environments are dev containers that run on your computer. Silicon Harbor sets up what they
need (a container engine, the Git sign-in to github.ibm.com, IBM Cloud and Artifactory credentials),
creates and starts them with the [Devsy](https://github.com/imphil/devsy) engine, and keeps
their credentials current.

- **[User guide](user/index.md):** install Silicon Harbor, create environments, sign in,
  solve problems, and prepare a repository's `devcontainer.json`.
- **[Developer guide](developer/index.md):** work on Silicon Harbor itself: setup,
  architecture, the Devsy engine and fork, tests and releases.

```{toctree}
:maxdepth: 2
:hidden:

user/index
developer/index
```

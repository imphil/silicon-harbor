# Install Silicon Harbor

Silicon Harbor runs on macOS (Apple silicon and Intel), Windows (x64) and Fedora Linux (x64).
Download the package for your system from the release page, install it, and start it.

| System  | Package                      | Install                                                    |
| ------- | ---------------------------- | ---------------------------------------------------------- |
| macOS   | `.zip` with the app, per CPU | Unpack it and move **Silicon Harbor** to **Applications**. |
| Windows | Setup program (`.exe`)       | Run it; it installs for your user.                         |
| Fedora  | `.rpm`                       | `sudo dnf install ./silicon-harbor-*.rpm`                  |

The packages are not code-signed, so the first start needs one extra step:

- **macOS** reports that the app cannot be checked for malicious software. Open **System
  Settings › Privacy & Security** and click **Open Anyway** next to the message about Silicon
  Harbor.
- **Windows** may show "Windows protected your PC". Click **More info**, then **Run anyway**.

Silicon Harbor brings its own copy of the Devsy engine; you don't install it separately. Everything
else it needs (a container engine, Git and the GitHub CLI, the IBM Cloud credential helper, an IDE)
it checks on its first start, see [](first-run.md).

## Updates

Automatic updates are not available yet. Install a newer package over the old one; your
environments, settings and sign-ins are kept.

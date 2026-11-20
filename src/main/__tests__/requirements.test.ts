// @vitest-environment node
import { describe, expect, it } from "vitest"
import { loadManifest, ManifestSchema } from "../installers/manifest"
import { linuxDocker, rancherDesktop } from "../requirements/container-engine"
import { credentialHelper } from "../requirements/credential-helper"
import {
  dockerConfigPath,
  hasIcrHelper,
  mergeIcrHelper,
  parseDockerConfig,
} from "../requirements/docker-config"
import { gitCredentials } from "../requirements/git-credentials"
import { BOB_DOWNLOAD_URL, ide } from "../requirements/ide"
import { requirementsFor } from "../requirements/registry"
import { userBinDir } from "../requirements/user-bin"
import { parseWslVersion, wsl } from "../requirements/wsl"
import { xquartz } from "../requirements/xquartz"
import { FakeHost, fail, fakeContext, ok } from "./fake-host"

const RD_APP = "/Applications/Rancher Desktop.app"
const RD_RDCTL = `${RD_APP}/Contents/Resources/resources/darwin/bin/rdctl`
const RD_DOCKER = `${RD_APP}/Contents/Resources/resources/darwin/bin/docker`
const settingsJson = (engine: string) =>
  ok(JSON.stringify({ containerEngine: { name: engine } }))

describe("registry", () => {
  it("lists the requirements per platform in display order", () => {
    const ids = (p: NodeJS.Platform) => requirementsFor(p).map((r) => r.id)
    expect(ids("darwin")).toEqual([
      "container-engine",
      "xquartz",
      "credential-helper",
      "git-credentials",
      "ide",
    ])
    expect(ids("win32")).toEqual([
      "wsl",
      "container-engine",
      "credential-helper",
      "git-credentials",
      "ide",
    ])
    expect(ids("linux")).toEqual([
      "container-engine",
      "credential-helper",
      "git-credentials",
      "ide",
    ])
  })
})

describe("container engine: Rancher Desktop (macOS)", () => {
  const macHost = (commands: Record<string, ReturnType<typeof ok>> = {}) =>
    new FakeHost({
      platform: "darwin",
      dirs: [RD_APP],
      path: { docker: RD_DOCKER },
      commands: {
        "/usr/bin/defaults": ok("1.25.0\n"),
        [`${RD_RDCTL} list-settings`]: settingsJson("moby"),
        [`${RD_DOCKER} info --format {{.ServerVersion}}`]: ok("28.5.1\n"),
        ...commands,
      },
    })

  it("is ok when running with dockerd and docker answers", async () => {
    const status = await rancherDesktop.check(fakeContext(macHost()))
    expect(status).toEqual({
      id: "container-engine",
      title: "Rancher Desktop",
      state: "ok",
      version: "1.25.0",
      detail: "Running with dockerd (moby).",
    })
  })

  it("offers to install when missing, then starts it with dockerd", async () => {
    const host = new FakeHost({ platform: "darwin" })
    const ctx = fakeContext(host, {
      onInstall: () => {
        host.dirs.add(RD_APP)
        host.commands[`${RD_RDCTL} list-settings`] = fail("not running")
        host.commands[
          `${RD_RDCTL} start --container-engine.name=moby --application.start-in-background`
        ] = ok()
        host.commands[`${RD_RDCTL} version`] = ok(
          "rdctl client version: 1.25.0",
        )
      },
    })
    expect(await rancherDesktop.check(ctx)).toMatchObject({
      state: "missing",
      detail: "Not installed. Runs your environments.",
      fix: { label: "Install" },
    })
    await rancherDesktop.fix?.(ctx)
    expect(ctx.installs).toEqual([
      { id: "rancher-desktop", binaryDest: undefined },
    ])
    expect(host.runs).toContain(
      `${RD_RDCTL} start --container-engine.name=moby --application.start-in-background`,
    )
  })

  it("switches a containerd setup to dockerd", async () => {
    const host = macHost({
      [`${RD_RDCTL} list-settings`]: settingsJson("containerd"),
      [`${RD_RDCTL} set --container-engine.name=moby`]: ok(),
    })
    const ctx = fakeContext(host)
    expect(await rancherDesktop.check(ctx)).toMatchObject({
      state: "warn",
      detail:
        "Uses the wrong engine (containerd). Silicon Harbor needs dockerd.",
      fix: { label: "Switch to dockerd" },
    })
    await rancherDesktop.fix?.(ctx)
    expect(host.runs).toContain(`${RD_RDCTL} set --container-engine.name=moby`)
    expect(host.elevatedRuns).toEqual([])
  })

  it("offers to start it when installed but not running", async () => {
    const host = macHost({ [`${RD_RDCTL} list-settings`]: fail("no server") })
    expect(await rancherDesktop.check(fakeContext(host))).toMatchObject({
      state: "warn",
      detail: "Installed, but not running.",
      fix: { label: "Start" },
    })
  })
})

describe("container engine: Rancher Desktop (Windows)", () => {
  const root = "C:\\Users\\dev\\AppData\\Local\\Programs\\Rancher Desktop"
  const bin = `${root}\\resources\\resources\\win32\\bin`

  it("finds the per-user install and checks the engine", async () => {
    const host = new FakeHost({
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local" },
      files: { [`${bin}\\rdctl.exe`]: "", [`${bin}\\docker.exe`]: "" },
      commands: {
        [`${bin}\\rdctl.exe version`]: ok("rdctl client version: 1.25.0"),
        [`${bin}\\rdctl.exe list-settings`]: settingsJson("moby"),
        [`${bin}\\docker.exe info --format {{.ServerVersion}}`]: ok("28.5.1"),
      },
    })
    expect(await rancherDesktop.check(fakeContext(host))).toMatchObject({
      state: "ok",
      version: "1.25.0",
    })
  })

  it("is missing without an install", async () => {
    const host = new FakeHost({
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local" },
    })
    expect(await rancherDesktop.check(fakeContext(host))).toMatchObject({
      state: "missing",
      fix: { label: "Install" },
    })
  })
})

describe("container engine: Docker Engine (Linux)", () => {
  const fedora = 'NAME="Fedora Linux"\nID=fedora\nVERSION_ID=43\n'
  const linuxHost = (
    commands: Record<string, ReturnType<typeof ok>>,
    osRelease = fedora,
    docker = true,
  ) =>
    new FakeHost({
      platform: "linux",
      userName: "dev",
      path: docker ? { docker: "/usr/bin/docker" } : {},
      files: { "/etc/os-release": osRelease },
      commands,
    })

  it("is ok when docker info answers", async () => {
    const host = linuxHost({
      "/usr/bin/docker info --format {{.ServerVersion}}": ok("28.5.2\n"),
    })
    expect(await linuxDocker.check(fakeContext(host))).toEqual({
      id: "container-engine",
      title: "Docker Engine",
      state: "ok",
      version: "28.5.2",
      detail: "Running.",
    })
  })

  it("installs moby-engine on Fedora with one password prompt", async () => {
    const host = linuxHost({ "id -nG": ok("dev wheel") }, fedora, false)
    const ctx = fakeContext(host)
    expect(await linuxDocker.check(ctx)).toMatchObject({
      state: "missing",
      fix: { label: "Install", needsRelogin: true },
    })
    const outcome = await linuxDocker.fix?.(ctx)
    expect(host.elevatedRuns).toEqual([
      "/bin/sh -c dnf install -y moby-engine && systemctl enable --now docker && usermod -aG docker 'dev'",
    ])
    expect(outcome).toEqual({ needsRelogin: true })
  })

  it("does not offer an install on other distributions", async () => {
    const host = linuxHost({}, 'ID="opensuse-tumbleweed"\n', false)
    const status = await linuxDocker.check(fakeContext(host))
    expect(status.state).toBe("missing")
    expect(status.fix).toBeUndefined()
    await expect(linuxDocker.fix?.(fakeContext(host))).rejects.toThrow(/Fedora/)
  })

  it("starts a stopped service", async () => {
    const host = linuxHost({
      "/usr/bin/docker": fail("Cannot connect"),
      "systemctl is-active docker": ok("inactive\n"),
      "id -nG": ok("dev docker"),
    })
    const ctx = fakeContext(host)
    expect(await linuxDocker.check(ctx)).toMatchObject({
      state: "warn",
      detail: "Installed, but not running.",
      fix: { label: "Start" },
    })
    await linuxDocker.fix?.(ctx)
    expect(host.elevatedRuns[0]).toContain("systemctl enable --now docker")
  })

  it("adds the user to the docker group, then asks to log in again", async () => {
    const host = linuxHost({
      "/usr/bin/docker": fail("permission denied while trying to connect"),
      "systemctl is-active docker": ok("active\n"),
      "id -nG": ok("dev wheel"),
      "getent group docker": ok("docker:x:973:\n"),
    })
    const ctx = fakeContext(host)
    expect(await linuxDocker.check(ctx)).toMatchObject({
      state: "warn",
      detail: "Installed, but your user is not in the docker group.",
      fix: { label: "Add me to the group", needsRelogin: true },
    })
    expect(await linuxDocker.fix?.(ctx)).toEqual({ needsRelogin: true })
    expect(host.elevatedRuns).toEqual(["/bin/sh -c usermod -aG docker 'dev'"])

    host.commands["getent group docker"] = ok("docker:x:973:dev\n")
    expect(await linuxDocker.check(ctx)).toMatchObject({
      state: "warn",
      detail: "Added to the docker group. Log out and back in once to finish.",
    })
  })

  it("refuses unexpected user names instead of passing them to a shell", async () => {
    const host = linuxHost({}, fedora, false)
    host.userName = "dev'; rm -rf /"
    await expect(linuxDocker.fix?.(fakeContext(host))).rejects.toThrow(
      /user name/,
    )
    expect(host.elevatedRuns).toEqual([])
  })
})

describe("WSL", () => {
  it("parses wsl --version", () => {
    expect(parseWslVersion("WSL version: 2.6.1.0\r\nKernel version: 6.6")).toBe(
      "2.6.1.0",
    )
    expect(parseWslVersion("WSL-Version: 2.3.26.0")).toBe("2.3.26.0")
  })

  it("is ok with WSL 2", async () => {
    const host = new FakeHost({
      platform: "win32",
      commands: { "wsl.exe --version": ok("WSL version: 2.6.1.0\r\n") },
    })
    expect(await wsl.check(fakeContext(host))).toEqual({
      id: "wsl",
      title: "WSL 2",
      state: "ok",
      version: "2.6.1",
      detail: "WSLg shows graphical tools from your environments.",
    })
  })

  it("installs WSL elevated and asks for a restart", async () => {
    const host = new FakeHost({
      platform: "win32",
      commands: { "wsl.exe": fail("not installed", 50) },
    })
    const ctx = fakeContext(host)
    expect(await wsl.check(ctx)).toMatchObject({
      state: "missing",
      fix: { label: "Install", needsReboot: true },
    })
    expect(await wsl.fix?.(ctx)).toEqual({ needsReboot: true })
    expect(host.elevatedRuns).toEqual(["wsl.exe --install --no-distribution"])

    const pending = fakeContext(host, { pending: "reboot" })
    expect(await wsl.check(pending)).toMatchObject({
      state: "warn",
      detail: "Installed. Restart the computer once to finish.",
    })
  })

  it("updates the old in-box WSL", async () => {
    const host = new FakeHost({
      platform: "win32",
      commands: {
        "wsl.exe --version": fail("invalid option"),
        "wsl.exe --status": ok("Default Version: 1"),
      },
    })
    const ctx = fakeContext(host)
    expect(await wsl.check(ctx)).toMatchObject({
      state: "warn",
      fix: { label: "Update" },
    })
    await wsl.fix?.(ctx)
    expect(host.elevatedRuns).toEqual(["wsl.exe --update"])
  })
})

describe("XQuartz", () => {
  it("installs the pkg and asks to log in again", async () => {
    const host = new FakeHost({ platform: "darwin" })
    const ctx = fakeContext(host)
    expect(await xquartz.check(ctx)).toMatchObject({
      state: "missing",
      detail:
        "Not installed. Graphical tools in your environments will not open.",
      fix: { label: "Install", needsRelogin: true },
    })
    expect(await xquartz.fix?.(ctx)).toEqual({ needsRelogin: true })
    expect(ctx.installs).toEqual([{ id: "xquartz", binaryDest: undefined }])
  })

  it("is done but notes the pending re-login until DISPLAY is set", async () => {
    const host = new FakeHost({
      platform: "darwin",
      dirs: ["/Applications/Utilities/XQuartz.app"],
      commands: { "/usr/bin/defaults": ok("2.8.6") },
    })
    const waiting = fakeContext(host, { pending: "relogin" })
    expect(await xquartz.check(waiting)).toMatchObject({
      state: "ok",
      detail: "Installed. Log out and back in once to finish.",
    })
    expect(waiting.resolved).toBe(false)

    host.env.DISPLAY = "/private/tmp/com.apple.launchd.x/org.xquartz:0"
    const after = fakeContext(host, { pending: "relogin" })
    expect(await xquartz.check(after)).toEqual({
      id: "xquartz",
      title: "XQuartz",
      state: "ok",
      version: "2.8.6",
      detail: "Shows graphical tools from your environments.",
    })
    expect(after.resolved).toBe(true)
  })
})

describe("docker config", () => {
  it("respects DOCKER_CONFIG", () => {
    expect(dockerConfigPath({}, "/home/dev")).toBe(
      "/home/dev/.docker/config.json",
    )
    expect(dockerConfigPath({ DOCKER_CONFIG: "/etc/dc" }, "/home/dev")).toBe(
      "/etc/dc/config.json",
    )
  })

  it("adds the icr helper and keeps every other key", () => {
    const read = parseDockerConfig(
      JSON.stringify({
        credsStore: "osxkeychain",
        auths: { "ghcr.io": {} },
        credHelpers: { "gcr.io": "gcloud" },
        proxies: { default: { httpProxy: "http://p" } },
      }),
    )
    if (!read.ok) throw new Error("parse failed")
    const merged = JSON.parse(mergeIcrHelper(read.config))
    expect(merged).toEqual({
      credsStore: "osxkeychain",
      auths: { "ghcr.io": {} },
      credHelpers: { "gcr.io": "gcloud", "icr.io": "icr" },
      proxies: { default: { httpProxy: "http://p" } },
    })
    expect(hasIcrHelper(merged)).toBe(true)
  })

  it("creates a config when there is none and rejects broken JSON", () => {
    const empty = parseDockerConfig(null)
    if (!empty.ok) throw new Error("parse failed")
    expect(JSON.parse(mergeIcrHelper(empty.config))).toEqual({
      credHelpers: { "icr.io": "icr" },
    })
    expect(parseDockerConfig("{ nope").ok).toBe(false)
    expect(parseDockerConfig("[1]").ok).toBe(false)
  })
})

describe("credential helper", () => {
  const config = "/home/dev/.docker/config.json"
  const binDir = "/home/dev/.silicon-harbor/bin"
  const installable = ManifestSchema.parse({
    ...loadManifest(),
    items: {
      ...loadManifest().items,
      "docker-credential-icr": {
        name: "docker-credential-icr",
        version: "0.1.0",
        homepage: "https://github.com/imphil/docker-credential-icr",
        assets: {
          "linux-x64": {
            kind: "binary",
            url: "https://example.com/docker-credential-icr",
            sha256: "b".repeat(64),
          },
        },
      },
    },
  })

  it("offers the install for the pinned release", async () => {
    const host = new FakeHost({ platform: "linux" })
    const status = await credentialHelper.check(fakeContext(host))
    expect(status).toMatchObject({
      state: "missing",
      fix: { label: "Install" },
    })
  })

  it("explains that it cannot be installed while no release exists", async () => {
    const host = new FakeHost({ platform: "linux" })
    const unreleased = ManifestSchema.parse({
      ...loadManifest(),
      items: {
        ...loadManifest().items,
        "docker-credential-icr": {
          ...loadManifest().items["docker-credential-icr"],
          version: null,
          assets: {},
        },
      },
    })
    const status = await credentialHelper.check(
      fakeContext(host, { manifest: unreleased }),
    )
    expect(status.state).toBe("missing")
    expect(status.fix).toBeUndefined()
    expect(status.detail).toMatch(/cannot be installed automatically yet/)
  })

  it("on macOS stages the download and copies it to /usr/local/bin with the admin prompt", async () => {
    const host = new FakeHost({
      platform: "darwin",
      files: { [config]: "{}\n" },
    })
    const macInstallable = ManifestSchema.parse({
      ...installable,
      items: {
        ...installable.items,
        "docker-credential-icr": {
          ...installable.items["docker-credential-icr"],
          assets: {
            "darwin-arm64": {
              kind: "binary",
              url: "https://example.com/docker-credential-icr",
              sha256: "b".repeat(64),
            },
          },
        },
      },
    })
    const ctx = fakeContext(host, {
      manifest: macInstallable,
      binDir: userBinDir("darwin", "/Users/dev", {}),
    })
    await credentialHelper.fix?.(ctx)
    expect(ctx.installs).toHaveLength(1)
    const staged = ctx.installs[0].binaryDest ?? ""
    expect(staged).not.toContain("/usr/local/bin")
    expect(host.elevatedRuns).toEqual([
      `/bin/sh -c mkdir -p '/usr/local/bin' && install -m 0755 '${staged}' '/usr/local/bin/docker-credential-icr'`,
    ])
  })

  it("on Windows installs per user and adds the folder to the user's PATH", async () => {
    const host = new FakeHost({
      platform: "win32",
      files: { "C:\\Users\\dev\\.docker\\config.json": "{}\n" },
      commands: { "powershell.exe": ok("") },
    })
    const binDir = userBinDir("win32", "C:\\Users\\dev", {
      LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local",
    })
    expect(binDir).toBe(
      "C:\\Users\\dev\\AppData\\Local\\Programs\\docker-credential-icr",
    )
    const winInstallable = ManifestSchema.parse({
      ...installable,
      items: {
        ...installable.items,
        "docker-credential-icr": {
          ...installable.items["docker-credential-icr"],
          assets: {
            "win32-x64": {
              kind: "binary",
              url: "https://example.com/docker-credential-icr.exe",
              sha256: "b".repeat(64),
            },
          },
        },
      },
    })
    const ctx = fakeContext(host, { manifest: winInstallable, binDir })
    await credentialHelper.fix?.(ctx)
    expect(ctx.installs).toEqual([
      {
        id: "docker-credential-icr",
        binaryDest: `${binDir}\\docker-credential-icr.exe`,
      },
    ])
    expect(host.elevatedRuns).toEqual([])
    const ps = host.runs.find((r) => r.startsWith("powershell.exe"))
    expect(ps).toContain(`$d = '${binDir}'`)
    expect(ps).toContain("SetEnvironmentVariable('Path', $n, 'User')")
  })

  it("on Linux installs into ~/.local/bin", () => {
    expect(userBinDir("linux", "/home/dev", {})).toBe("/home/dev/.local/bin")
  })

  it("installs into our bin dir and merges the config with a backup", async () => {
    const original = '{\n\t"credsStore": "secretservice"\n}\n'
    const host = new FakeHost({
      platform: "linux",
      files: { [config]: original, "/tmp/dl": "bin" },
    })
    const ctx = fakeContext(host, { manifest: installable, binDir })
    expect(await credentialHelper.check(ctx)).toMatchObject({
      state: "missing",
      fix: { label: "Install" },
    })
    await credentialHelper.fix?.(ctx)
    expect(ctx.installs).toEqual([
      {
        id: "docker-credential-icr",
        binaryDest: `${binDir}/docker-credential-icr`,
      },
    ])
    expect(host.writes.map((w) => w.path)).toEqual([
      `${config}.silicon-harbor-backup`,
      config,
    ])
    expect(host.writes[0].content).toBe(original)
    expect(JSON.parse(host.files[config])).toEqual({
      credsStore: "secretservice",
      credHelpers: { "icr.io": "icr" },
    })
  })

  it("sets up the config when only that is missing, and is ok afterwards", async () => {
    const host = new FakeHost({
      platform: "linux",
      path: { "docker-credential-icr": "/usr/local/bin/docker-credential-icr" },
      commands: {
        "/usr/local/bin/docker-credential-icr --version": ok(
          "docker-credential-icr 0.1.0\n",
        ),
      },
    })
    const ctx = fakeContext(host)
    expect(await credentialHelper.check(ctx)).toMatchObject({
      state: "warn",
      detail: "Installed, but not set up for icr.io yet.",
      fix: { label: "Set up" },
    })
    await credentialHelper.fix?.(ctx)
    expect(ctx.installs).toEqual([])
    expect(host.writes.map((w) => w.path)).toEqual([config])
    expect(await credentialHelper.check(ctx)).toMatchObject({
      state: "ok",
      version: "0.1.0",
      detail: "Signs in to icr.io with your IBM Cloud login.",
    })
  })

  it("never overwrites an unreadable config", async () => {
    const host = new FakeHost({
      platform: "linux",
      path: { "docker-credential-icr": "/usr/bin/docker-credential-icr" },
      files: { [config]: "{ broken" },
    })
    const ctx = fakeContext(host)
    const status = await credentialHelper.check(ctx)
    expect(status.state).toBe("warn")
    expect(status.fix).toBeUndefined()
    await expect(credentialHelper.fix?.(ctx)).rejects.toThrow(/left unchanged/)
    expect(host.writes).toEqual([])
  })
})

describe("IDE", () => {
  it("lists the found IDEs with the default first", async () => {
    const host = new FakeHost({
      platform: "linux",
      path: { codium: "/usr/bin/codium", code: "/usr/bin/code" },
      commands: {
        "/usr/bin/code --version": ok("1.106.0\nabc\nx64\n"),
        "/usr/bin/codium --version": ok("1.105.1\n"),
      },
    })
    expect(
      await ide.check(
        fakeContext(host, { settings: { defaultIde: "codium" } }),
      ),
    ).toEqual({
      id: "ide",
      title: "IDE",
      state: "ok",
      version: "1.105.1",
      detail: "VSCodium, Visual Studio Code",
      ides: [
        {
          id: "bob",
          label: "IBM Bob",
          installed: false,
          downloadUrl: "https://bob.ibm.com/download?bob=ide",
          recommended: true,
        },
        {
          id: "vscode",
          label: "Visual Studio Code",
          installed: true,
          version: "1.106.0",
          downloadUrl: "https://code.visualstudio.com/download",
        },
        {
          id: "codium",
          label: "VSCodium",
          installed: true,
          version: "1.105.1",
          downloadUrl: "https://vscodium.com/#install",
        },
      ],
    })
  })

  it("finds IBM Bob and VSCodium by their macOS app paths", async () => {
    const bob = "/Applications/Bobide.app/Contents/Resources/app/bin/bobide"
    const codium =
      "/Applications/VSCodium.app/Contents/Resources/app/bin/codium"
    const host = new FakeHost({
      platform: "darwin",
      files: { [bob]: "", [codium]: "" },
      commands: { [`${bob} --version`]: ok("1.2.3\n") },
    })
    expect(
      await ide.check(fakeContext(host, { settings: { defaultIde: "bob" } })),
    ).toMatchObject({
      state: "ok",
      version: "1.2.3",
      detail: "IBM Bob, VSCodium",
    })
  })

  it("makes the only installed IDE the default, without a warning", async () => {
    const host = new FakeHost({
      platform: "linux",
      path: { code: "/usr/bin/code" },
      commands: { "/usr/bin/code --version": ok("1.106.0\n") },
    })
    const ctx = fakeContext(host, { settings: { defaultIde: "bob" } })
    expect(await ide.check(ctx)).toMatchObject({
      state: "ok",
      version: "1.106.0",
      detail: "Visual Studio Code",
    })
    expect(ctx.settings().defaultIde).toBe("vscode")
  })

  it("leaves the default alone when it is the only IDE", async () => {
    const host = new FakeHost({
      platform: "linux",
      path: { bobide: "/opt/bob/bobide" },
    })
    const ctx = fakeContext(host)
    expect(await ide.check(ctx)).toMatchObject({
      state: "ok",
      detail: "IBM Bob",
    })
    expect(ctx.settings().defaultIde).toBe("bob")
  })

  it("warns when the default IDE is missing but several others exist", async () => {
    const host = new FakeHost({
      platform: "linux",
      path: { code: "/usr/bin/code", codium: "/usr/bin/codium" },
    })
    const ctx = fakeContext(host)
    expect(await ide.check(ctx)).toMatchObject({
      state: "warn",
      detail:
        "IBM Bob was not found. Found: Visual Studio Code, VSCodium. Change the default IDE in Settings › IDE.",
    })
    expect(ctx.settings().defaultIde).toBe("bob")
  })

  it("opens the IBM Bob download page when no IDE is installed", async () => {
    const host = new FakeHost({ platform: "win32" })
    const ctx = fakeContext(host)
    expect(await ide.check(ctx)).toMatchObject({
      state: "missing",
      fix: { label: "Get IBM Bob" },
    })
    await ide.fix?.(ctx)
    expect(host.opened).toEqual([BOB_DOWNLOAD_URL])
    expect(BOB_DOWNLOAD_URL).toBe("https://bob.ibm.com/download?bob=ide")
  })
})

describe("GitHub CLI sign-in", () => {
  const SIGNED_IN =
    "github.ibm.com:\n    git_protocol: https\n    users:\n        dev:\n    user: dev\n"
  const FEDORA = "NAME=Fedora Linux\nID=fedora\nVERSION_ID=43\n"
  const GH_VERSION = ok(
    "gh version 2.105.0 (2026-11-10)\nhttps://github.com/cli/cli/releases/tag/v2.105.0\n",
  )
  const PURPOSE = "Signs Git and the GitHub CLI in to github.ibm.com."

  describe("Linux", () => {
    const HOSTS = "/home/dev/.config/gh/hosts.yml"
    const GH = "/usr/bin/gh"

    function linuxHost(
      opts: {
        tools?: boolean
        signedIn?: boolean
        helper?: boolean
        rewrite?: string
        fedora?: boolean
        env?: NodeJS.ProcessEnv
      } = {},
    ) {
      const { tools = true, signedIn = true, helper = true } = opts
      const state = { helper }
      const host = new FakeHost({
        platform: "linux",
        env: opts.env,
        path: tools ? { gh: GH, git: "/usr/bin/git" } : {},
        files: {
          ...(signedIn ? { [HOSTS]: SIGNED_IN } : {}),
          ...(opts.fedora === false ? {} : { "/etc/os-release": FEDORA }),
        },
        commands: {
          [`${GH} --version`]: GH_VERSION,
          "git config --get-all credential.https://github.ibm.com.helper":
            () =>
              state.helper
                ? ok("\n!/usr/bin/gh auth git-credential\n")
                : fail(""),
          "git config --get-all credential.helper": fail(""),
          "git config --get-regexp ^url\\..*\\.insteadof$": opts.rewrite
            ? ok(`${opts.rewrite}\n`)
            : fail(""),
          [`${GH} auth setup-git --hostname github.ibm.com`]: () => {
            state.helper = true
            return ok("")
          },
        },
      })
      return { host, state }
    }

    it("is ok when gh is signed in and Git uses it", async () => {
      const { host } = linuxHost()
      expect(await gitCredentials.check(fakeContext(host))).toEqual({
        id: "git-credentials",
        title: "GitHub CLI",
        state: "ok",
        version: "2.105.0",
        detail: PURPOSE,
      })
    })

    it("installs gh with dnf, then signs in through the browser", async () => {
      const { host } = linuxHost({ tools: false, signedIn: false })
      const ctx = fakeContext(host, {
        onSignIn: (onCode) => {
          onCode({
            code: "ABCD-1234",
            url: "https://github.ibm.com/login/device",
          })
          host.files[HOSTS] = SIGNED_IN
        },
      })
      expect(await gitCredentials.check(ctx)).toMatchObject({
        state: "missing",
        detail: `Not installed (gh, git). ${PURPOSE}`,
        fix: { label: "Install" },
      })
      host.elevatedResponses["/bin/sh"] = () => {
        host.path.gh = GH
        host.path.git = "/usr/bin/git"
        return ok("")
      }
      await gitCredentials.fix?.(ctx)
      expect(host.elevatedRuns).toEqual(["/bin/sh -c dnf install -y gh git"])
      expect(ctx.signIns).toBe(1)
      expect(ctx.progressLog.at(-1)).toBe(
        "Enter the code ABCD-1234 on the page that opened in your browser (it is on your clipboard).",
      )
      expect((await gitCredentials.check(ctx)).state).toBe("ok")
    })

    it("asks for a sign-in", async () => {
      const { host } = linuxHost({ signedIn: false })
      const ctx = fakeContext(host)
      expect(await gitCredentials.check(ctx)).toMatchObject({
        state: "warn",
        version: "2.105.0",
        detail: "Not signed in to github.ibm.com yet.",
        fix: { label: "Sign in" },
      })
      await gitCredentials.fix?.(ctx)
      expect(ctx.signIns).toBe(1)
      expect((await gitCredentials.check(ctx)).state).toBe("warn")
    })

    it("sets Git up to use gh when only that is missing", async () => {
      const { host } = linuxHost({ helper: false })
      const ctx = fakeContext(host)
      expect(await gitCredentials.check(ctx)).toMatchObject({
        state: "warn",
        fix: { label: "Set up" },
      })
      await gitCredentials.fix?.(ctx)
      expect(host.runs).toContain(
        `${GH} auth setup-git --hostname github.ibm.com`,
      )
      expect(ctx.signIns).toBe(0)
      expect((await gitCredentials.check(ctx)).state).toBe("ok")
    })

    it("warns about an insteadOf rule that rewrites HTTPS, without a fix", async () => {
      const { host } = linuxHost({
        rewrite: "url.git@github.ibm.com:.insteadof https://github.ibm.com/",
      })
      const status = await gitCredentials.check(fakeContext(host))
      expect(status).toMatchObject({ state: "warn" })
      expect(status.detail).toContain(
        "(url.git@github.ibm.com:.insteadof = https://github.ibm.com/)",
      )
      expect(status.fix).toBeUndefined()
    })

    it("only offers the install on Fedora", async () => {
      const { host } = linuxHost({ tools: false, fedora: false })
      const status = await gitCredentials.check(fakeContext(host))
      expect(status).toMatchObject({ state: "missing" })
      expect(status.fix).toBeUndefined()
    })

    it("honours GH_CONFIG_DIR", async () => {
      const { host } = linuxHost({
        signedIn: false,
        env: { GH_CONFIG_DIR: "/cfg/gh" },
      })
      host.files["/cfg/gh/hosts.yml"] = SIGNED_IN
      expect((await gitCredentials.check(fakeContext(host))).state).toBe("ok")
    })
  })

  describe("macOS", () => {
    it("asks Apple's installer for Git when the developer tools are missing", async () => {
      const host = new FakeHost({
        platform: "darwin",
        commands: { "/usr/bin/xcode-select -p": fail("not installed", 2) },
      })
      const ctx = fakeContext(host)
      expect(await gitCredentials.check(ctx)).toMatchObject({
        state: "missing",
        fix: { label: "Install Git" },
      })
      await gitCredentials.fix?.(ctx)
      expect(host.runs).toContain("/usr/bin/xcode-select --install")
      expect(ctx.installs).toEqual([])
      expect(ctx.signIns).toBe(0)
    })

    it("installs the pinned gh package, then signs in", async () => {
      const host = new FakeHost({
        platform: "darwin",
        commands: {
          "/usr/bin/xcode-select -p": ok("/Library/Developer/CommandLineTools"),
          "/usr/local/bin/gh --version": GH_VERSION,
        },
      })
      const ctx = fakeContext(host, {
        // The pkg puts gh into /usr/local/bin, not on the app's PATH yet.
        onInstall: () => {
          host.files["/usr/local/bin/gh"] = ""
        },
      })
      expect(await gitCredentials.check(ctx)).toMatchObject({
        title: "GitHub CLI",
        state: "missing",
        detail: `Not installed. ${PURPOSE}`,
        fix: { label: "Install" },
      })
      await gitCredentials.fix?.(ctx)
      expect(ctx.installs.map((i) => i.id)).toEqual(["gh"])
      expect(ctx.signIns).toBe(1)
    })
  })

  describe("Windows", () => {
    const GH = "C:\\Program Files\\GitHub CLI\\gh.exe"
    const HOSTS = "C:\\Users\\dev\\AppData\\Roaming\\GitHub CLI\\hosts.yml"
    const env = {
      ProgramFiles: "C:\\Program Files",
      APPDATA: "C:\\Users\\dev\\AppData\\Roaming",
    }

    it("installs Git for Windows when Git is missing", async () => {
      const host = new FakeHost({ platform: "win32", env })
      const ctx = fakeContext(host)
      expect(await gitCredentials.check(ctx)).toMatchObject({
        state: "missing",
        detail: "Git is not installed. Git for Windows adds it.",
        fix: { label: "Install Git" },
      })
      await gitCredentials.fix?.(ctx)
      expect(ctx.installs.map((i) => i.id)).toContain("git-for-windows")
    })

    it("finds a freshly installed gh in Program Files and its sign-in in AppData", async () => {
      const host = new FakeHost({
        platform: "win32",
        env,
        files: { [GH]: "", [HOSTS]: SIGNED_IN },
        commands: {
          "git --version": ok("git version 2.56.1.windows.1\n"),
          [`${GH} --version`]: GH_VERSION,
          "git config --get-all credential.https://github.ibm.com.helper": ok(
            "\n!'C:\\Program Files\\GitHub CLI\\gh.exe' auth git-credential\n",
          ),
          "git config --get-regexp ^url\\..*\\.insteadof$": fail(""),
        },
      })
      expect(await gitCredentials.check(fakeContext(host))).toMatchObject({
        state: "ok",
        version: "2.105.0",
      })
    })

    it("installs the pinned gh MSI when gh is missing", async () => {
      const host = new FakeHost({
        platform: "win32",
        env,
        commands: { "git --version": ok("git version 2.56.1.windows.1\n") },
      })
      const ctx = fakeContext(host, {
        onInstall: () => {
          host.files[GH] = ""
        },
      })
      await gitCredentials.fix?.(ctx)
      expect(ctx.installs.map((i) => i.id)).toEqual(["gh"])
      expect(ctx.signIns).toBe(1)
    })
  })
})

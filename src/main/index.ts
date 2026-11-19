import { existsSync, mkdirSync } from "node:fs"
import { homedir, uptime, userInfo } from "node:os"
import { join } from "node:path"
import { app, BrowserWindow, clipboard, ipcMain, shell } from "electron"
import { type AppInfo, IpcChannel } from "../shared/api.js"
import { DevsyClient } from "./devsy/client.js"
import {
  buildCliEnv,
  defaultDevsyHome,
  executableSearchPath,
} from "./devsy/env.js"
import { CliRunner } from "./devsy/runner.js"
import { devsyBinaryPath } from "./devsy-path.js"
import { EnvironmentService } from "./environments.js"
import { loadManifest } from "./installers/manifest.js"
import { registerIpc } from "./ipc.js"
import { LogStore } from "./log-store.js"
import { NodeHost } from "./requirements/host.js"
import { RequirementService } from "./requirements/service.js"
import { userBinDir } from "./requirements/user-bin.js"
import { SettingsStore } from "./settings-store.js"
import { SetupLog } from "./setup-log.js"

// Tests run against a throwaway profile (settings, logs, Chromium caches) so
// they never touch the user's real one. Must happen before the app is ready.
if (process.env.SH_USER_DATA_DIR) {
  app.setPath("userData", process.env.SH_USER_DATA_DIR)
}

let mainWindow: BrowserWindow | null = null
let runner: CliRunner | null = null
let environments: EnvironmentService | null = null

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload)
  }
}

function startBackend(): void {
  const devsyHome = defaultDevsyHome(process.platform, homedir(), process.env)
  mkdirSync(devsyHome, { recursive: true })
  // Our own tools (docker-credential-icr). On the user's PATH (their own
  // `docker pull icr.io/…` needs the helper too) and, because GUI apps and
  // a PATH changed at runtime don't see it, explicitly on the Devsy CLI's.
  const binDir = userBinDir(process.platform, homedir(), process.env)
  const info = appInfo()
  runner = new CliRunner({
    // A missing binary surfaces as a failed operation with a clear message.
    binaryPath: info.devsyPath ?? "devsy",
    env: buildCliEnv({
      hostEnv: process.env,
      platform: process.platform,
      homeDir: homedir(),
      devsyHome,
      extraPathDirs: [binDir],
    }),
  })
  const client = new DevsyClient(runner)
  const settings = new SettingsStore(
    join(app.getPath("userData"), "settings.json"),
  )
  const logs = new LogStore(join(app.getPath("userData"), "logs"))
  environments = new EnvironmentService({
    client,
    logs,
    settings: () => settings.get(),
    watchDir: devsyHome,
    // Docker runs in a VM on macOS and Windows; a bind-mounted source is
    // slow there. On Linux the host folder is native and stays visible.
    cloneIntoVolume: cloneIntoVolumeFor(process.platform),
    onChange: (envs) => broadcast(IpcChannel.evtEnvironments, envs),
    onLog: (id, line) => broadcast(IpcChannel.evtLog, { id, line }),
  })
  const setupLog = new SetupLog(
    join(app.getPath("userData"), "logs", "setup.log"),
  )
  setupLog.write(
    `Silicon Harbor ${info.appVersion} started (${process.platform} ${process.arch})`,
  )
  const requirements = new RequirementService({
    log: (entry) => setupLog.write(entry),
    host: new NodeHost({
      log: (entry) => setupLog.write(entry),
      homeDir: homedir(),
      userName: currentUserName(),
      // GUI apps on macOS get a minimal PATH; find Homebrew/Rancher tools.
      env: {
        ...process.env,
        PATH: executableSearchPath(
          process.env.PATH ?? "",
          process.platform,
          homedir(),
        ),
      },
      openExternal: (url) => shell.openExternal(url),
    }),
    manifest: loadManifest(),
    binDir,
    settings: () => settings.get(),
    pendingFile: join(app.getPath("userData"), "requirements-pending.json"),
    bootTime: () => Date.now() - uptime() * 1000,
    onChange: (list) => broadcast(IpcChannel.evtRequirements, list),
  })
  registerIpc({
    ipcMain,
    appInfo,
    environments,
    settings,
    client,
    devsyHome,
    writeClipboard: (text) => clipboard.writeText(text),
    requirements,
    setupLog: (lines) => setupLog.tail(lines),
  })
  void environments.start()
  void requirements.check()
}

function cloneIntoVolumeFor(platform: NodeJS.Platform): boolean {
  return platform === "darwin" || platform === "win32"
}

function currentUserName(): string {
  try {
    return userInfo().username
  } catch {
    return ""
  }
}

function appInfo(): AppInfo {
  const devsyPath = devsyBinaryPath({
    platform: process.platform,
    arch: process.arch,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  })
  return {
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    platform: process.platform,
    arch: process.arch,
    devsyPath: existsSync(devsyPath) ? devsyPath : null,
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: "Silicon Harbor",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow.once("ready-to-show", () => mainWindow?.show())
  mainWindow.on("closed", () => {
    mainWindow = null
  })

  // External links open in the user's browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url)
    return { action: "deny" }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"))
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  void app.whenReady().then(() => {
    startBackend()
    createWindow()
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  // Closing the window quits the app on every platform: environments keep
  // running in Docker regardless, and there is no tray icon.
  app.on("window-all-closed", () => app.quit())

  // Detached Devsy tasks keep running; only our followers and polls stop.
  app.on("will-quit", () => {
    environments?.stop()
    runner?.killAll()
  })
}

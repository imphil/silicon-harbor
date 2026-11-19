import { existsSync } from "node:fs"
import { join } from "node:path"
import { app, BrowserWindow, ipcMain, shell } from "electron"
import { type AppInfo, IpcChannel } from "../shared/api.js"
import { devsyBinaryPath } from "./devsy-path.js"

let mainWindow: BrowserWindow | null = null

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

function registerIpc(): void {
  ipcMain.handle(IpcChannel.appInfo, () => appInfo())

  // Placeholders until M1 (environments, settings) and M2 (requirements)
  // implement them. Every channel is registered so calls fail with a clear
  // message instead of "no handler registered".
  const notImplemented = (name: string) => () => {
    throw new Error(`${name} is not implemented yet`)
  }
  for (const [name, channel] of Object.entries(IpcChannel)) {
    if (channel === IpcChannel.appInfo || channel.startsWith("evt:")) continue
    ipcMain.handle(channel, notImplemented(name))
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
    registerIpc()
    createWindow()
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  // Closing the window quits the app on every platform: environments keep
  // running in Docker regardless, and there is no tray icon.
  app.on("window-all-closed", () => app.quit())
}

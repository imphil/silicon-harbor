import { contextBridge, ipcRenderer } from "electron"
import { type AppInfo, IpcChannel, type SiliconHarborApi } from "../shared/api"

// Expose a narrow, typed API instead of a generic invoke(channel) bridge so the
// renderer can only reach the handlers listed in src/shared/api.ts.
const api: SiliconHarborApi = {
  getAppInfo: () => ipcRenderer.invoke(IpcChannel.appInfo) as Promise<AppInfo>,
}

contextBridge.exposeInMainWorld("siliconHarbor", api)

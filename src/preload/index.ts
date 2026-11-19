import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron"
import {
  type Environment,
  IpcChannel,
  type LogLine,
  type RequirementStatus,
  type SiliconHarborApi,
  type Unsubscribe,
} from "../shared/api"

// Expose a narrow, typed API instead of a generic invoke(channel) bridge so the
// renderer can only reach the handlers listed in src/shared/api.ts.

function subscribe<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const listener = (_event: IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const invoke = <T>(channel: string, ...args: unknown[]) =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>

const api: SiliconHarborApi = {
  getAppInfo: () => invoke(IpcChannel.appInfo),

  listEnvironments: () => invoke(IpcChannel.envList),
  getEnvironment: (id) => invoke(IpcChannel.envGet, id),
  createEnvironment: (req) => invoke(IpcChannel.envCreate, req),
  startEnvironment: (id) => invoke(IpcChannel.envStart, id),
  stopEnvironment: (id) => invoke(IpcChannel.envStop, id),
  rebuildEnvironment: (id) => invoke(IpcChannel.envRebuild, id),
  deleteEnvironment: (id) => invoke(IpcChannel.envDelete, id),
  cancelOperation: (id) => invoke(IpcChannel.envCancel, id),
  openInIde: (id, ide) => invoke(IpcChannel.envOpenIde, id, ide),
  openTerminal: (id) => invoke(IpcChannel.envOpenTerminal, id),
  getLog: (id) => invoke(IpcChannel.envLog, id),
  copyDiagnostics: (id) => invoke(IpcChannel.diagnosticsCopy, id),

  checkRequirements: () => invoke(IpcChannel.reqCheck),
  fixRequirement: (id) => invoke(IpcChannel.reqFix, id),

  getSettings: () => invoke(IpcChannel.settingsGet),
  updateSettings: (patch) => invoke(IpcChannel.settingsUpdate, patch),

  onEnvironmentsChanged: (cb) =>
    subscribe<Environment[]>(IpcChannel.evtEnvironments, cb),
  onLog: (id, cb) =>
    subscribe<{ id: string; line: LogLine }>(IpcChannel.evtLog, (payload) => {
      if (payload.id === id) cb(payload.line)
    }),
  onRequirementsChanged: (cb) =>
    subscribe<RequirementStatus[]>(IpcChannel.evtRequirements, cb),
}

contextBridge.exposeInMainWorld("siliconHarbor", api)

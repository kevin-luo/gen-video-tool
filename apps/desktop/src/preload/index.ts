import {contextBridge, ipcRenderer} from 'electron';
import type {
  DesktopApi,
  ExportProgress,
  GenerateProductionShotRequest,
  ProductionProgress,
} from '../shared/desktop-api.js';
import {IPC_CHANNELS} from '../shared/desktop-api.js';

const api: DesktopApi = Object.freeze({
  platform: process.platform,
  selectAssetPack: () => ipcRenderer.invoke(IPC_CHANNELS.selectAssetPack),
  inspectAssetPack: (handle: string) => ipcRenderer.invoke(IPC_CHANNELS.inspectAssetPack, handle),
  importAssetPack: (handle: string) => ipcRenderer.invoke(IPC_CHANNELS.importAssetPack, handle),
  listRecentProjects: () => ipcRenderer.invoke(IPC_CHANNELS.listRecentProjects),
  openProject: (projectId: string) => ipcRenderer.invoke(IPC_CHANNELS.openProject, projectId),
  deleteProject: (projectId: string) => ipcRenderer.invoke(IPC_CHANNELS.deleteProject, projectId),
  exportProject: (projectId: string) => ipcRenderer.invoke(IPC_CHANNELS.exportProject, projectId),
  cancelExport: (projectId: string) => ipcRenderer.invoke(IPC_CHANNELS.cancelExport, projectId),
  onExportProgress: (listener: (progress: ExportProgress) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: ExportProgress) => listener(progress);
    ipcRenderer.on(IPC_CHANNELS.exportProgress, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.exportProgress, handler);
  },
  revealOutput: (projectId: string) => ipcRenderer.invoke(IPC_CHANNELS.revealOutput, projectId),
  getProductionSnapshot: (projectId: string) => ipcRenderer.invoke(IPC_CHANNELS.getProductionSnapshot, projectId),
  detectProductionProvider: (projectId: string) => ipcRenderer.invoke(IPC_CHANNELS.detectProductionProvider, projectId),
  synthesizeProductionNarration: (projectId: string) => ipcRenderer.invoke(IPC_CHANNELS.synthesizeProductionNarration, projectId),
  cancelProductionNarration: (projectId: string) => ipcRenderer.invoke(IPC_CHANNELS.cancelProductionNarration, projectId),
  generateProductionShot: (request: GenerateProductionShotRequest) => ipcRenderer.invoke(IPC_CHANNELS.generateProductionShot, request),
  cancelProductionShot: (projectId: string, shotId: string) => ipcRenderer.invoke(IPC_CHANNELS.cancelProductionShot, projectId, shotId),
  selectProductionCandidate: (projectId: string, shotId: string, candidateId: string) => ipcRenderer.invoke(IPC_CHANNELS.selectProductionCandidate, projectId, shotId, candidateId),
  rejectProductionCandidate: (projectId: string, shotId: string, candidateId: string) => ipcRenderer.invoke(IPC_CHANNELS.rejectProductionCandidate, projectId, shotId, candidateId),
  onProductionProgress: (listener: (progress: ProductionProgress) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: ProductionProgress) => listener(progress);
    ipcRenderer.on(IPC_CHANNELS.productionProgress, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.productionProgress, handler);
  },
});

contextBridge.exposeInMainWorld('genVideoDesktop', api);

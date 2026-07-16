import {contextBridge, ipcRenderer} from 'electron';
import type {CreateProjectRequest, DesktopApi, ExportProgress, MeshPreviewRequest} from '../shared/desktop-api.js';
import type {ProjectDocument, Rig} from '@gen-video-tool/schema';
import {IPC_CHANNELS} from '../shared/desktop-api.js';

const api: DesktopApi = Object.freeze({
  platform: process.platform,
  selectAssetPack: () => ipcRenderer.invoke(IPC_CHANNELS.selectAssetPack),
  inspectAssetPack: (handle: string) => ipcRenderer.invoke(IPC_CHANNELS.inspectAssetPack, handle),
  importAssetPack: (handle: string) => ipcRenderer.invoke(IPC_CHANNELS.importAssetPack, handle),
  listRecentProjects: () => ipcRenderer.invoke(IPC_CHANNELS.listRecentProjects),
  openProject: (projectId: string) => ipcRenderer.invoke(IPC_CHANNELS.openProject, projectId),
  createProject: (request: CreateProjectRequest) => ipcRenderer.invoke(IPC_CHANNELS.createProject, request),
  deleteProject: (projectId: string) => ipcRenderer.invoke(IPC_CHANNELS.deleteProject, projectId),
  saveProject: (projectId: string, project: ProjectDocument) => ipcRenderer.invoke(IPC_CHANNELS.saveProject, projectId, project),
  exportProject: (projectId: string) => ipcRenderer.invoke(IPC_CHANNELS.exportProject, projectId),
  cancelExport: (projectId: string) => ipcRenderer.invoke(IPC_CHANNELS.cancelExport, projectId),
  onExportProgress: (listener: (progress: ExportProgress) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: ExportProgress) => listener(progress);
    ipcRenderer.on(IPC_CHANNELS.exportProgress, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.exportProgress, handler);
  },
  revealOutput: (projectId: string) => ipcRenderer.invoke(IPC_CHANNELS.revealOutput, projectId),
  loadMeshRig: (projectId: string, shotId: string, actorId: string) => ipcRenderer.invoke(IPC_CHANNELS.loadMeshRig, projectId, shotId, actorId),
  renderMeshPreview: (request: MeshPreviewRequest) => ipcRenderer.invoke(IPC_CHANNELS.renderMeshPreview, request),
  autoRigMesh: (projectId: string, shotId: string, actorId: string) => ipcRenderer.invoke(IPC_CHANNELS.autoRigMesh, projectId, shotId, actorId),
  saveMeshRig: (projectId: string, shotId: string, actorId: string, rig: Rig) => ipcRenderer.invoke(IPC_CHANNELS.saveMeshRig, projectId, shotId, actorId, rig),
  listTemplates: () => ipcRenderer.invoke(IPC_CHANNELS.listTemplates),
  installTemplate: (templateId: string) => ipcRenderer.invoke(IPC_CHANNELS.installTemplate, templateId),
});

contextBridge.exposeInMainWorld('genVideoDesktop', api);

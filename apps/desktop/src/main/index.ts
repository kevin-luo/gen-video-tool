import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {app, BrowserWindow, dialog, ipcMain, net, protocol, shell} from 'electron';
import {
  importAssetPack,
  inspectAssetPack,
  loadProjectDirectory,
  projectDurationSeconds,
  saveProjectDirectory,
  type AssetPackSource,
} from '@gen-video-tool/asset-pack';
import {parseProjectDocument, type ProjectDocument} from '@gen-video-tool/schema';
import {makeCancelSignal} from '@remotion/renderer';
import {renderProjectDirectory} from '@gen-video-tool/render-service';
import type {
  AssetPackSelection,
  CreateProjectRequest,
  ExportProjectResult,
  ProjectImportResponse,
  ProjectPayload,
  RecentProject,
} from '../shared/desktop-api.js';
import {IPC_CHANNELS} from '../shared/desktop-api.js';

protocol.registerSchemesAsPrivileged([
  {scheme: 'gen-video-asset', privileges: {standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true}},
]);

const preloadPath = fileURLToPath(new URL('../preload/index.mjs', import.meta.url));
const selectedSources = new Map<string, AssetPackSource>();
const projectRegistry = new Map<string, {root: string; readOnly: boolean}>();
const activeExports = new Map<string, {cancel: () => void}>();

const workspaceRoot = (): string => app.isPackaged ? app.getAppPath() : process.cwd();
const projectsRoot = (): string => path.join(app.getPath('userData'), 'projects');
const outputRoot = (projectId: string): string => path.join(app.getPath('userData'), 'output', projectId);

const isInside = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const refreshProjectRegistry = async (): Promise<void> => {
  projectRegistry.clear();
  const registerChildren = async (root: string, readOnly: boolean) => {
    try {
      for (const entry of await fs.readdir(root, {withFileTypes: true})) {
        if (!entry.isDirectory()) continue;
        const candidate = path.join(root, entry.name);
        try {
          const project = await loadProjectDirectory(candidate);
          projectRegistry.set(project.manifest.projectId, {root: candidate, readOnly});
        } catch {
          // Non-project directories are intentionally ignored.
        }
      }
    } catch {
      // First launch may not have either root yet.
    }
  };
  await registerChildren(path.join(workspaceRoot(), 'examples'), true);
  await fs.mkdir(projectsRoot(), {recursive: true});
  await registerChildren(projectsRoot(), false);
};

const projectPayload = async (projectId: string): Promise<ProjectPayload> => {
  const registration = projectRegistry.get(projectId);
  if (!registration) throw new Error('PROJECT_NOT_REGISTERED');
  return {
    project: await loadProjectDirectory(registration.root),
    assetBase: `gen-video-asset://${projectId}`,
    readOnly: registration.readOnly,
  };
};

const recentProject = async (projectId: string): Promise<RecentProject> => {
  const registration = projectRegistry.get(projectId);
  if (!registration) throw new Error('PROJECT_NOT_REGISTERED');
  const project = await loadProjectDirectory(registration.root);
  const stat = await fs.stat(path.join(registration.root, 'manifest.json'));
  return {
    id: projectId,
    name: project.manifest.title,
    updatedAt: stat.mtime.toISOString(),
    durationSeconds: projectDurationSeconds(project),
    shotCount: project.shots.length,
    aspectRatio: project.manifest.canvas.aspectRatio,
    status: 'ready',
    readOnly: registration.readOnly,
  };
};

const createWindow = (): void => {
  const window = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1180,
    minHeight: 760,
    show: false,
    backgroundColor: '#242528',
    title: 'Gen Video Tool',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  window.once('ready-to-show', () => window.show());
  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void window.loadFile(fileURLToPath(new URL('../renderer/index.html', import.meta.url)));
};

const selectionSource = (handle: unknown): AssetPackSource => {
  if (typeof handle !== 'string') throw new Error('ASSET_HANDLE_INVALID');
  const source = selectedSources.get(handle);
  if (!source) throw new Error('ASSET_HANDLE_EXPIRED');
  return source;
};

const registerIpc = (): void => {
  ipcMain.handle(IPC_CHANNELS.selectAssetPack, async (): Promise<AssetPackSelection | null> => {
    const sourceChoice = await dialog.showMessageBox({
      type: 'question', title: '导入资产包', message: '选择资产包来源',
      detail: '可以导入 ChatGPT 生成的 ZIP，或已经解压的项目目录。',
      buttons: ['选择 ZIP', '选择项目目录', '取消'], defaultId: 0, cancelId: 2, noLink: true,
    });
    if (sourceChoice.response === 2) return null;
    const selectDirectory = sourceChoice.response === 1;
    const result = await dialog.showOpenDialog({
      title: '导入资产包', buttonLabel: '检查资产包',
      properties: selectDirectory ? ['openDirectory'] : ['openFile'],
      ...(selectDirectory ? {} : {filters: [{name: 'ChatGPT 资产包', extensions: ['zip']}]}),
    });
    const selectedPath = result.filePaths[0];
    if (result.canceled || !selectedPath) return null;
    const source: AssetPackSource = {kind: selectDirectory ? 'directory' : 'zip', path: selectedPath};
    const handle = randomUUID();
    selectedSources.set(handle, source);
    return {handle, kind: source.kind, displayPath: selectedPath, name: path.basename(selectedPath)};
  });

  ipcMain.handle(IPC_CHANNELS.inspectAssetPack, async (_event, handle: unknown) =>
    inspectAssetPack({source: selectionSource(handle)}));

  ipcMain.handle(IPC_CHANNELS.importAssetPack, async (_event, handle: unknown): Promise<ProjectImportResponse> => {
    const source = selectionSource(handle);
    const result = await importAssetPack({source, projectsRoot: projectsRoot()});
    if (result.status !== 'committed' || !result.projectPath || !result.projectId) {
      return {inspection: {...result, status: 'rejected'}, project: null};
    }
    projectRegistry.set(result.projectId, {root: result.projectPath, readOnly: false});
    selectedSources.delete(String(handle));
    return {inspection: {...result, status: 'ready'}, project: await projectPayload(result.projectId)};
  });

  ipcMain.handle(IPC_CHANNELS.listRecentProjects, async (): Promise<RecentProject[]> => {
    await refreshProjectRegistry();
    const recent = await Promise.all([...projectRegistry.keys()].map(recentProject));
    return recent.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  });

  ipcMain.handle(IPC_CHANNELS.openProject, async (_event, projectId: unknown): Promise<ProjectPayload> => {
    if (typeof projectId !== 'string') throw new Error('PROJECT_ID_INVALID');
    if (!projectRegistry.has(projectId)) await refreshProjectRegistry();
    return projectPayload(projectId);
  });

  ipcMain.handle(IPC_CHANNELS.createProject, async (_event, request: CreateProjectRequest): Promise<RecentProject> => {
    if (!request.name.trim() || !['9:16', '16:9', '1:1'].includes(request.aspectRatio)) throw new Error('PROJECT_REQUEST_INVALID');
    const projectId = `project-${Date.now()}`;
    const canvas = request.aspectRatio === '16:9'
      ? {width: 1920, height: 1080, aspectRatio: '16:9' as const}
      : request.aspectRatio === '1:1'
        ? {width: 1080, height: 1080, aspectRatio: '1:1' as const}
        : {width: 1080, height: 1920, aspectRatio: '9:16' as const};
    const project: ProjectDocument = parseProjectDocument({
      schemaVersion: 2,
      manifest: {
        schemaVersion: 2, projectId, title: request.name.trim(), locale: 'zh-CN', canvas, fps: 30,
        shots: [{id: 'shot-01', path: 'shots/shot-01/shot.json'}],
      },
      shots: [{
        schemaVersion: 2, id: 'shot-01', name: '开场', durationFrames: 90,
        recipeId: 'hero-assemble', energy: 'balanced', camera: {kind: 'locked', strength: 0.35},
        layers: [{id: 'title', role: 'title', text: request.name.trim(), depth: 0, visible: true}],
        actors: [], motionEvents: [], transition: {type: 'hard-cut', durationFrames: 0},
        title: {text: request.name.trim(), language: 'zh-CN', maxLines: 3, safeArea: 0.08, paperBackground: true, rotation: 0},
      }],
    });
    const root = path.join(projectsRoot(), projectId);
    await fs.mkdir(root, {recursive: false});
    await saveProjectDirectory(root, project);
    projectRegistry.set(projectId, {root, readOnly: false});
    return recentProject(projectId);
  });

  ipcMain.handle(IPC_CHANNELS.deleteProject, async (_event, projectId: unknown): Promise<void> => {
    if (typeof projectId !== 'string') throw new Error('PROJECT_ID_INVALID');
    const registration = projectRegistry.get(projectId);
    if (!registration) throw new Error('PROJECT_NOT_REGISTERED');
    if (registration.readOnly) throw new Error('PROJECT_READ_ONLY');
    const root = path.resolve(projectsRoot());
    const target = path.resolve(registration.root);
    if (target === root || !isInside(root, target)) throw new Error('PROJECT_DELETE_OUTSIDE_ROOT');
    await fs.rm(target, {recursive: true, force: false});
    projectRegistry.delete(projectId);
  });

  ipcMain.handle(IPC_CHANNELS.saveProject, async (_event, projectId: unknown, value: unknown): Promise<ProjectPayload> => {
    if (typeof projectId !== 'string') throw new Error('PROJECT_ID_INVALID');
    const registration = projectRegistry.get(projectId);
    if (!registration) throw new Error('PROJECT_NOT_REGISTERED');
    if (registration.readOnly) throw new Error('PROJECT_READ_ONLY');
    const project = parseProjectDocument(value);
    if (project.manifest.projectId !== projectId) throw new Error('PROJECT_ID_MISMATCH');
    await saveProjectDirectory(registration.root, project);
    return projectPayload(projectId);
  });

  ipcMain.handle(IPC_CHANNELS.exportProject, async (event, projectId: unknown): Promise<ExportProjectResult> => {
    if (typeof projectId !== 'string') throw new Error('PROJECT_ID_INVALID');
    const registration = projectRegistry.get(projectId);
    if (!registration) throw new Error('PROJECT_NOT_REGISTERED');
    if (activeExports.has(projectId)) throw new Error('EXPORT_ALREADY_RUNNING');
    const cancellation = makeCancelSignal();
    activeExports.set(projectId, {cancel: cancellation.cancel});
    try {
      const result = await renderProjectDirectory({
        projectRoot: registration.root,
        outputRoot: outputRoot(projectId),
        workspaceRoot: workspaceRoot(),
        cancelSignal: cancellation.cancelSignal,
        onProgress: (phase, progress) => event.sender.send(IPC_CHANNELS.exportProgress, {projectId, phase, progress}),
      });
      return {
        videoName: path.basename(result.videoPath),
        subtitlesName: result.subtitlesPath ? path.basename(result.subtitlesPath) : null,
        qaFrameCount: result.qaFramePaths.length,
        durationSeconds: result.durationSeconds,
      };
    } finally {
      activeExports.delete(projectId);
    }
  });

  ipcMain.handle(IPC_CHANNELS.cancelExport, async (_event, projectId: unknown): Promise<void> => {
    if (typeof projectId !== 'string') throw new Error('PROJECT_ID_INVALID');
    activeExports.get(projectId)?.cancel();
  });

  ipcMain.handle(IPC_CHANNELS.revealOutput, async (_event, projectId: unknown): Promise<void> => {
    if (typeof projectId !== 'string' || !projectRegistry.has(projectId)) throw new Error('PROJECT_ID_INVALID');
    await fs.mkdir(outputRoot(projectId), {recursive: true});
    await shell.openPath(outputRoot(projectId));
  });
};

app.whenReady().then(async () => {
  await refreshProjectRegistry();
  protocol.handle('gen-video-asset', async (request) => {
    const url = new URL(request.url);
    const projectId = url.hostname;
    const registration = projectRegistry.get(projectId);
    if (!registration) return new Response('Project not found', {status: 404});
    let relativePath = '';
    try { relativePath = decodeURIComponent(url.pathname.slice(1)); } catch { return new Response('Invalid path', {status: 400}); }
    if (!relativePath || relativePath.includes('\\') || relativePath.split('/').some((segment) => segment === '..' || segment === '')) {
      return new Response('Invalid path', {status: 400});
    }
    const target = path.resolve(registration.root, ...relativePath.split('/'));
    if (!isInside(registration.root, target)) return new Response('Forbidden', {status: 403});
    return net.fetch(pathToFileURL(target).toString());
  });
  registerIpc();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

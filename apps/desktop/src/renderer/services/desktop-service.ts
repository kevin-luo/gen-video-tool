import type {AssetPackSelection, CreateProjectRequest, DesktopApi, RecentProject} from '../../shared/desktop-api';
import {demoPayload} from '../data/demo';

const fallbackProjects: RecentProject[] = [{
  id: 'football-history',
  name: demoPayload.project.manifest.title,
  updatedAt: new Date().toISOString(),
  durationSeconds: demoPayload.project.shots.reduce((sum, shot) => sum + shot.durationFrames, 0) / demoPayload.project.manifest.fps,
  shotCount: demoPayload.project.shots.length,
  aspectRatio: '9:16',
  status: 'ready',
  readOnly: true,
}];

const browserFallback: DesktopApi = {
  platform: 'win32',
  selectAssetPack: async (): Promise<AssetPackSelection> => ({
    handle: 'browser-demo', kind: 'directory', displayPath: 'examples/football-history', name: 'football-history',
  }),
  inspectAssetPack: async () => ({
    status: 'ready', diagnostics: [], projectId: 'football-history', title: demoPayload.project.manifest.title,
    sourceKind: 'directory', fileCount: 23, totalBytes: 18_000_000, shotCount: 7,
    videoDurationSeconds: 25.9, audioDurationSeconds: 25.8,
  }),
  importAssetPack: async () => ({
    inspection: {
      status: 'ready', diagnostics: [], projectId: 'football-history', title: demoPayload.project.manifest.title,
      sourceKind: 'directory', fileCount: 23, totalBytes: 18_000_000, shotCount: 7,
      videoDurationSeconds: 25.9, audioDurationSeconds: 25.8,
    },
    project: demoPayload,
  }),
  listRecentProjects: async () => fallbackProjects,
  openProject: async () => demoPayload,
  createProject: async (request: CreateProjectRequest) => ({
    id: 'football-history', name: request.name, updatedAt: new Date().toISOString(), durationSeconds: 0,
    shotCount: 1, aspectRatio: request.aspectRatio, status: 'draft', readOnly: true,
  }),
  deleteProject: async () => undefined,
  saveProject: async (_projectId, project) => ({project, assetBase: demoPayload.assetBase, readOnly: true}),
  exportProject: async () => ({videoName: 'final.mp4', subtitlesName: 'subtitles.srt', qaFrameCount: 3, durationSeconds: 25.9}),
  cancelExport: async () => undefined,
  onExportProgress: () => () => undefined,
  revealOutput: async () => undefined,
};

export const desktopService: DesktopApi = window.genVideoDesktop ?? browserFallback;

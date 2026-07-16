import type {AssetPackInspection} from '@gen-video-tool/asset-pack';
import type {MeshActionTemplate, ProjectDocument, Rig} from '@gen-video-tool/schema';

export interface AssetPackSelection {
  handle: string;
  kind: 'zip' | 'directory';
  displayPath: string;
  name: string;
}

export interface RecentProject {
  id: string;
  name: string;
  updatedAt: string;
  durationSeconds: number;
  shotCount: number;
  aspectRatio: '9:16' | '16:9' | '1:1' | '4:5';
  status: 'ready' | 'draft' | 'needs-attention';
  readOnly?: boolean;
}

export interface CreateProjectRequest {
  name: string;
  aspectRatio: '9:16' | '16:9' | '1:1';
}

export interface ProjectPayload {
  project: ProjectDocument;
  assetBase: string;
  readOnly: boolean;
}

export interface ProjectImportResponse {
  inspection: AssetPackInspection;
  project: ProjectPayload | null;
}

export interface ExportProjectResult {
  videoName: string;
  subtitlesName: string | null;
  qaFrameCount: number;
  durationSeconds: number;
}

export interface ExportProgress {
  projectId: string;
  phase: 'preparing' | 'rendering' | 'checking' | 'done';
  progress: number;
}

export interface MeshRigPayload {
  projectId: string;
  shotId: string;
  actorId: string;
  rig: Rig;
  textureUrl: string;
  readOnly: boolean;
}

export interface MeshPreviewRequest {
  projectId: string;
  shotId: string;
  actorId: string;
  action: MeshActionTemplate;
  amplitude: number;
  rig?: Rig;
}

export interface MeshPreviewResult {
  requestId: string;
  videoUrl: string;
  frameCount: number;
  fps: number;
  durationSeconds: number;
  warnings: string[];
}

export interface TemplateMarketEntry {
  id: string;
  name: string;
  version: string;
  category: 'sports' | 'story' | 'explainer' | 'commerce';
  summary: string;
  actions: string[];
  recipes: string[];
  installed: boolean;
}

export interface DesktopApi {
  platform: string;
  selectAssetPack: () => Promise<AssetPackSelection | null>;
  inspectAssetPack: (handle: string) => Promise<AssetPackInspection>;
  importAssetPack: (handle: string) => Promise<ProjectImportResponse>;
  listRecentProjects: () => Promise<RecentProject[]>;
  openProject: (projectId: string) => Promise<ProjectPayload>;
  createProject: (request: CreateProjectRequest) => Promise<RecentProject>;
  deleteProject: (projectId: string) => Promise<void>;
  saveProject: (projectId: string, project: ProjectDocument) => Promise<ProjectPayload>;
  exportProject: (projectId: string) => Promise<ExportProjectResult>;
  cancelExport: (projectId: string) => Promise<void>;
  onExportProgress: (listener: (progress: ExportProgress) => void) => () => void;
  revealOutput: (projectId: string) => Promise<void>;
  loadMeshRig: (projectId: string, shotId: string, actorId: string) => Promise<MeshRigPayload>;
  renderMeshPreview: (request: MeshPreviewRequest) => Promise<MeshPreviewResult>;
  autoRigMesh: (projectId: string, shotId: string, actorId: string) => Promise<MeshRigPayload>;
  saveMeshRig: (projectId: string, shotId: string, actorId: string, rig: Rig) => Promise<MeshRigPayload>;
  listTemplates: () => Promise<TemplateMarketEntry[]>;
  installTemplate: (templateId: string) => Promise<TemplateMarketEntry[]>;
}

export const IPC_CHANNELS = {
  selectAssetPack: 'asset-pack:select',
  inspectAssetPack: 'asset-pack:inspect',
  importAssetPack: 'asset-pack:import',
  listRecentProjects: 'projects:list-recent',
  openProject: 'projects:open',
  createProject: 'projects:create',
  deleteProject: 'projects:delete',
  saveProject: 'projects:save',
  exportProject: 'projects:export',
  exportProgress: 'projects:export-progress',
  cancelExport: 'projects:cancel-export',
  revealOutput: 'projects:reveal-output',
  loadMeshRig: 'motion:load-rig',
  renderMeshPreview: 'motion:render-preview',
  autoRigMesh: 'motion:auto-rig',
  saveMeshRig: 'motion:save-rig',
  listTemplates: 'templates:list',
  installTemplate: 'templates:install',
} as const;

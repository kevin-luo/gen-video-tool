import type {AssetPackInspection} from '@gen-video-tool/asset-pack';
import type {ProductionRenderData} from '@gen-video-tool/remotion-engine';
import type {ProductionPlan, ProductionState} from '@gen-video-tool/video-generation';

export interface AssetPackSelection {
  handle: string;
  kind: 'zip' | 'directory';
  displayPath: string;
  name: string;
}

export interface RecentProject {
  id: string;
  name: string;
  locale: string;
  updatedAt: string;
  durationSeconds: number;
  shotCount: number;
  aspectRatio: '9:16' | '16:9' | '1:1' | '4:5';
  status: 'ready' | 'draft' | 'needs-attention';
  readOnly?: boolean;
}

export interface ProjectPayload {
  plan: ProductionPlan;
  state: ProductionState;
  /** Present only when every generated shot has an accepted, QA-passed candidate. */
  renderData?: ProductionRenderData;
  /** Explicit reason the full v3 preview is gated; never a silent static fallback. */
  renderGate?: {code: string; message: string};
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

export type ProductionCandidateStatus =
  | 'planned'
  | 'queued'
  | 'preparing'
  | 'running'
  | 'downloading'
  | 'complete'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export type ProductionHumanDecision = 'pending' | 'selected' | 'rejected';

export interface ProductionCandidateSnapshot {
  candidateId: string;
  shotId: string;
  seed: number;
  status: ProductionCandidateStatus;
  progress: number;
  providerJobId?: string;
  videoUrl?: string;
  relativePath?: string;
  sha256?: string;
  technicalQa?: {
    status: 'passed' | 'failed';
    checkedAt: string;
    issues: string[];
  };
  humanDecision: ProductionHumanDecision;
  error?: {code: string; message: string};
}

export interface ProductionShotSnapshot {
  shotId: string;
  kind: 'layered-collage' | 'generated-performance';
  status:
    | 'not-required'
    | 'ready-to-generate'
    | 'generating'
    | 'awaiting-selection'
    | 'selected'
    | 'failed'
    | 'interrupted';
  selectedCandidateId?: string;
  candidates: ProductionCandidateSnapshot[];
}

export interface ProductionProviderSnapshot {
  id: 'wangp';
  localOnly: true;
  available: boolean;
  checking: boolean;
  transport: 'stdio' | 'streamable-http';
  endpoint?: string;
  version?: string;
  reason?: string;
  root?: string;
  pythonExecutable?: string;
  presets: Array<{
    id: string;
    label: string;
    qualityTier: 'preview' | 'quality';
    width: number;
    height: number;
    fps: number;
    frameCount: number;
  }>;
}

export interface ProductionNarrationSnapshot {
  status: 'queued' | 'generating' | 'complete' | 'failed' | 'interrupted';
  engine: 'f5-tts-local';
  segmentCount: number;
  mergedAudioPath?: string;
  audioUrl?: string;
  durationSeconds?: number;
  speechDurationSeconds?: number;
  tailPaddingSeconds?: number;
  sha256?: string;
  segments: Array<{
    segmentId: string;
    startSeconds: number;
    endSeconds: number;
    durationSeconds: number;
  }>;
  error?: string;
}

export interface ProductionSnapshot {
  projectId: string;
  hasPlan: boolean;
  readOnly: boolean;
  networkPolicy?: 'offline-only';
  provider?: ProductionProviderSnapshot;
  narration?: ProductionNarrationSnapshot;
  shots: ProductionShotSnapshot[];
  updatedAt?: string;
  error?: {code: string; message: string};
}

export interface GenerateProductionShotRequest {
  projectId: string;
  shotId: string;
}

export interface ProductionProgress {
  projectId: string;
  shotId: string;
  candidateId?: string;
  snapshot: ProductionSnapshot;
}

export interface DesktopApi {
  platform: string;
  selectAssetPack: () => Promise<AssetPackSelection | null>;
  inspectAssetPack: (handle: string) => Promise<AssetPackInspection>;
  importAssetPack: (handle: string) => Promise<ProjectImportResponse>;
  listRecentProjects: () => Promise<RecentProject[]>;
  openProject: (projectId: string) => Promise<ProjectPayload>;
  deleteProject: (projectId: string) => Promise<void>;
  exportProject: (projectId: string) => Promise<ExportProjectResult>;
  cancelExport: (projectId: string) => Promise<void>;
  onExportProgress: (listener: (progress: ExportProgress) => void) => () => void;
  revealOutput: (projectId: string) => Promise<void>;
  getProductionSnapshot: (projectId: string) => Promise<ProductionSnapshot>;
  detectProductionProvider: (projectId: string) => Promise<ProductionSnapshot>;
  synthesizeProductionNarration: (projectId: string) => Promise<ProductionSnapshot>;
  cancelProductionNarration: (projectId: string) => Promise<ProductionSnapshot>;
  generateProductionShot: (request: GenerateProductionShotRequest) => Promise<ProductionSnapshot>;
  cancelProductionShot: (projectId: string, shotId: string) => Promise<ProductionSnapshot>;
  selectProductionCandidate: (projectId: string, shotId: string, candidateId: string) => Promise<ProductionSnapshot>;
  rejectProductionCandidate: (projectId: string, shotId: string, candidateId: string) => Promise<ProductionSnapshot>;
  onProductionProgress: (listener: (progress: ProductionProgress) => void) => () => void;
}

export const IPC_CHANNELS = {
  selectAssetPack: 'asset-pack:select',
  inspectAssetPack: 'asset-pack:inspect',
  importAssetPack: 'asset-pack:import',
  listRecentProjects: 'projects:list-recent',
  openProject: 'projects:open',
  deleteProject: 'projects:delete',
  exportProject: 'projects:export',
  exportProgress: 'projects:export-progress',
  cancelExport: 'projects:cancel-export',
  revealOutput: 'projects:reveal-output',
  getProductionSnapshot: 'production:snapshot',
  detectProductionProvider: 'production:detect-provider',
  synthesizeProductionNarration: 'production:synthesize-narration',
  cancelProductionNarration: 'production:cancel-narration',
  generateProductionShot: 'production:generate-shot',
  cancelProductionShot: 'production:cancel-shot',
  selectProductionCandidate: 'production:select-candidate',
  rejectProductionCandidate: 'production:reject-candidate',
  productionProgress: 'production:progress',
} as const;

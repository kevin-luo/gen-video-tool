import type {ProductionRenderData} from '@gen-video-tool/remotion-engine';
import type {
  EditorialCamera,
  ProductionPlan,
  ProductionShot,
  ProductionShotState,
  ProductionState,
} from '@gen-video-tool/video-generation';

export type AppScreen = 'home' | 'import' | 'editor';

export interface ShotModel {
  id: string;
  index: number;
  title: string;
  narration: string;
  kind: ProductionShot['kind'];
  startFrame: number;
  durationFrames: number;
  durationSeconds: number;
  camera: EditorialCamera;
  previewAssetPath: string;
  plan: ProductionShot;
  state: ProductionShotState;
}

/**
 * Renderer-facing project state. The immutable plan and mutable production
 * state are both v3 contracts; no schema-v2 document is synthesized.
 */
export interface ProjectModel {
  id: string;
  name: string;
  aspectRatio: '9:16';
  plan: ProductionPlan;
  state: ProductionState;
  renderData?: ProductionRenderData;
  renderGate?: {code: string; message: string};
  shots: ShotModel[];
  assetBase: string;
  readOnly: boolean;
}

export interface ValidationCheck {
  id: string;
  label: string;
  detail: string;
  status: 'pass' | 'warning' | 'error';
  count?: number;
}

export interface ValidationReport {
  packName: string;
  path: string;
  projectName: string;
  manifestVersion: string;
  shots: number;
  files: number;
  checks: ValidationCheck[];
}

export type ExportState = 'idle' | 'preparing' | 'rendering' | 'checking' | 'done' | 'error';

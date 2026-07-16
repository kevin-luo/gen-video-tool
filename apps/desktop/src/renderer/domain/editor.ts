export type AppScreen = 'home' | 'import' | 'editor';
export type ActorMode = 'rigid' | 'mesh' | 'pose-cut';
export type MotionRecipe =
  | 'hero-assemble'
  | 'editorial-pan'
  | 'number-impact'
  | 'paper-stack'
  | 'timeline-travel'
  | 'comparison-split'
  | 'quiet-story'
  | 'detail-reveal';
import type {ProjectDocument} from '@gen-video-tool/schema';

export type Energy = 'quiet' | 'balanced' | 'punchy';
export type CameraMove = 'static' | 'push-in' | 'follow' | 'handheld' | 'orbit';
export type Transition = 'torn-paper' | 'newspaper-slide' | 'flash-frame' | 'foreground-wipe' | 'hard-cut';

export interface LayerModel {
  id: string;
  name: string;
  role: 'background' | 'subject' | 'prop' | 'foreground' | 'title' | 'overlay';
  x: number;
  y: number;
  scale: number;
  rotation: number;
  depth: number;
  visible: boolean;
}

export interface ActorConfig {
  id: string;
  mode: ActorMode;
  availableModes: ActorMode[];
  action: string;
  actionStrength: number;
  sourcePath?: string;
  rigPath?: string;
  poseA: string;
  poseB: string;
  switchCover: 'foreground' | 'paper-tear' | 'flash-frame' | 'hard-cut';
}

export interface ShotModel {
  id: string;
  index: number;
  title: string;
  note: string;
  year: string;
  duration: number;
  recipe: MotionRecipe;
  energy: Energy;
  camera: CameraMove;
  transition: Transition;
  selectedLayerId: string;
  layers: LayerModel[];
  actor: ActorConfig;
  palette: 'sand' | 'ink' | 'rust' | 'olive';
}

export interface ProjectModel {
  id: string;
  name: string;
  aspectRatio: '9:16' | '16:9' | '1:1' | '4:5';
  shots: ShotModel[];
  document: ProjectDocument;
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

export type AutosaveState = 'saved' | 'saving' | 'unsaved' | 'error';
export type ExportState = 'idle' | 'preparing' | 'rendering' | 'checking' | 'done' | 'error';

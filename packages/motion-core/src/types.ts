import type {
  AspectRatio,
  Energy,
  LayerRole,
  MotionRecipeId,
  PaperAnimation,
} from '@gen-video-tool/schema';

export type CameraKind =
  | 'locked'
  | 'push'
  | 'pull'
  | 'pan-left'
  | 'pan-right'
  | 'pan-up'
  | 'pan-down';

export interface CameraDirective {
  kind: CameraKind;
  /** Normalized travel in canvas units. Fixed by the recipe, never generated. */
  x: number;
  y: number;
  scaleFrom: number;
  scaleTo: number;
}

export interface EntranceDirective {
  role: LayerRole;
  animation: PaperAnimation;
  /** Fraction of shot duration. */
  start: number;
  /** Fraction of shot duration. */
  duration: number;
}

export interface EmphasisDirective {
  role: LayerRole;
  animation: PaperAnimation;
  at: number;
  durationFrames: number;
}

export interface TransitionDirective {
  animation: PaperAnimation | 'hardCut';
  durationFrames: number;
}

export interface AspectAdaptation {
  cameraXMultiplier: number;
  cameraYMultiplier: number;
  entranceDelayMultiplier: number;
}

export interface MotionRecipe {
  id: MotionRecipeId;
  label: string;
  description: string;
  defaultDurationFrames: number;
  energy: Energy;
  camera: CameraDirective;
  entrances: readonly EntranceDirective[];
  emphasis: EmphasisDirective;
  transition: TransitionDirective;
  parallax: Readonly<Record<LayerRole, number>>;
  aspectAdaptation: Readonly<Record<AspectRatio, AspectAdaptation>>;
}

export type CompiledEventKind = 'entrance' | 'emphasis' | 'transition' | 'idle';

export interface CompiledMotionEvent {
  id: string;
  kind: CompiledEventKind;
  targetRole: LayerRole | 'shot';
  animation: PaperAnimation | 'hardCut' | 'microDrift';
  startFrame: number;
  durationFrames: number;
}

export interface CompiledMotionPlan {
  recipeId: MotionRecipeId;
  durationFrames: number;
  fps: number;
  aspectRatio: AspectRatio;
  energy: Energy;
  camera: CameraDirective;
  parallax: Readonly<Record<LayerRole, number>>;
  events: readonly CompiledMotionEvent[];
}

export interface CompileRecipeOptions {
  recipeId: MotionRecipeId;
  durationFrames?: number;
  fps?: number;
  aspectRatio?: AspectRatio;
  energy?: Energy;
  /** Idle is deliberately opt-in. */
  enableIdle?: boolean;
}

export interface ParallaxLayer {
  id: string;
  role: LayerRole;
  /** 0 is far, 1 is closest. */
  depth: number;
}

export interface CameraSample {
  x: number;
  y: number;
  scale: number;
}

export interface LayerParallaxSample extends CameraSample {
  layerId: string;
}

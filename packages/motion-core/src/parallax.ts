import type {LayerRole} from '@gen-video-tool/schema';
import type {
  CameraDirective,
  CameraSample,
  CompiledMotionPlan,
  LayerParallaxSample,
  ParallaxLayer,
} from './types';

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
const round = (value: number): number => {
  const rounded = Math.round(value * 1_000_000) / 1_000_000;
  return Object.is(rounded, -0) ? 0 : rounded;
};
const easeInOut = (value: number): number => {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
};

export const sampleCamera = (
  camera: CameraDirective,
  frame: number,
  durationFrames: number,
): CameraSample => {
  const progress = durationFrames <= 1 ? 1 : easeInOut(frame / (durationFrames - 1));
  return {
    x: round(camera.x * progress),
    y: round(camera.y * progress),
    scale: round(camera.scaleFrom + (camera.scaleTo - camera.scaleFrom) * progress),
  };
};

const depthMultiplier = (role: LayerRole, depth: number, roleMultiplier: number): number => {
  // Text is kept almost screen-locked regardless of author-supplied depth.
  if (role === 'title') return Math.min(roleMultiplier, 0.05);
  if (role === 'overlay') return Math.min(roleMultiplier, 0.1);
  return roleMultiplier * (0.45 + clamp01(depth) * 0.55);
};

/** Applies camera travel independently to one layer. */
export const applyLayerParallax = (
  camera: CameraSample,
  layer: ParallaxLayer,
  multipliers: Readonly<Record<LayerRole, number>>,
): LayerParallaxSample => {
  const multiplier = depthMultiplier(layer.role, layer.depth, multipliers[layer.role]);
  return {
    layerId: layer.id,
    x: round(camera.x * multiplier),
    y: round(camera.y * multiplier),
    scale: round(1 + (camera.scale - 1) * multiplier),
  };
};

/**
 * Samples every layer separately. No shared CameraRig transform is returned,
 * so background, subject, foreground, and title cannot accidentally move as
 * one flat poster.
 */
export const sampleParallaxFrame = (
  plan: CompiledMotionPlan,
  frame: number,
  layers: readonly ParallaxLayer[],
): readonly LayerParallaxSample[] => {
  const camera = sampleCamera(plan.camera, frame, plan.durationFrames);
  return layers.map((layer) => applyLayerParallax(camera, layer, plan.parallax));
};

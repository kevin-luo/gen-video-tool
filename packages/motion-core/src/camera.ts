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
  x: number;
  y: number;
  scaleFrom: number;
  scaleTo: number;
}

export interface CameraSample {
  x: number;
  y: number;
  scale: number;
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
const round = (value: number): number => {
  const rounded = Math.round(value * 1_000_000) / 1_000_000;
  return Object.is(rounded, -0) ? 0 : rounded;
};
const easeInOut = (value: number): number => {
  const progress = clamp01(value);
  return progress * progress * (3 - 2 * progress);
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

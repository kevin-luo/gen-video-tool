export type PaperAssemblyKind =
  | 'slide-left'
  | 'slide-right'
  | 'slide-up'
  | 'drop'
  | 'rise'
  | 'snap'
  | 'slap'
  | 'stamp'
  | 'pop';

export type PaperFollowThroughKind =
  | 'bob'
  | 'sway'
  | 'gesture-left'
  | 'gesture-right'
  | 'exit-left'
  | 'exit-right';

/**
 * A finite rigid-paper action after the entrance has settled. Unlike the
 * legacy looping presets this cue always reaches a deterministic hold. Bob,
 * sway and gesture return to the authored pose; exits hold invisibly offstage.
 */
export type PaperFollowThroughCue = {
  kind: PaperFollowThroughKind;
  /** Still frames between the entrance settle and this action. */
  delayFrames?: number;
  durationFrames: number;
  /** Small action travel, or the full offstage travel for an exit. */
  distance?: number;
  /** Peak whole-card rotation. No mesh or non-uniform deformation is used. */
  rotationDegrees?: number;
  /** Stop-motion placement cadence on the fixed 30fps delivery timeline. */
  cadenceFps?: 2 | 3 | 4;
};

export type PaperAssemblyCue = {
  kind: PaperAssemblyKind;
  /** Shot-local frame at which this paper group first enters. */
  startFrame: number;
  /** Arrival plus settle time, measured in shot-local delivery frames. */
  durationFrames: number;
  /** Off-canvas travel in delivery pixels for directional entrances. */
  distance?: number;
  /** Initial rigid-paper rotation which settles back to the authored pose. */
  rotationDegrees?: number;
  /** Number of discrete stop-motion placements during the entrance. */
  steps?: number;
  /** Optional finite action after settle; never a perpetual idle loop. */
  followThrough?: PaperFollowThroughCue | undefined;
};

export type PaperAssemblySample = {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
};

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
const lerp = (from: number, to: number, progress: number): number => from + (to - from) * progress;
const round = (value: number): number => {
  const rounded = Math.round(value * 1_000_000) / 1_000_000;
  return Object.is(rounded, -0) ? 0 : rounded;
};

const steppedProgress = (raw: number, steps: number): number => {
  if (raw >= 1) return 1;
  return Math.floor(clamp01(raw) * steps) / steps;
};

const easeOutCubic = (value: number): number => 1 - Math.pow(1 - clamp01(value), 3);

const identitySample = (): PaperAssemblySample => ({
  x: 0,
  y: 0,
  scale: 1,
  rotation: 0,
  opacity: 1,
});

const piecewise = (
  progress: number,
  firstAt: number,
  start: number,
  middle: number,
  end: number,
): number => progress <= firstAt
  ? lerp(start, middle, progress / Math.max(0.0001, firstAt))
  : lerp(middle, end, (progress - firstAt) / Math.max(0.0001, 1 - firstAt));

/** A hand-placed card crosses the mark, corrects once, then seats exactly. */
const paperSettleTravel = (progress: number): number => {
  if (progress <= 0.68) return lerp(0, 1.08, progress / 0.68);
  if (progress <= 0.84) {
    return lerp(1.08, 0.975, easeOutCubic((progress - 0.68) / 0.16));
  }
  return lerp(0.975, 1, easeOutCubic((progress - 0.84) / 0.16));
};

const finalFollowThroughSample = (cue: PaperFollowThroughCue): PaperAssemblySample => {
  if (cue.kind !== 'exit-left' && cue.kind !== 'exit-right') return identitySample();
  const direction = cue.kind === 'exit-left' ? -1 : 1;
  return {
    x: round(direction * Math.max(0, cue.distance ?? 1_200)),
    y: 0,
    scale: 1,
    rotation: round(cue.rotationDegrees ?? 0),
    opacity: 0,
  };
};

const samplePaperFollowThrough = (
  cue: PaperFollowThroughCue,
  entranceEndFrame: number,
  frame: number,
): PaperAssemblySample => {
  const startFrame = entranceEndFrame + Math.max(0, Math.round(cue.delayFrames ?? 0));
  if (frame < startFrame) return identitySample();
  const durationFrames = Math.max(1, Math.round(cue.durationFrames));
  if (frame >= startFrame + durationFrames) return finalFollowThroughSample(cue);

  const cadenceFps = Math.max(2, Math.min(4, Math.round(cue.cadenceFps ?? 3)));
  const placementFrames = Math.max(1, Math.round(30 / cadenceFps));
  const localFrame = frame - startFrame;
  const quantizedFrame = Math.floor(localFrame / placementFrames) * placementFrames;
  const progress = clamp01(quantizedFrame / durationFrames);
  const envelope = Math.sin(Math.PI * progress);
  const signedWave = Math.sin(Math.PI * 2 * progress) * envelope;
  const requestedDistance = Math.max(0, cue.distance ?? 20);
  const distance = cue.kind.startsWith('exit-')
    ? requestedDistance
    : Math.min(120, requestedDistance);
  const rotation = Math.max(-15, Math.min(15, cue.rotationDegrees ?? 2.5));

  if (cue.kind === 'bob') {
    return {
      x: 0,
      y: round(-distance * envelope),
      scale: 1,
      rotation: round(rotation * signedWave),
      opacity: 1,
    };
  }

  if (cue.kind === 'sway') {
    return {
      x: round(distance * signedWave),
      y: round(-distance * 0.12 * envelope),
      scale: 1,
      rotation: round(rotation * signedWave),
      opacity: 1,
    };
  }

  if (cue.kind === 'gesture-left' || cue.kind === 'gesture-right') {
    const direction = cue.kind === 'gesture-left' ? -1 : 1;
    return {
      x: round(direction * distance * envelope),
      y: round(-distance * 0.15 * envelope),
      scale: 1,
      rotation: round(direction * rotation * envelope),
      opacity: 1,
    };
  }

  const direction = cue.kind === 'exit-left' ? -1 : 1;
  const travel = easeOutCubic(progress);
  return {
    x: round(direction * distance * travel),
    y: 0,
    scale: 1,
    rotation: round(rotation * travel),
    opacity: 1,
  };
};

/**
 * Samples one rigid paper group. It never warps or replaces pixels: the
 * authored PNG only translates, rotates and scales before locking exactly to
 * its final transform. Quantized placements create tactile stop-motion timing.
 */
export const samplePaperAssembly = (
  cue: PaperAssemblyCue,
  frame: number,
): PaperAssemblySample => {
  if (frame < cue.startFrame) return {x: 0, y: 0, scale: 1, rotation: 0, opacity: 0};
  const durationFrames = Math.max(1, cue.durationFrames);
  const raw = clamp01((frame - cue.startFrame) / durationFrames);
  if (raw >= 1) {
    return cue.followThrough === undefined
      ? identitySample()
      : samplePaperFollowThrough(cue.followThrough, cue.startFrame + durationFrames, frame);
  }

  const steps = Math.max(2, Math.min(24, Math.round(cue.steps ?? 10)));
  const progress = steppedProgress(raw, steps);
  const arrival = easeOutCubic(progress);
  const distance = Math.max(0, cue.distance ?? 1_200);
  const rotation = cue.rotationDegrees ?? 7;
  if (
    cue.kind === 'slide-left'
    || cue.kind === 'slide-right'
    || cue.kind === 'slide-up'
    || cue.kind === 'drop'
    || cue.kind === 'rise'
  ) {
    const travel = paperSettleTravel(progress);
    const remaining = 1 - travel;
    const arc = Math.min(42, distance * 0.035) * Math.sin(Math.PI * progress);
    const horizontalDirection = cue.kind === 'slide-left' ? -1 : cue.kind === 'slide-right' ? 1 : 0;
    const verticalDirection = cue.kind === 'rise' ? 1 : cue.kind === 'slide-up' || cue.kind === 'drop' ? -1 : 0;
    const offset = {
      x: horizontalDirection === 0
        ? Math.sign(rotation || 1) * arc * 0.6
        : horizontalDirection * distance * remaining,
      y: verticalDirection === 0 ? -arc : verticalDirection * distance * remaining,
    };
    return {
      x: round(offset.x),
      y: round(offset.y),
      scale: 1,
      rotation: round(rotation * remaining + rotation * 0.08 * Math.sin(Math.PI * 2 * progress)),
      opacity: progress === 0 ? 0 : 1,
    };
  }

  if (cue.kind === 'stamp') {
    return {
      x: 0,
      y: round(-Math.min(distance, 220) * (1 - arrival)),
      scale: round(piecewise(progress, 0.72, 1.65, 0.94, 1)),
      rotation: round(rotation * (1 - arrival)),
      opacity: progress === 0 ? 0 : 1,
    };
  }

  if (cue.kind === 'slap') {
    return {
      x: round(-Math.min(distance, 180) * (1 - arrival)),
      y: round(Math.min(distance, 90) * (1 - arrival)),
      scale: round(piecewise(progress, 0.76, 1.28, 0.96, 1)),
      rotation: round(rotation * 1.5 * (1 - arrival)),
      opacity: progress === 0 ? 0 : 1,
    };
  }

  const startScale = cue.kind === 'pop' ? 0.12 : 0.78;
  return {
    x: 0,
    y: cue.kind === 'pop' ? round(56 * (1 - arrival)) : 0,
    scale: round(piecewise(progress, 0.76, startScale, 1.06, 1)),
    rotation: round(-rotation * (1 - arrival)),
    opacity: progress === 0 ? 0 : 1,
  };
};

import type {LayerRole} from '@gen-video-tool/schema';
import {getMotionRecipe} from './recipes';
import type {
  CameraDirective,
  CompileRecipeOptions,
  CompiledMotionEvent,
  CompiledMotionPlan,
} from './types';

const round = (value: number): number => {
  const rounded = Math.round(value * 1_000_000) / 1_000_000;
  return Object.is(rounded, -0) ? 0 : rounded;
};
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const adaptCamera = (
  camera: CameraDirective,
  xMultiplier: number,
  yMultiplier: number,
): CameraDirective => ({
  ...camera,
  x: round(camera.x * xMultiplier),
  y: round(camera.y * yMultiplier),
});

/**
 * Compiles a named recipe into a frame-exact, serializable plan. It contains
 * no random values, wall-clock reads, or model-generated coordinates.
 */
export const compileMotionRecipe = (options: CompileRecipeOptions): CompiledMotionPlan => {
  const recipe = getMotionRecipe(options.recipeId);
  const durationFrames = Math.max(1, Math.round(options.durationFrames ?? recipe.defaultDurationFrames));
  const fps = Math.max(1, Math.round(options.fps ?? 30));
  const aspectRatio = options.aspectRatio ?? '9:16';
  const adaptation = recipe.aspectAdaptation[aspectRatio];
  const events: CompiledMotionEvent[] = recipe.entrances.map((entrance, index) => {
    const startFrame = clamp(
      Math.round(durationFrames * entrance.start * adaptation.entranceDelayMultiplier),
      0,
      durationFrames - 1,
    );
    const eventDuration = clamp(Math.round(durationFrames * entrance.duration), 1, durationFrames - startFrame);
    return {
      id: `${recipe.id}:entrance:${index + 1}:${entrance.role}`,
      kind: 'entrance',
      targetRole: entrance.role,
      animation: entrance.animation,
      startFrame,
      durationFrames: eventDuration,
    };
  });

  const emphasisStart = clamp(
    Math.round(durationFrames * recipe.emphasis.at),
    0,
    Math.max(0, durationFrames - 1),
  );
  const emphasisDuration =
    recipe.emphasis.animation === 'impactShake'
      ? clamp(recipe.emphasis.durationFrames, 6, 12)
      : recipe.emphasis.durationFrames;
  events.push({
    id: `${recipe.id}:emphasis:${recipe.emphasis.role}`,
    kind: 'emphasis',
    targetRole: recipe.emphasis.role,
    animation: recipe.emphasis.animation,
    startFrame: emphasisStart,
    durationFrames: clamp(emphasisDuration, 1, durationFrames - emphasisStart),
  });

  const transitionDuration = clamp(recipe.transition.durationFrames, 0, Math.max(0, durationFrames - 1));
  events.push({
    id: `${recipe.id}:transition`,
    kind: 'transition',
    targetRole: 'shot',
    animation: recipe.transition.animation,
    startFrame: durationFrames - transitionDuration,
    durationFrames: transitionDuration,
  });

  // Idle motion is intentionally absent unless the caller explicitly enables
  // it. Even then it is one subtle event, never constant multi-layer shake.
  if (options.enableIdle === true && durationFrames >= 24) {
    const occupied = events.reduce((latest, event) => Math.max(latest, event.startFrame + event.durationFrames), 0);
    const startFrame = Math.min(Math.max(12, occupied), durationFrames - 12);
    if (startFrame < durationFrames - transitionDuration) {
      events.push({
        id: `${recipe.id}:idle:subject`,
        kind: 'idle',
        targetRole: 'subject',
        animation: 'microDrift',
        startFrame,
        durationFrames: Math.max(1, durationFrames - transitionDuration - startFrame),
      });
    }
  }

  return Object.freeze({
    recipeId: recipe.id,
    durationFrames,
    fps,
    aspectRatio,
    energy: options.energy ?? recipe.energy,
    camera: Object.freeze(
      adaptCamera(recipe.camera, adaptation.cameraXMultiplier, adaptation.cameraYMultiplier),
    ),
    parallax: recipe.parallax,
    events: Object.freeze(events.map((event) => Object.freeze(event))),
  });
};

export const eventsForRole = (
  plan: CompiledMotionPlan,
  role: LayerRole,
): readonly CompiledMotionEvent[] => plan.events.filter((event) => event.targetRole === role);

import type {AspectRatio, LayerRole, MotionRecipeId} from '@gen-video-tool/schema';
import type {AspectAdaptation, MotionRecipe} from './types';

const PARALLAX: Readonly<Record<LayerRole, number>> = Object.freeze({
  background: 0.14,
  subject: 0.46,
  prop: 0.68,
  foreground: 1,
  title: 0.04,
  overlay: 0.08,
});

const ASPECT: Readonly<Record<AspectRatio, AspectAdaptation>> = Object.freeze({
  '9:16': {cameraXMultiplier: 0.55, cameraYMultiplier: 1, entranceDelayMultiplier: 1},
  '16:9': {cameraXMultiplier: 1, cameraYMultiplier: 0.55, entranceDelayMultiplier: 0.92},
  '1:1': {cameraXMultiplier: 0.75, cameraYMultiplier: 0.75, entranceDelayMultiplier: 0.96},
  '4:5': {cameraXMultiplier: 0.66, cameraYMultiplier: 0.9, entranceDelayMultiplier: 0.98},
});

const defineRecipe = (recipe: MotionRecipe): MotionRecipe =>
  Object.freeze({...recipe, entrances: Object.freeze([...recipe.entrances])});

export const MOTION_RECIPES = Object.freeze({
  'hero-assemble': defineRecipe({
    id: 'hero-assemble',
    label: 'Hero Assemble',
    description: 'Builds a hero composition from plate, subject, and a single foreground punctuation.',
    defaultDurationFrames: 150,
    energy: 'punchy',
    camera: {kind: 'push', x: 0, y: -0.025, scaleFrom: 1, scaleTo: 1.065},
    entrances: [
      {role: 'background', animation: 'paperUnfold', start: 0, duration: 0.18},
      {role: 'subject', animation: 'paperSlap', start: 0.12, duration: 0.18},
      {role: 'prop', animation: 'propPop', start: 0.24, duration: 0.14},
      {role: 'title', animation: 'newspaperSlide', start: 0.32, duration: 0.15},
    ],
    emphasis: {role: 'subject', animation: 'shadowSettle', at: 0.48, durationFrames: 10},
    transition: {animation: 'foregroundWipe', durationFrames: 12},
    parallax: PARALLAX,
    aspectAdaptation: ASPECT,
  }),
  'editorial-pan': defineRecipe({
    id: 'editorial-pan',
    label: 'Editorial Pan',
    description: 'A measured lateral read across an editorial collage.',
    defaultDurationFrames: 165,
    energy: 'balanced',
    camera: {kind: 'pan-right', x: 0.055, y: 0, scaleFrom: 1.025, scaleTo: 1.045},
    entrances: [
      {role: 'background', animation: 'paperUnfold', start: 0, duration: 0.2},
      {role: 'subject', animation: 'newspaperSlide', start: 0.13, duration: 0.2},
      {role: 'title', animation: 'tapeAttach', start: 0.3, duration: 0.15},
    ],
    emphasis: {role: 'prop', animation: 'halftonePulse', at: 0.55, durationFrames: 12},
    transition: {animation: 'paperTearReveal', durationFrames: 14},
    parallax: PARALLAX,
    aspectAdaptation: ASPECT,
  }),
  'number-impact': defineRecipe({
    id: 'number-impact',
    label: 'Number Impact',
    description: 'Reserves the visual hit for one number or statistic.',
    defaultDurationFrames: 120,
    energy: 'punchy',
    camera: {kind: 'push', x: 0, y: 0, scaleFrom: 1, scaleTo: 1.055},
    entrances: [
      {role: 'background', animation: 'photoStack', start: 0, duration: 0.16},
      {role: 'subject', animation: 'paperSlap', start: 0.13, duration: 0.16},
      {role: 'title', animation: 'propPop', start: 0.27, duration: 0.13},
    ],
    emphasis: {role: 'title', animation: 'impactShake', at: 0.5, durationFrames: 8},
    transition: {animation: 'misregistrationFlash', durationFrames: 8},
    parallax: PARALLAX,
    aspectAdaptation: ASPECT,
  }),
  'paper-stack': defineRecipe({
    id: 'paper-stack',
    label: 'Paper Stack',
    description: 'Stacks photos and notes with staggered physical weight.',
    defaultDurationFrames: 150,
    energy: 'balanced',
    camera: {kind: 'pull', x: 0, y: 0.018, scaleFrom: 1.06, scaleTo: 1.015},
    entrances: [
      {role: 'background', animation: 'paperUnfold', start: 0, duration: 0.2},
      {role: 'subject', animation: 'photoStack', start: 0.1, duration: 0.22},
      {role: 'prop', animation: 'photoStack', start: 0.25, duration: 0.18},
      {role: 'title', animation: 'tapeAttach', start: 0.36, duration: 0.15},
    ],
    emphasis: {role: 'subject', animation: 'shadowSettle', at: 0.53, durationFrames: 12},
    transition: {animation: 'foregroundWipe', durationFrames: 12},
    parallax: PARALLAX,
    aspectAdaptation: ASPECT,
  }),
  'timeline-travel': defineRecipe({
    id: 'timeline-travel',
    label: 'Timeline Travel',
    description: 'Travels along chronology while each date lands as a discrete event.',
    defaultDurationFrames: 180,
    energy: 'balanced',
    camera: {kind: 'pan-right', x: 0.075, y: -0.012, scaleFrom: 1.02, scaleTo: 1.04},
    entrances: [
      {role: 'background', animation: 'newspaperSlide', start: 0, duration: 0.22},
      {role: 'prop', animation: 'propRoll', start: 0.16, duration: 0.2},
      {role: 'subject', animation: 'paperSlap', start: 0.3, duration: 0.17},
      {role: 'title', animation: 'tapeAttach', start: 0.4, duration: 0.14},
    ],
    emphasis: {role: 'prop', animation: 'halftonePulse', at: 0.63, durationFrames: 12},
    transition: {animation: 'paperTearReveal', durationFrames: 14},
    parallax: PARALLAX,
    aspectAdaptation: ASPECT,
  }),
  'comparison-split': defineRecipe({
    id: 'comparison-split',
    label: 'Comparison Split',
    description: 'Introduces two sides in sequence so the comparison remains legible.',
    defaultDurationFrames: 150,
    energy: 'punchy',
    camera: {kind: 'locked', x: 0, y: 0, scaleFrom: 1.01, scaleTo: 1.025},
    entrances: [
      {role: 'background', animation: 'paperUnfold', start: 0, duration: 0.16},
      {role: 'subject', animation: 'newspaperSlide', start: 0.12, duration: 0.2},
      {role: 'prop', animation: 'newspaperSlide', start: 0.3, duration: 0.2},
      {role: 'title', animation: 'paperSlap', start: 0.46, duration: 0.13},
    ],
    emphasis: {role: 'title', animation: 'impactShake', at: 0.62, durationFrames: 7},
    transition: {animation: 'misregistrationFlash', durationFrames: 7},
    parallax: PARALLAX,
    aspectAdaptation: ASPECT,
  }),
  'quiet-story': defineRecipe({
    id: 'quiet-story',
    label: 'Quiet Story',
    description: 'A restrained scene reveal for emotional or family storytelling.',
    defaultDurationFrames: 180,
    energy: 'quiet',
    camera: {kind: 'push', x: 0.008, y: -0.012, scaleFrom: 1, scaleTo: 1.035},
    entrances: [
      {role: 'background', animation: 'paperUnfold', start: 0, duration: 0.25},
      {role: 'subject', animation: 'paperTearReveal', start: 0.18, duration: 0.24},
      {role: 'foreground', animation: 'foregroundWipe', start: 0.35, duration: 0.18},
      {role: 'title', animation: 'tapeAttach', start: 0.44, duration: 0.16},
    ],
    emphasis: {role: 'subject', animation: 'shadowSettle', at: 0.58, durationFrames: 12},
    transition: {animation: 'foregroundWipe', durationFrames: 15},
    parallax: PARALLAX,
    aspectAdaptation: ASPECT,
  }),
  'detail-reveal': defineRecipe({
    id: 'detail-reveal',
    label: 'Detail Reveal',
    description: 'Begins close, reveals context, and holds attention on a single detail.',
    defaultDurationFrames: 135,
    energy: 'balanced',
    camera: {kind: 'pull', x: -0.012, y: 0.01, scaleFrom: 1.11, scaleTo: 1.025},
    entrances: [
      {role: 'background', animation: 'photoStack', start: 0, duration: 0.2},
      {role: 'prop', animation: 'propPop', start: 0.14, duration: 0.17},
      {role: 'subject', animation: 'paperTearReveal', start: 0.28, duration: 0.21},
      {role: 'title', animation: 'newspaperSlide', start: 0.42, duration: 0.15},
    ],
    emphasis: {role: 'prop', animation: 'halftonePulse', at: 0.62, durationFrames: 10},
    transition: {animation: 'paperTearReveal', durationFrames: 12},
    parallax: PARALLAX,
    aspectAdaptation: ASPECT,
  }),
} satisfies Record<MotionRecipeId, MotionRecipe>);

export const MOTION_RECIPE_IDS = Object.freeze(Object.keys(MOTION_RECIPES) as MotionRecipeId[]);

export const getMotionRecipe = (id: MotionRecipeId): MotionRecipe => MOTION_RECIPES[id];

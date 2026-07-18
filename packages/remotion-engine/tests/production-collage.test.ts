import {describe, expect, it} from 'vitest';
import {
  PAPER_LAYER_DROP_SHADOW,
  productionCollageLayerFilter,
  sampleProductionCollageLayerMotion,
  type ProductionCollageLayer,
} from '../src/ProductionCollageScene';

const layer = (overrides: Partial<ProductionCollageLayer> = {}): ProductionCollageLayer => ({
  id: 'subject',
  assetPath: 'assets/subject.png',
  role: 'actor',
  zIndex: 300,
  transform: {
    x: 540,
    y: 960,
    scaleX: 1,
    scaleY: 1,
    rotationDegrees: 0,
    opacity: 1,
  },
  ...overrides,
});

describe('production collage paper assembly', () => {
  it('lets one-shot assembly override legacy looping motion', () => {
    const subject = layer({
      motionPreset: 'drift',
      assembly: {
        kind: 'slide-left',
        startFrame: 8,
        durationFrames: 12,
        distance: 900,
        rotationDegrees: 5,
        steps: 8,
      },
    });

    expect(sampleProductionCollageLayerMotion(subject, 7, 96)).toEqual({
      x: 0,
      y: 0,
      scale: 1,
      rotation: 0,
      opacity: 0,
    });
    expect(sampleProductionCollageLayerMotion(subject, 12, 96).x).toBeLessThan(0);
    expect(sampleProductionCollageLayerMotion(subject, 20, 96)).toEqual({
      x: 0,
      y: 0,
      scale: 1,
      rotation: 0,
      opacity: 1,
    });
  });

  it('locks exactly to the authored pose after settle instead of resuming a loop', () => {
    const subject = layer({
      motionPreset: 'paper-sway',
      assembly: {
        kind: 'stamp',
        startFrame: 4,
        durationFrames: 10,
        distance: 140,
        rotationDegrees: 3,
        steps: 7,
      },
    });
    const settled = {x: 0, y: 0, scale: 1, rotation: 0, opacity: 1};

    expect(sampleProductionCollageLayerMotion(subject, 14, 120)).toEqual(settled);
    expect(sampleProductionCollageLayerMotion(subject, 45, 120)).toEqual(settled);
    expect(sampleProductionCollageLayerMotion(subject, 119, 120)).toEqual(settled);
  });

  it('plays one finite low-cadence whole-PNG action and restores the final still', () => {
    const subject = layer({
      motionPreset: 'locked',
      assembly: {
        kind: 'slide-left',
        startFrame: 4,
        durationFrames: 24,
        distance: 720,
        rotationDegrees: 5,
        steps: 8,
        followThrough: {
          kind: 'bob',
          delayFrames: 8,
          durationFrames: 30,
          distance: 28,
          rotationDegrees: 3,
          cadenceFps: 3,
        },
      },
    });
    const settled = {x: 0, y: 0, scale: 1, rotation: 0, opacity: 1};

    expect(sampleProductionCollageLayerMotion(subject, 35, 120)).toEqual(settled);
    expect(sampleProductionCollageLayerMotion(subject, 46, 120).y).toBeLessThan(0);
    expect(sampleProductionCollageLayerMotion(subject, 66, 120)).toEqual(settled);
    expect(sampleProductionCollageLayerMotion(subject, 119, 120)).toEqual(settled);
  });

  it('keeps legacy motion presets compatible when no assembly cue exists', () => {
    const locked = layer({motionPreset: 'locked'});
    const swaying = layer({motionPreset: 'paper-sway'});

    expect(sampleProductionCollageLayerMotion(locked, 30, 96)).toEqual({
      x: 0,
      y: 0,
      scale: 1,
      rotation: 0,
      opacity: 1,
    });
    expect(sampleProductionCollageLayerMotion(swaying, 10, 96))
      .not.toEqual(sampleProductionCollageLayerMotion(swaying, 50, 96));
  });

  it('adds a restrained alpha-following shadow only to paper layers', () => {
    expect(productionCollageLayerFilter('background')).toBeUndefined();
    for (const role of ['midground', 'actor', 'prop', 'foreground', 'overlay'] as const) {
      expect(productionCollageLayerFilter(role)).toBe(PAPER_LAYER_DROP_SHADOW);
    }
    expect(PAPER_LAYER_DROP_SHADOW).toBe('drop-shadow(0 7px 8px rgba(24, 15, 9, 0.22))');
  });
});

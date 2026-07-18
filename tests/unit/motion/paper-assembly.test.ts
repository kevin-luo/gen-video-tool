import {describe, expect, it} from 'vitest';
import {
  samplePaperAssembly,
  type PaperAssemblyCue,
} from '@gen-video-tool/motion-core';

const cue = (overrides: Partial<PaperAssemblyCue> = {}): PaperAssemblyCue => ({
  kind: 'slide-left',
  startFrame: 12,
  durationFrames: 20,
  distance: 800,
  rotationDegrees: 8,
  steps: 10,
  ...overrides,
});

describe('samplePaperAssembly', () => {
  it('keeps the paper group fully absent before its entrance', () => {
    expect(samplePaperAssembly(cue(), 11)).toEqual({
      x: 0,
      y: 0,
      scale: 1,
      rotation: 0,
      opacity: 0,
    });
  });

  it('uses discrete stop-motion placements instead of frame-by-frame drift', () => {
    const first = samplePaperAssembly(cue(), 16);
    const held = samplePaperAssembly(cue(), 17);
    const next = samplePaperAssembly(cue(), 18);

    expect(first.opacity).toBe(1);
    expect(first).toEqual(held);
    expect(next.x).toBeGreaterThan(first.x);
  });

  it('locks exactly to the authored transform after settling', () => {
    const settled = {x: 0, y: 0, scale: 1, rotation: 0, opacity: 1};
    expect(samplePaperAssembly(cue(), 32)).toEqual(settled);
    expect(samplePaperAssembly(cue(), 200)).toEqual(settled);
  });

  it('uses a hand-placed overshoot and correction before the exact settle', () => {
    const placement = cue({startFrame: 0, durationFrames: 20, steps: 10});

    expect(samplePaperAssembly(placement, 8).x).toBeLessThan(0);
    expect(samplePaperAssembly(placement, 14).x).toBeGreaterThan(0);
    expect(samplePaperAssembly(placement, 18).x).toBeLessThan(0);
    expect(samplePaperAssembly(placement, 20).x).toBe(0);
  });

  it('adds a finite whole-card gesture after settle and then holds the authored pose', () => {
    const placement = cue({
      startFrame: 0,
      durationFrames: 20,
      followThrough: {
        kind: 'gesture-left',
        delayFrames: 4,
        durationFrames: 30,
        distance: 24,
        rotationDegrees: 3,
        cadenceFps: 3,
      },
    });
    const settled = {x: 0, y: 0, scale: 1, rotation: 0, opacity: 1};

    expect(samplePaperAssembly(placement, 23)).toEqual(settled);
    expect(samplePaperAssembly(placement, 34)).toMatchObject({
      x: expect.any(Number),
      y: expect.any(Number),
      scale: 1,
      opacity: 1,
    });
    expect(samplePaperAssembly(placement, 34).x).toBeLessThan(0);
    expect(samplePaperAssembly(placement, 34).rotation).toBeLessThan(0);
    expect(samplePaperAssembly(placement, 54)).toEqual(settled);
    expect(samplePaperAssembly(placement, 200)).toEqual(settled);
  });

  it('holds each follow-through placement at a tactile 2-4fps cadence', () => {
    const placement = cue({
      startFrame: 0,
      durationFrames: 20,
      followThrough: {
        kind: 'sway',
        delayFrames: 0,
        durationFrames: 40,
        distance: 22,
        rotationDegrees: 4,
        cadenceFps: 3,
      },
    });

    expect(samplePaperAssembly(placement, 30)).toEqual(samplePaperAssembly(placement, 39));
    expect(samplePaperAssembly(placement, 40)).not.toEqual(samplePaperAssembly(placement, 39));
  });

  it('holds an explicit exit invisibly offstage instead of drifting forever', () => {
    const placement = cue({
      startFrame: 0,
      durationFrames: 20,
      followThrough: {
        kind: 'exit-right',
        delayFrames: 6,
        durationFrames: 24,
        distance: 1_100,
        rotationDegrees: 6,
        cadenceFps: 4,
      },
    });
    const exited = {x: 1_100, y: 0, scale: 1, rotation: 6, opacity: 0};

    expect(samplePaperAssembly(placement, 34).x).toBeGreaterThan(0);
    expect(samplePaperAssembly(placement, 50)).toEqual(exited);
    expect(samplePaperAssembly(placement, 200)).toEqual(exited);
  });

  it.each([
    ['slide-left', 'x', -1],
    ['slide-right', 'x', 1],
    ['slide-up', 'y', -1],
    ['drop', 'y', -1],
    ['rise', 'y', 1],
  ] as const)('enters %s from the expected side', (kind, axis, sign) => {
    const sample = samplePaperAssembly(cue({kind, startFrame: 0}), 4);
    expect(Math.sign(sample[axis])).toBe(sign);
    expect(sample.opacity).toBe(1);
  });

  it.each(['snap', 'slap', 'stamp', 'pop'] as const)(
    'keeps %s deterministic and affine-only',
    (kind) => {
      const action = cue({kind, startFrame: 0});
      const first = samplePaperAssembly(action, 8);
      const second = samplePaperAssembly(action, 8);

      expect(second).toEqual(first);
      expect(Object.keys(first).sort()).toEqual(['opacity', 'rotation', 'scale', 'x', 'y']);
      expect(Object.values(first).every(Number.isFinite)).toBe(true);
    },
  );
});

import {describe, expect, it} from 'vitest';
import {
  HYBRID_LAYER_ORDER,
  computePreserveDurationPlaybackRate,
  focalPointToObjectPosition,
} from '../src/HybridPerformanceScene';

describe('v3 generated-performance conform', () => {
  it('uses the normalized focal point as CSS cover positioning', () => {
    expect(focalPointToObjectPosition({x: 0.5, y: 0.56})).toBe('50% 56%');
    expect(focalPointToObjectPosition({x: -1, y: 2})).toBe('0% 100%');
  });

  it('maps native WanGP time to exact delivery time instead of matching frame indices', () => {
    const playbackRate = computePreserveDurationPlaybackRate(
      {width: 480, height: 832, fps: 24, frameCount: 81},
      30,
      101,
    );

    expect(playbackRate).toBeCloseTo((81 / 24) / (101 / 30), 8);
    expect(playbackRate).toBeCloseTo(1.0024752475, 8);
  });

  it('keeps causal props behind the subject matte and static foreground', () => {
    expect(HYBRID_LAYER_ORDER.generatedPlate).toBeLessThan(HYBRID_LAYER_ORDER.deterministicProp);
    expect(HYBRID_LAYER_ORDER.deterministicProp).toBeLessThan(HYBRID_LAYER_ORDER.subjectMatte);
    expect(HYBRID_LAYER_ORDER.subjectMatte).toBeLessThan(HYBRID_LAYER_ORDER.staticForeground);
    expect(HYBRID_LAYER_ORDER.staticForeground).toBeLessThan(HYBRID_LAYER_ORDER.editorialOverlay);
  });
});

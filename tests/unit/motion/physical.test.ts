import {describe, expect, it} from 'vitest';
import {sampleBallisticProp} from '@gen-video-tool/motion-core';

describe('world-aware prop motion', () => {
  const base = {x: 20, y: 700, scaleX: 0.26, scaleY: 0.26, rotation: 0};
  const kick = {
    contactFrame: 12,
    flightFrames: 30,
    targetX: 90,
    targetY: -260,
    targetScale: 0.14,
    curveX: 24,
    spinDegrees: 420,
  };

  it('keeps a causal prop planted before physical contact', () => {
    expect(sampleBallisticProp(kick, 0, base)).toEqual(base);
    expect(sampleBallisticProp(kick, 11, base)).toEqual(base);
  });

  it('moves only after contact and reaches the configured target', () => {
    expect(sampleBallisticProp(kick, 13, base).y).toBeLessThan(base.y);
    expect(sampleBallisticProp(kick, 42, base)).toMatchObject({
      x: 90,
      y: -260,
      scaleX: 0.14,
      scaleY: 0.14,
      rotation: 420,
    });
  });
});

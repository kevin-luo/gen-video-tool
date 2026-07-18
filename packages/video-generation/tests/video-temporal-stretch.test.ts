import {describe, expect, it} from 'vitest';
import {
  calculateVideoTemporalStretch,
  VideoValidationError,
} from '../src/validation/video';

describe('video temporal stretch', () => {
  it('maps a 49-frame 24 fps source to the exact 81-frame project contract', () => {
    const result = calculateVideoTemporalStretch({
      durationSeconds: 49 / 24,
      fps: 24,
      frameCount: 49,
    }, 81 / 24, 24);

    expect(result.targetFrameCount).toBe(81);
    expect(result.timestampScale).toBeCloseTo(5 / 3, 12);
  });

  it('falls back to container duration when frame metadata is unavailable', () => {
    const result = calculateVideoTemporalStretch({
      durationSeconds: 2,
      fps: null,
      frameCount: null,
    }, 4, 30);

    expect(result.targetFrameCount).toBe(120);
    expect(result.timestampScale).toBeCloseTo(119 / 60, 12);
  });

  it('rejects a source without a positive timeline span', () => {
    expect(() => calculateVideoTemporalStretch({
      durationSeconds: null,
      fps: null,
      frameCount: null,
    }, 3, 24)).toThrow(VideoValidationError);
  });
});

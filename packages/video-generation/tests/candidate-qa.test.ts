import {describe, expect, it} from 'vitest';
import {buildGeneratedCandidateTechnicalQa} from '../src/production/candidate-qa';
import type {VideoProbe} from '../src/validation/video';
import {makeProductionPlan} from './production-fixture';

const validProbe = (): VideoProbe => ({
  sourcePath: 'C:/generated/candidate.mp4',
  width: 480,
  height: 832,
  fps: 24,
  frameCount: 81,
  durationSeconds: 81 / 24,
  codecName: 'h264',
  pixelFormat: 'yuv420p',
  formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
  hasAudio: false,
  fileSizeBytes: 1_024,
});

describe('generated candidate technical QA', () => {
  it('uses the exact 81-frame contract accepted by final render', () => {
    const shot = makeProductionPlan().shots[0]!;
    if (shot.kind !== 'generated-performance') throw new Error('fixture mismatch');

    expect(buildGeneratedCandidateTechnicalQa(shot, validProbe()).result).toBe('pass');

    const short = validProbe();
    short.frameCount = 80;
    const failed = buildGeneratedCandidateTechnicalQa(shot, short);
    expect(failed.result).toBe('fail');
    expect(failed.issues).toContain('frameCount expected 81, received 80');
  });
});

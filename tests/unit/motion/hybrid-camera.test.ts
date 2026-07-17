import {describe, expect, it} from 'vitest';
import {sampleCamera} from '@gen-video-tool/motion-core';
import {compileEditorialCamera} from '@gen-video-tool/remotion-engine';

describe('hybrid editorial camera', () => {
  it('keeps a locked generated performance pixel-stable', () => {
    const directive = compileEditorialCamera({
      owner: 'editorial-camera',
      operation: 'locked',
      strength: 0,
    });
    expect(sampleCamera(directive, 40, 81)).toEqual({x: 0, y: 0, scale: 1});
  });

  it('applies one restrained push only after all interaction layers are composed', () => {
    const directive = compileEditorialCamera({
      owner: 'editorial-camera',
      operation: 'push',
      strength: 0.25,
    });
    expect(sampleCamera(directive, 0, 81)).toEqual({x: 0, y: 0, scale: 1});
    expect(sampleCamera(directive, 80, 81)).toEqual({x: 0, y: 0, scale: 1.02});
  });

  it('protects canvas edges during a pan', () => {
    const directive = compileEditorialCamera({
      owner: 'editorial-camera',
      operation: 'pan-right',
      strength: 0.4,
    });
    expect(directive).toMatchObject({x: 0.018, y: 0, scaleFrom: 1.014, scaleTo: 1.014});
  });
});

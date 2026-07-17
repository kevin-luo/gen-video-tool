import {describe, expect, it} from 'vitest';

import {LocalResourceSampler} from '../src/telemetry/local-resource-sampler.js';

describe('LocalResourceSampler', () => {
  it('records the largest sampled GPU and system RAM values', async () => {
    const gpu = [100, 420, 300];
    const ram = [1_000, 1_250, 1_100];
    const sampler = new LocalResourceSampler({
      intervalMs: 250,
      gpuQuery: async () => gpu.shift(),
      ramQuery: () => ram.shift() ?? 1_100,
    });
    sampler.start();
    await new Promise((resolve) => setTimeout(resolve, 570));
    expect(await sampler.stop()).toEqual({peakVramMb: 420, peakRamMb: 1_250});
  });
});

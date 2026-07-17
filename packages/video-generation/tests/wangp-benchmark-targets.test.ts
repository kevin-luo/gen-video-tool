import {describe, expect, it} from 'vitest';

import {resolveWanGPBenchmarkTargets} from '../src/providers/wangp-benchmark-targets.js';
import type {WanGPCapabilityCatalog, WanGPModelCapability} from '../src/providers/wangp-capabilities.js';

const model = (runtimeModelId: string, label: string, tags: string[], availability: WanGPModelCapability['availability'] = 'available'): WanGPModelCapability => ({
  runtimeModelId, label, tags, availability, imageToVideo: true, finetune: false,
  profileDirectories: ['opaque-profiles'], defaultSettings: {}, supportedResolutions: [{width: 480, height: 832}],
  supportedFrameCounts: [49], quantization: ['int8'], cache: {tea: true, mag: true}, raw: {}, schema: {},
});

describe('resolveWanGPBenchmarkTargets', () => {
  it('matches opaque runtime identifiers only from capability tags', () => {
    const catalog: WanGPCapabilityCatalog = {
      discoveredAt: new Date(0).toISOString(), source: 'wangp-mcp', tiers: [],
      models: [
        model('opaque-a', 'A', ['fun-inp', 'one-point-three-billion']),
        model('opaque-b', 'B', ['fastwan', 'five-billion'], 'missing'),
        model('opaque-c', 'C', ['enhanced-lightning', 'fourteen-billion']),
        model('opaque-d', 'D', ['lightx2v', 'four-step', 'int8']),
      ],
      acceleratorProfiles: [{
        id: 'opaque-profile', directory: 'opaque-profiles', label: 'Fast profile', relativePath: 'x.json',
        settings: {}, source: 'local-catalog', tags: ['fastwan'], acceleratorLoras: [], loraMultipliers: [],
      }],
    };
    const targets = resolveWanGPBenchmarkTargets(catalog);
    expect(targets.map((target) => target.modelRuntimeId)).toEqual(['opaque-a', 'opaque-b', 'opaque-c', 'opaque-d']);
    expect(targets[1]).toMatchObject({installed: false, acceleratorProfileId: 'opaque-profile'});
  });
});

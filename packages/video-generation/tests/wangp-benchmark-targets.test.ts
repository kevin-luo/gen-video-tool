import {describe, expect, it} from 'vitest';

import {resolveWanGPBenchmarkTargets} from '../src/providers/wangp-benchmark-targets.js';
import type {WanGPCapabilityCatalog, WanGPModelCapability} from '../src/providers/wangp-capabilities.js';

const model = (runtimeModelId: string, label: string, tags: string[], availability: WanGPModelCapability['availability'] = 'available'): WanGPModelCapability => ({
  runtimeModelId, label, tags, availability, textToVideo: false, imageToVideo: true, finetune: false,
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
        model('opaque-d', 'D', ['image-to-video', 'lightx2v', 'four-step', 'fourteen-billion', 'int8']),
      ],
      acceleratorProfiles: [{
        id: 'opaque-profile', directory: 'opaque-profiles', label: 'Fast profile', relativePath: 'x.json',
        settings: {}, source: 'local-catalog', tags: ['fastwan'], acceleratorLoras: [], loraMultipliers: [],
      }],
    };
    const targets = resolveWanGPBenchmarkTargets(catalog);
    expect(targets.map((target) => target.modelRuntimeId)).toEqual(['opaque-a', 'opaque-b', 'opaque-c', 'opaque-d']);
    expect(targets[1]).toMatchObject({installed: false});
    expect(targets[1]?.acceleratorProfileId).toBeUndefined();
  });

  it('discovers LightX2V through a compatible INT8 base model and 4-step profile', () => {
    const base = model('opaque-base', 'Wan I2V 14B INT8', ['image-to-video', 'fourteen-billion', 'int8']);
    const catalog: WanGPCapabilityCatalog = {
      discoveredAt: new Date(0).toISOString(), source: 'wangp-mcp', tiers: [],
      models: [base],
      acceleratorProfiles: [{
        id: 'opaque-lightx-profile',
        directory: 'opaque-profiles',
        label: 'Image2Video LightX2V - 4 Steps',
        relativePath: 'lightx.json',
        settings: {num_inference_steps: 4, guidance_scale: 1},
        source: 'local-catalog',
        tags: ['lightx2v', 'four-step'],
        steps: 4,
        guidance: 1,
        acceleratorLoras: [],
        loraMultipliers: [],
      }],
    };
    const target = resolveWanGPBenchmarkTargets(catalog)
      .find((candidate) => candidate.targetId === 'lightx2v-4step');

    expect(target).toMatchObject({
      discovered: true,
      installed: true,
      modelRuntimeId: 'opaque-base',
      acceleratorProfileId: 'opaque-lightx-profile',
    });
  });

  it('prefers the generic compatible I2V base over an unrelated specialized finetune', () => {
    const generic = model('opaque-generic', 'Wan I2V 480p 14B', ['image-to-video', 'fourteen-billion', 'int8', 'bf16'], 'missing');
    const specialized = model('opaque-specialized', 'Fun InP I2V 14B', ['image-to-video', 'fun-inp', 'fourteen-billion', 'int8', 'bf16'], 'missing');
    const catalog: WanGPCapabilityCatalog = {
      discoveredAt: new Date(0).toISOString(), source: 'wangp-mcp', tiers: [],
      models: [specialized, generic],
      acceleratorProfiles: [{
        id: 'opaque-lightx-profile', directory: 'opaque-profiles', label: 'LightX2V 4 Steps',
        relativePath: 'lightx.json', settings: {num_inference_steps: 4}, source: 'local-catalog',
        tags: ['lightx2v', 'four-step'], steps: 4, acceleratorLoras: [], loraMultipliers: [],
      }],
    };

    expect(resolveWanGPBenchmarkTargets(catalog)
      .find((candidate) => candidate.targetId === 'lightx2v-4step'))
      .toMatchObject({modelRuntimeId: 'opaque-generic'});
  });

  it('uses an accelerator profile when the base model does not carry the target finetune', () => {
    const base = model('opaque-five-billion-base', 'Wan 5B base', ['image-to-video', 'five-billion', 'int8'], 'missing');
    const catalog: WanGPCapabilityCatalog = {
      discoveredAt: new Date(0).toISOString(), source: 'wangp-mcp', tiers: [],
      models: [base],
      acceleratorProfiles: [{
        id: 'opaque-fast-profile', directory: 'opaque-profiles', label: 'FastWan 3 Steps',
        relativePath: 'fast.json', settings: {num_inference_steps: 3}, source: 'local-catalog',
        tags: ['fastwan'], steps: 3, acceleratorLoras: [], loraMultipliers: [],
      }],
    };

    expect(resolveWanGPBenchmarkTargets(catalog)
      .find((candidate) => candidate.targetId === 'fastwan-5b'))
      .toMatchObject({modelRuntimeId: 'opaque-five-billion-base', acceleratorProfileId: 'opaque-fast-profile'});
  });
});

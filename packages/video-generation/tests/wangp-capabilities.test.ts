import {describe, expect, it} from 'vitest';

import {
  buildWanGPAcceleratorProfile,
  buildWanGPCapabilityCatalog,
  buildWanGPModelCapability,
  resolveWanGPCachePolicy,
} from '../src/providers/wangp-capabilities';

const model = (input: {
  runtimeModelId: string;
  name: string;
  availability?: 'available' | 'missing';
  profiles?: string[];
  steps?: number;
  tea?: boolean;
  mag?: boolean;
  extra?: Record<string, unknown>;
}) => buildWanGPModelCapability({
  raw: {
    model_type: input.runtimeModelId,
    name: input.name,
    family: 'wan2_2',
    base_model_type: 'opaque-base',
    availability: {status: input.availability ?? 'available'},
    capabilities: {image_to_video: true},
    media_inputs: {image: {start: true, end: true}},
    ...input.extra,
  },
  schema: {
    model_def: {
      profiles_dir: input.profiles ?? [],
      frames_minimum: 5,
      frames_steps: 4,
      tea_cache: input.tea ?? false,
      mag_cache: input.mag ?? true,
      settings: {
        resolution: '832x480',
        num_inference_steps: input.steps ?? 20,
        guidance_scale: input.steps !== undefined && input.steps <= 4 ? 1 : 5,
      },
    },
  },
  defaultSettings: {
    resolution: '832x480',
    num_inference_steps: input.steps ?? 20,
    guidance_scale: input.steps !== undefined && input.steps <= 4 ? 1 : 5,
  },
})!;

const profile = (directory: string, label: string, steps: number) => buildWanGPAcceleratorProfile({
  directory,
  label,
  relativePath: `${directory}/${label}.json`,
  settings: {
    num_inference_steps: steps,
    guidance_scale: 1,
    activated_loras: [`https://local.invalid/${label}.safetensors`],
    loras_multipliers: '1',
  },
  source: 'mcp',
});

describe('WanGP dynamic capability matching', () => {
  it('matches the three local tiers from metadata without relying on internal IDs', () => {
    const models = [
      model({runtimeModelId: 'opaque-a7', name: 'Fun InP image2video 1.3B', steps: 20}),
      model({runtimeModelId: 'opaque-b8', name: 'Wan2.2 TextImage2video FastWan 5B', profiles: ['wan-fast'], steps: 3}),
      model({runtimeModelId: 'opaque-c9', name: 'Wan2.2 Image2video Enhanced Lightning v2 14B', steps: 4}),
    ];
    const catalog = buildWanGPCapabilityCatalog({
      models,
      profiles: [profile('wan-fast', 'FastWan accelerator', 3)],
    });

    expect(catalog.tiers.map((tier) => [tier.tier, tier.modelRuntimeId])).toEqual([
      ['ultra-preview', 'opaque-a7'],
      ['balanced-local', 'opaque-b8'],
      ['quality-local', 'opaque-c9'],
    ]);
    expect(catalog.tiers[0]).toMatchObject({frameCount: 49, candidateCount: 1, memoryProfile: 4, attention: 'auto'});
    expect(catalog.tiers[1]).toMatchObject({acceleratorProfileLabel: 'FastWan accelerator'});
    expect(catalog.tiers[2]).toMatchObject({steps: 4, guidance: 1, cachePolicy: {kind: 'off'}});
  });

  it('rejects NVFP4 from RTX 30 tier resolution and prefers an INT8/GGUF metadata match', () => {
    const nvfp4 = model({
      runtimeModelId: 'opaque-nvfp4',
      name: 'Wan2.1 Image2video 14B NVFP4 LightX2V 4-step',
      steps: 4,
    });
    const int8 = model({
      runtimeModelId: 'opaque-int8',
      name: 'Wan2.1 Image2video 14B INT8',
      profiles: ['wan-i2v'],
      steps: 30,
      extra: {transformer: 'quanto_int8'},
    });
    const light = profile('wan-i2v', 'Image2Video LightX2V 4 Steps', 4);
    const catalog = buildWanGPCapabilityCatalog({models: [nvfp4, int8], profiles: [light]});
    const quality = catalog.tiers.find((tier) => tier.tier === 'quality-local');

    expect(quality?.modelRuntimeId).toBe('opaque-int8');
    expect(quality?.quantization).toContain('int8');
  });

  it('enforces cache policy by effective step count and distillation metadata', () => {
    const base = model({runtimeModelId: 'base', name: 'Wan image2video 14B', tea: true, mag: true, steps: 30});
    const distilled = model({runtimeModelId: 'distilled', name: 'Wan Lightning image2video 14B', tea: true, steps: 4});

    expect(resolveWanGPCachePolicy({model: distilled, steps: 4})).toMatchObject({kind: 'off'});
    expect(resolveWanGPCachePolicy({model: base, steps: 10})).toMatchObject({kind: 'tea', multiplier: 1.5});
    expect(resolveWanGPCachePolicy({model: base, steps: 30})).toMatchObject({kind: 'tea', multiplier: 2});
  });

  it('derives portrait resolution and valid 4n+1 frame counts from schema metadata', () => {
    const capability = model({runtimeModelId: 'geometry', name: 'Wan image2video', steps: 20});
    expect(capability.supportedResolutions).toContainEqual({width: 480, height: 832});
    expect(capability.supportedFrameCounts).toEqual([49, 81]);
  });
});


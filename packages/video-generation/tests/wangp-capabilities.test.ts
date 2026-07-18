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
    expect(catalog.tiers[1]).not.toHaveProperty('acceleratorProfileId');
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

  it('prefers a real FastWan finetune over a base 5B model using the same profile', () => {
    const base = model({
      runtimeModelId: 'opaque-base-5b',
      name: 'Wan2.2 TextImage2video 5B',
      profiles: ['wan-fast'],
      steps: 20,
    });
    const finetune = model({
      runtimeModelId: 'opaque-fastwan-5b',
      name: 'Wan2.2 TextImage2video FastWan 5B',
      profiles: ['wan-fast'],
      steps: 3,
    });
    const catalog = buildWanGPCapabilityCatalog({
      models: [base, finetune],
      profiles: [profile('wan-fast', 'FastWan 3 Steps', 3)],
    });

    expect(catalog.tiers.find((tier) => tier.tier === 'balanced-local')?.modelRuntimeId)
      .toBe('opaque-fastwan-5b');
    expect(catalog.tiers.find((tier) => tier.tier === 'balanced-local'))
      .not.toHaveProperty('acceleratorProfileId');
  });

  it('uses an installed INT8 LightX quality path instead of FP8 on RTX 30', () => {
    const fp8Enhanced = model({
      runtimeModelId: 'opaque-enhanced',
      name: 'Wan2.2 Image2video Enhanced Lightning v2 14B FP8',
      steps: 4,
    });
    const installedBase = model({
      runtimeModelId: 'opaque-i2v-int8',
      name: 'Wan2.1 Image2video 14B INT8',
      profiles: ['wan-i2v'],
      steps: 30,
    });
    const catalog = buildWanGPCapabilityCatalog({
      models: [fp8Enhanced, installedBase],
      profiles: [profile('wan-i2v', 'Image2Video LightX2V 4 Steps', 4)],
    });

    expect(catalog.tiers.find((tier) => tier.tier === 'quality-local')).toMatchObject({
      available: true,
      modelRuntimeId: 'opaque-i2v-int8',
      acceleratorProfileLabel: 'Image2Video LightX2V 4 Steps',
      steps: 4,
    });
  });

  it('does not apply a 14B accelerator profile to an installed 1.3B model', () => {
    const preview = model({
      runtimeModelId: 'opaque-preview',
      name: 'Fun InP image2video 1.3B',
      profiles: ['wan-i2v'],
      steps: 20,
    });
    const quality = model({
      runtimeModelId: 'opaque-quality',
      name: 'Wan2.1 Image2video 14B INT8',
      availability: 'missing',
      profiles: ['wan-i2v'],
      steps: 30,
    });
    const fourteenBLightX = buildWanGPAcceleratorProfile({
      directory: 'wan-i2v',
      label: 'Image2Video LightX2V 4 Steps',
      relativePath: 'wan-i2v/lightx.json',
      settings: {
        num_inference_steps: 4,
        guidance_scale: 1,
        activated_loras: ['https://example.invalid/Wan21_I2V_14B_lightx2v_lora.safetensors'],
      },
      source: 'mcp',
    });
    const catalog = buildWanGPCapabilityCatalog({models: [preview, quality], profiles: [fourteenBLightX]});

    expect(catalog.tiers.find((tier) => tier.tier === 'quality-local')).toMatchObject({
      modelRuntimeId: 'opaque-quality',
      acceleratorProfileLabel: 'Image2Video LightX2V 4 Steps',
      available: false,
    });
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

  it('derives main-checkpoint FP8 without inheriting text-encoder INT8/BF16', () => {
    const capability = buildWanGPModelCapability({
      raw: {
        model_type: 'opaque-enhanced',
        name: 'Wan2.2 Image2video Enhanced Lightning v2 14B',
        availability: {status: 'missing'},
        capabilities: {image_to_video: true},
      },
      schema: {model_def: {
        URLs: ['https://example.invalid/wan22EnhancedLightning_v2I2VFP8HIGH.safetensors'],
        URLs2: ['https://example.invalid/wan22EnhancedLightning_v2I2VFP8LOW.safetensors'],
        text_encoder_URLs: [
          'https://example.invalid/models_t5_umt5-xxl-enc-quanto_int8.safetensors',
          'https://example.invalid/models_t5_umt5-xxl-enc-bf16.safetensors',
        ],
      }},
      defaultSettings: {num_inference_steps: 4, guidance_scale: 1},
    });

    expect(capability?.quantization).toEqual(['fp8']);
    expect(capability?.tags).toContain('fp8');
    expect(capability?.tags).not.toContain('int8');
    expect(capability?.tags).not.toContain('bf16');
  });

  it('does not confuse 13B/15B labels with 1.3B/5B tags', () => {
    const thirteen = model({runtimeModelId: 'thirteen', name: 'Hunyuan Image2video 13B'});
    const fifteen = model({runtimeModelId: 'fifteen', name: 'Magi Human 15B'});

    expect(thirteen.tags).not.toContain('one-point-three-billion');
    expect(fifteen.tags).not.toContain('five-billion');
  });
});

import {describe, expect, it} from 'vitest';
import {detectLocalGenerationCapability} from '../src/validation/capability';
import {
  getVideoGenerationPreset,
  listVideoGenerationPresets,
  LOCAL_I2V_FAST_PORTRAIT_ID,
  LOCAL_I2V_QUALITY_PORTRAIT_ID,
} from '../src/presets/index';

describe('video generation presets', () => {
  it('keeps the two public preset IDs and Phase A dimensions stable', () => {
    expect(listVideoGenerationPresets()).toEqual([
      expect.objectContaining({
        id: LOCAL_I2V_FAST_PORTRAIT_ID,
        width: 480,
        height: 832,
        fps: 24,
        frameCount: 81,
        candidateCount: 2,
        qualityTier: 'preview',
      }),
      expect.objectContaining({
        id: LOCAL_I2V_QUALITY_PORTRAIT_ID,
        width: 480,
        height: 832,
        fps: 24,
        frameCount: 81,
        candidateCount: 2,
        qualityTier: 'quality',
      }),
    ]);
    expect(getVideoGenerationPreset('backend-model-name')).toBeNull();
  });
});

describe('detectLocalGenerationCapability', () => {
  it('uses the largest NVIDIA GPU and gives conservative 8GB advice', async () => {
    const capability = await detectLocalGenerationCapability({
      providerAvailable: true,
      installedModels: ['wan-i2v-quantized'],
      totalMemoryBytes: 32 * 1024 ** 3,
      runNvidiaSmi: async (executable, args) => {
        expect(executable).toBe('nvidia-smi');
        expect(args).toEqual(['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']);
        return {stdout: 'NVIDIA RTX A2000, 6144\r\nNVIDIA GeForce RTX 3060 Ti, 8192\r\n'};
      },
    });

    expect(capability).toMatchObject({
      gpuName: 'NVIDIA GeForce RTX 3060 Ti',
      vramMb: 8192,
      ramMb: 32768,
      cudaAvailable: true,
      providerAvailable: true,
      installedModels: ['wan-i2v-quantized'],
      recommendedPresets: [LOCAL_I2V_FAST_PORTRAIT_ID],
    });
    expect(capability.warnings.join(' ')).toContain('concurrency at 1');
    expect(capability.warnings.join(' ')).toContain('hints only');
  });

  it('does not recommend a preset when CUDA, provider, or installed models are unconfirmed', async () => {
    const capability = await detectLocalGenerationCapability({
      providerAvailable: false,
      providerReason: 'service is not running',
      totalMemoryBytes: 16 * 1024 ** 3,
      runNvidiaSmi: async () => { throw new Error('ENOENT'); },
    });

    expect(capability).toMatchObject({
      cudaAvailable: false,
      providerAvailable: false,
      installedModels: [],
      recommendedPresets: [],
    });
    expect(capability.warnings.join(' ')).toContain('service is not running');
    expect(capability.warnings.join(' ')).toContain('No installed video model');
    expect(capability.warnings.join(' ')).toContain('16 GB');
  });

  it('only suggests the quality preset on a higher-memory confirmed setup', async () => {
    const capability = await detectLocalGenerationCapability({
      providerAvailable: true,
      installedModels: ['local-model'],
      totalMemoryBytes: 64 * 1024 ** 3,
      runNvidiaSmi: async () => ({stdout: 'NVIDIA GeForce RTX 4090, 24564\n'}),
    });

    expect(capability.recommendedPresets).toEqual([
      LOCAL_I2V_FAST_PORTRAIT_ID,
      LOCAL_I2V_QUALITY_PORTRAIT_ID,
    ]);
  });

  it('does not confuse nvidia-smi visibility with a working WanGP CUDA runtime', async () => {
    const capability = await detectLocalGenerationCapability({
      providerAvailable: true,
      installedModels: ['fun_inp_1.3B'],
      cudaRuntimeAvailable: false,
      cudaRuntimeReason: 'driver is too old for CUDA 13.0',
      totalMemoryBytes: 32 * 1024 ** 3,
      runNvidiaSmi: async () => ({stdout: 'NVIDIA GeForce RTX 3060 Ti, 8192\n'}),
    });

    expect(capability.cudaAvailable).toBe(false);
    expect(capability.recommendedPresets).toEqual([]);
    expect(capability.warnings.join(' ')).toContain('driver is too old');
  });
});

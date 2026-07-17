import {execFile} from 'node:child_process';
import os from 'node:os';
import {promisify} from 'node:util';
import {
  LOCAL_I2V_FAST_PORTRAIT_ID,
  LOCAL_I2V_QUALITY_PORTRAIT_ID,
} from '../presets/index';

export type LocalGenerationCapability = {
  gpuName?: string;
  vramMb?: number;
  ramMb?: number;
  cudaAvailable: boolean;
  providerAvailable: boolean;
  installedModels: string[];
  recommendedPresets: string[];
  warnings: string[];
};

export type NvidiaSmiResult = {
  stdout: string;
  stderr?: string;
};

export type LocalCapabilityDetectionOptions = {
  providerAvailable: boolean;
  installedModels?: readonly string[];
  providerReason?: string;
  cudaRuntimeAvailable?: boolean;
  cudaRuntimeReason?: string;
  nvidiaSmiPath?: string;
  totalMemoryBytes?: number;
  runNvidiaSmi?: (executable: string, args: readonly string[]) => Promise<NvidiaSmiResult>;
};

const execFileAsync = promisify(execFile);

const defaultNvidiaSmiRunner = async (executable: string, args: readonly string[]): Promise<NvidiaSmiResult> => {
  const result = await execFileAsync(executable, [...args], {
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  return {stdout: result.stdout, stderr: result.stderr};
};

type GpuInfo = {name: string; vramMb: number};

const parseNvidiaSmi = (stdout: string): GpuInfo[] => stdout
  .split(/\r?\n/u)
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => {
    const separator = line.lastIndexOf(',');
    if (separator < 1) return null;
    const name = line.slice(0, separator).trim();
    const vramMb = Number.parseInt(line.slice(separator + 1).trim(), 10);
    return name && Number.isFinite(vramMb) && vramMb > 0 ? {name, vramMb} : null;
  })
  .filter((gpu): gpu is GpuInfo => gpu !== null);

const uniqueSorted = (values: readonly string[]): string[] =>
  [...new Set(values.filter((value) => value.trim().length > 0))].sort((left, right) => left.localeCompare(right));

export const detectLocalGenerationCapability = async (
  options: LocalCapabilityDetectionOptions,
): Promise<LocalGenerationCapability> => {
  const warnings: string[] = [];
  const installedModels = uniqueSorted(options.installedModels ?? []);
  const ramMb = Math.round((options.totalMemoryBytes ?? os.totalmem()) / 1024 / 1024);
  let selectedGpu: GpuInfo | undefined;

  try {
    const result = await (options.runNvidiaSmi ?? defaultNvidiaSmiRunner)(
      options.nvidiaSmiPath ?? 'nvidia-smi',
      ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'],
    );
    selectedGpu = parseNvidiaSmi(result.stdout)
      .sort((left, right) => right.vramMb - left.vramMb)[0];
    if (!selectedGpu) warnings.push('nvidia-smi returned no usable NVIDIA GPU memory information.');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`CUDA capability could not be confirmed with nvidia-smi: ${message}`);
  }

  const cudaAvailable = selectedGpu !== undefined && options.cudaRuntimeAvailable !== false;
  const vramMb = selectedGpu?.vramMb;
  if (selectedGpu !== undefined && options.cudaRuntimeAvailable === false) {
    warnings.push(options.cudaRuntimeReason
      ? `WanGP CUDA runtime is unavailable: ${options.cudaRuntimeReason}`
      : 'WanGP CUDA runtime is unavailable even though nvidia-smi can see the GPU.');
  }
  if (!options.providerAvailable) {
    warnings.push(options.providerReason
      ? `Local video provider is unavailable: ${options.providerReason}`
      : 'Local video provider is unavailable. Start and configure it before generation.');
  }
  if (installedModels.length === 0) {
    warnings.push('No installed video model was reported by the local provider. Preset compatibility is unknown.');
  }
  if (ramMb < 24 * 1024) {
    warnings.push(`System RAM is ${Math.round(ramMb / 1024)} GB; local video generation may exhaust memory or page heavily.`);
  }
  if (vramMb !== undefined && vramMb < 8 * 1024) {
    warnings.push(`GPU VRAM is ${Math.round(vramMb / 1024)} GB; even the 480x832 preview preset may fail with the installed model.`);
  } else if (vramMb !== undefined && vramMb < 12 * 1024) {
    warnings.push(`GPU VRAM is ${Math.round(vramMb / 1024)} GB; keep generation concurrency at 1 and verify the provider's quantized/offload preset.`);
  }

  const recommendedPresets: string[] = [];
  const providerReady = options.providerAvailable && cudaAvailable && installedModels.length > 0;
  if (providerReady && vramMb !== undefined && vramMb >= 8 * 1024) {
    recommendedPresets.push(LOCAL_I2V_FAST_PORTRAIT_ID);
  }
  if (providerReady && vramMb !== undefined && vramMb >= 12 * 1024) {
    recommendedPresets.push(LOCAL_I2V_QUALITY_PORTRAIT_ID);
  }
  if (recommendedPresets.length > 0) {
    warnings.push('Preset recommendations are conservative hints only; the provider must still validate the installed model before submission.');
  }

  return {
    ...(selectedGpu ? {gpuName: selectedGpu.name, vramMb: selectedGpu.vramMb} : {}),
    ramMb,
    cudaAvailable,
    providerAvailable: options.providerAvailable,
    installedModels,
    recommendedPresets,
    warnings,
  };
};

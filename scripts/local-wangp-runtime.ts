import {execFile} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {promisify} from 'node:util';
import {
  buildLocalOnlyWanGPEnvironment,
  WanGPMcpTransport,
  type WanGPMcpClient,
} from '@gen-video-tool/video-generation';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, '..');

const firstExistingFile = (candidates: readonly string[]): string | null =>
  candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) ?? null;

const resolveWanGPRoot = (): string | null => {
  const userProfile = process.env.USERPROFILE?.trim();
  const localAppData = process.env.LOCALAPPDATA?.trim();
  const repositoryDriveRoot = path.parse(repositoryRoot).root;
  const candidates = [
    process.env.WANGP_ROOT,
    path.resolve(repositoryRoot, '..', '.tools', 'WanGP'),
    path.resolve(repositoryRoot, '..', '.research', 'Wan2GP'),
    path.resolve(repositoryRoot, '..', 'WanGP'),
    path.resolve(repositoryRoot, 'WanGP'),
    path.join(repositoryDriveRoot, 'WanGP'),
    userProfile ? path.join(userProfile, 'WanGP') : undefined,
    localAppData ? path.join(localAppData, 'WanGP') : undefined,
  ].filter((candidate): candidate is string => Boolean(candidate));

  return candidates
    .map((candidate) => path.resolve(candidate))
    .find((candidate) => fs.existsSync(path.join(candidate, 'wgp.py'))) ?? null;
};

export type LocalWanGPRuntime = {
  transport: WanGPMcpClient;
  mode: 'streamable-http' | 'stdio';
  root?: string;
  pythonExecutable?: string;
};

export type WanGPCudaProbe = {
  available: boolean;
  reason?: string;
  torchVersion?: string;
  cudaRuntime?: string;
  gpuName?: string;
};

export const probeWanGPCudaRuntime = async (pythonExecutable?: string): Promise<WanGPCudaProbe> => {
  if (!pythonExecutable) {
    return {available: false, reason: 'WanGP Python environment was not found.'};
  }
  const code = [
    'import json, torch',
    'available = bool(torch.cuda.is_available())',
    'result = {"available": available, "torchVersion": torch.__version__, "cudaRuntime": torch.version.cuda}',
    'if available:',
    '    x = torch.ones(1024, device="cuda")',
    '    y = (x * 2).sum()',
    '    torch.cuda.synchronize()',
    '    result["gpuName"] = torch.cuda.get_device_name(0)',
    '    result["kernelResult"] = float(y.item())',
    'print(json.dumps(result))',
  ].join('\n');
  try {
    const result = await execFileAsync(pythonExecutable, ['-B', '-c', code], {
      encoding: 'utf8',
      timeout: 60_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    const available = parsed.available === true && parsed.kernelResult === 2048;
    return {
      available,
      ...(typeof parsed.torchVersion === 'string' ? {torchVersion: parsed.torchVersion} : {}),
      ...(typeof parsed.cudaRuntime === 'string' ? {cudaRuntime: parsed.cudaRuntime} : {}),
      ...(typeof parsed.gpuName === 'string' ? {gpuName: parsed.gpuName} : {}),
      ...(available ? {} : {reason: 'torch.cuda.is_available() or the real CUDA kernel test failed.'}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {available: false, reason: message.slice(0, 2_000)};
  }
};

const assertLocalEndpoint = (endpoint: string): void => {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error('WANGP_MCP_URL_INVALID');
  }
  const host = url.hostname.toLowerCase();
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1' && host !== '[::1]') {
    throw new Error(`WANGP_REMOTE_ENDPOINT_FORBIDDEN:${host}`);
  }
};

export const createLocalWanGPRuntime = (rawOutputDirectory: string): LocalWanGPRuntime => {
  const endpoint = process.env.WANGP_MCP_URL?.trim();
  if (endpoint) {
    assertLocalEndpoint(endpoint);
    return {
      mode: 'streamable-http',
      transport: new WanGPMcpTransport({
        kind: 'streamable-http',
        endpoint,
        connectTimeoutMs: 60_000,
        requestTimeoutMs: 10 * 60_000,
      }),
    };
  }

  const root = resolveWanGPRoot();
  if (!root) {
    throw new Error(
      'WANGP_ROOT_NOT_FOUND:set WANGP_ROOT to an official WanGP checkout with MCP support or set WANGP_MCP_URL',
    );
  }
  const pythonExecutable = process.env.WANGP_PYTHON?.trim() || firstExistingFile([
    path.join(root, 'env_conda', 'python.exe'),
    path.join(root, 'env_venv', 'Scripts', 'python.exe'),
    path.join(root, '.venv', 'Scripts', 'python.exe'),
    path.join(root, 'venv', 'Scripts', 'python.exe'),
  ]) || 'python';
  const cacheRoot = path.resolve(
    process.env.WANGP_CACHE_ROOT?.trim() || path.join(repositoryRoot, '..', '.cache', 'wangp'),
  );

  return {
    mode: 'stdio',
    root,
    pythonExecutable,
    transport: new WanGPMcpTransport({
      kind: 'stdio',
      wanGpDirectory: root,
      pythonExecutable,
      connectTimeoutMs: 10 * 60_000,
      requestTimeoutMs: 10 * 60_000,
      extraArguments: [
        '--output-dir', path.resolve(rawOutputDirectory),
        '--profile', process.env.WANGP_PROFILE?.trim() || '4',
        '--attention', process.env.WANGP_ATTENTION?.trim() || 'auto',
      ],
      environment: buildLocalOnlyWanGPEnvironment(cacheRoot),
    }),
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export type DiscoveredWanGPModel = {
  modelType: string;
  label: string;
  availability: 'available' | 'partial' | 'missing' | 'unknown';
};

const parseAvailability = (value: unknown): DiscoveredWanGPModel['availability'] => {
  if (typeof value === 'string' && ['available', 'partial', 'missing'].includes(value)) {
    return value as DiscoveredWanGPModel['availability'];
  }
  if (isRecord(value)) {
    if (typeof value.status === 'string') return parseAvailability(value.status);
    if (value.available === true) return 'available';
    if (value.available === false) return 'missing';
  }
  return 'unknown';
};

export const discoverWanGPI2VModels = async (
  transport: WanGPMcpClient,
): Promise<DiscoveredWanGPModel[]> => {
  const response = await transport.callTool<unknown>('wangp_list_models', {
    main_output: 'video',
    inputs: 'image',
    include_availability: true,
  });
  const rawModels = Array.isArray(response)
    ? response
    : isRecord(response) && Array.isArray(response.models) ? response.models : [];
  return rawModels.filter(isRecord).flatMap((model) => {
    const modelType = model.model_type ?? model.modelType ?? model.id;
    if (typeof modelType !== 'string' || !modelType) return [];
    const label = typeof model.name === 'string'
      ? model.name
      : typeof model.label === 'string' ? model.label : modelType;
    return [{
      modelType,
      label,
      availability: parseAvailability(model.availability ?? model.status),
    }];
  });
};

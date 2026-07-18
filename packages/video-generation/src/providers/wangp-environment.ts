import path from 'node:path';

/**
 * WanGP is a local runtime. Missing weights must fail visibly instead of
 * silently reaching Hugging Face, W&B, or another network service.
 */
export const buildLocalOnlyWanGPEnvironment = (
  cacheRootValue: string,
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv => {
  const cacheRoot = path.resolve(cacheRootValue);
  return {
    ...inherited,
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    HF_HOME: cacheRoot,
    HUGGINGFACE_HUB_CACHE: path.join(cacheRoot, 'hub'),
    TORCH_HOME: path.join(cacheRoot, 'torch'),
    TRITON_CACHE_DIR: path.join(cacheRoot, 'triton'),
    TORCHINDUCTOR_CACHE_DIR: path.join(cacheRoot, 'torchinductor'),
    CUDA_CACHE_PATH: path.join(cacheRoot, 'cuda'),
    XDG_CACHE_HOME: path.join(cacheRoot, 'xdg'),
    HF_HUB_OFFLINE: '1',
    TRANSFORMERS_OFFLINE: '1',
    HF_DATASETS_OFFLINE: '1',
    WANDB_MODE: 'offline',
  };
};

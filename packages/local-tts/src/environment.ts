import fs from 'node:fs/promises';
import path from 'node:path';

import {assertAbsoluteLocalPath} from './local-path';

export type PrepareLocalF5TtsEnvironmentOptions = {
  readonly cacheRoot: string;
  readonly ffmpegDirectory?: string;
  readonly inheritedPath?: string;
  readonly offline?: boolean;
};

/**
 * Prepare writable caches for libraries imported by F5-TTS.
 *
 * Numba otherwise tries to cache compiled librosa helpers beside the installed
 * package. That location is commonly read-only in packaged apps and sandboxes;
 * Python's tempfile retry loop can then look like a hung model load for many
 * minutes. All mutable runtime state is kept below the project-owned cache.
 */
export async function prepareLocalF5TtsEnvironment(
  options: PrepareLocalF5TtsEnvironmentOptions,
): Promise<Readonly<NodeJS.ProcessEnv>> {
  const cacheRoot = assertAbsoluteLocalPath(options.cacheRoot, 'cacheRoot');
  const numbaCache = path.join(cacheRoot, 'numba');
  const matplotlibCache = path.join(cacheRoot, 'matplotlib');
  await Promise.all([
    fs.mkdir(numbaCache, {recursive: true}),
    fs.mkdir(matplotlibCache, {recursive: true}),
  ]);

  const ffmpegDirectory = options.ffmpegDirectory === undefined
    ? undefined
    : assertAbsoluteLocalPath(options.ffmpegDirectory, 'ffmpegDirectory');
  const inheritedPath = options.inheritedPath ?? process.env.PATH ?? '';
  return {
    NUMBA_CACHE_DIR: numbaCache,
    MPLCONFIGDIR: matplotlibCache,
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    ...(options.offline === false
      ? {}
      : {
          HF_HUB_OFFLINE: '1',
          TRANSFORMERS_OFFLINE: '1',
        }),
    ...(ffmpegDirectory === undefined
      ? {}
      : {PATH: [ffmpegDirectory, inheritedPath].filter(Boolean).join(path.delimiter)}),
  };
}

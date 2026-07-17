import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {assertAbsoluteLocalPath} from './local-path';
import {LocalTtsError, type LocalF5TtsInstallation} from './types';

export type LocalF5TtsDiscoveryOptions = {
  readonly cliPath?: string;
  readonly pythonPath?: string;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly platform?: NodeJS.Platform;
  readonly fileExists?: (filePath: string) => Promise<boolean>;
};

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
};

function deriveEnvironmentPython(cliPath: string, platform: NodeJS.Platform): string | null {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const parent = pathApi.dirname(cliPath);
  if (pathApi.basename(parent).toLowerCase() !== (platform === 'win32' ? 'scripts' : 'bin')) {
    return null;
  }
  return pathApi.join(pathApi.dirname(parent), platform === 'win32' ? 'python.exe' : 'python');
}

function deriveEnvironmentCli(pythonPath: string, platform: NodeJS.Platform): string {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  return pathApi.join(
    pathApi.dirname(pythonPath),
    platform === 'win32' ? 'Scripts' : 'bin',
    platform === 'win32' ? 'f5-tts_infer-cli.exe' : 'f5-tts_infer-cli',
  );
}

function autoDiscoveryEnvironmentRoots(
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
): string[] {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const environmentName = environment.F5_TTS_ENV_NAME?.trim() || 'allhow-f5tts';
  const roots: string[] = [];
  const addCondaRoot = (candidate: string | undefined): void => {
    const value = candidate?.trim();
    if (!value || !pathApi.isAbsolute(value)) return;
    roots.push(value, pathApi.join(value, 'envs', environmentName));
  };

  addCondaRoot(environment.CONDA_PREFIX);
  const condaExecutable = environment.CONDA_EXE?.trim();
  if (condaExecutable && pathApi.isAbsolute(condaExecutable)) {
    const executableDirectory = pathApi.dirname(condaExecutable);
    addCondaRoot(
      pathApi.basename(executableDirectory).toLowerCase() === 'scripts'
        ? pathApi.dirname(executableDirectory)
        : executableDirectory,
    );
  }

  const home = environment.USERPROFILE?.trim() || environment.HOME?.trim();
  if (home && pathApi.isAbsolute(home)) {
    roots.push(
      pathApi.join(home, '.conda', 'envs', environmentName),
      pathApi.join(home, 'miniconda3', 'envs', environmentName),
      pathApi.join(home, 'anaconda3', 'envs', environmentName),
    );
  }
  const localAppData = environment.LOCALAPPDATA?.trim();
  if (localAppData && pathApi.isAbsolute(localAppData)) {
    roots.push(pathApi.join(localAppData, 'miniconda3', 'envs', environmentName));
  }
  return [...new Set(roots.map((root) => pathApi.normalize(root)))];
}

export async function discoverLocalF5Tts(
  options: LocalF5TtsDiscoveryOptions = {},
): Promise<LocalF5TtsInstallation> {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const exists = options.fileExists ?? fileExists;

  const hasExplicit = options.cliPath !== undefined || options.pythonPath !== undefined;
  const hasEnvironment = environment.F5_TTS_CLI !== undefined || environment.F5_TTS_PYTHON !== undefined;
  if (!hasExplicit && !hasEnvironment) {
    const pathApi = platform === 'win32' ? path.win32 : path.posix;
    for (const environmentRoot of autoDiscoveryEnvironmentRoots(environment, platform)) {
      const pythonPath = pathApi.join(environmentRoot, platform === 'win32' ? 'python.exe' : 'bin/python');
      const cliPath = deriveEnvironmentCli(pythonPath, platform);
      if (await exists(cliPath) && await exists(pythonPath)) {
        return {
          cliPath,
          pythonPath,
          source: 'auto-discovery',
          pythonWasDerived: true,
        };
      }
    }
    throw new LocalTtsError(
      'LOCAL_TTS_F5_CLI_NOT_FOUND',
      'F5-TTS is not configured. Set absolute F5_TTS_CLI and F5_TTS_PYTHON paths.',
      {details: {platform}},
    );
  }

  const source = hasExplicit ? 'explicit' : 'environment';

  const configuredPython = options.pythonPath ?? environment.F5_TTS_PYTHON;
  const rawCli = options.cliPath ?? environment.F5_TTS_CLI ??
    (configuredPython === undefined ? '' : deriveEnvironmentCli(configuredPython, platform));
  if (rawCli === '') {
    throw new LocalTtsError(
      'LOCAL_TTS_F5_CLI_NOT_FOUND',
      'Unable to derive the F5-TTS CLI; set F5_TTS_CLI explicitly.',
      {details: {source}},
    );
  }
  const cliPath = assertAbsoluteLocalPath(rawCli, 'F5_TTS_CLI');
  if (!(await exists(cliPath))) {
    throw new LocalTtsError('LOCAL_TTS_F5_CLI_NOT_FOUND', `F5-TTS CLI does not exist: ${cliPath}`, {
      details: {cliPath, source},
    });
  }

  const derivedPython = configuredPython === undefined ? deriveEnvironmentPython(cliPath, platform) : null;
  const rawPython = configuredPython ?? derivedPython ?? '';
  if (rawPython === '') {
    throw new LocalTtsError(
      'LOCAL_TTS_PYTHON_NOT_FOUND',
      'Unable to derive the F5-TTS Python executable; set F5_TTS_PYTHON explicitly.',
      {details: {cliPath, source}},
    );
  }
  const pythonPath = assertAbsoluteLocalPath(rawPython, 'F5_TTS_PYTHON');
  if (!(await exists(pythonPath))) {
    throw new LocalTtsError('LOCAL_TTS_PYTHON_NOT_FOUND', `F5-TTS Python does not exist: ${pythonPath}`, {
      details: {pythonPath, source},
    });
  }

  return {
    cliPath,
    pythonPath,
    source,
    pythonWasDerived: configuredPython === undefined && derivedPython !== null,
  };
}

export function resolveBundledF5CompatWrapperPath(): string {
  return fileURLToPath(new URL('../scripts/f5_tts_cli_compat.py', import.meta.url));
}

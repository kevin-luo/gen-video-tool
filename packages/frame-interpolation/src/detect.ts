import fs from 'node:fs';
import path from 'node:path';

export type RifeDetection = {
  available: boolean;
  executable?: string;
  source?: 'environment' | 'configured' | 'bundled' | 'path';
};

const validFile = (candidate: string | undefined): candidate is string =>
  Boolean(candidate && path.isAbsolute(candidate) && fs.existsSync(candidate) && fs.statSync(candidate).isFile());

export const detectRife = (
  options: {configuredPath?: string; bundledCandidates?: string[]} = {},
): RifeDetection => {
  if (validFile(process.env.RIFE_PATH)) return {available: true, executable: process.env.RIFE_PATH, source: 'environment'};
  if (validFile(options.configuredPath)) return {available: true, executable: options.configuredPath, source: 'configured'};
  for (const candidate of options.bundledCandidates ?? []) {
    if (validFile(candidate)) return {available: true, executable: candidate, source: 'bundled'};
  }
  const executableName = process.platform === 'win32' ? 'rife.exe' : 'rife';
  for (const entry of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.resolve(entry, executableName);
    if (validFile(candidate)) return {available: true, executable: candidate, source: 'path'};
  }
  return {available: false};
};

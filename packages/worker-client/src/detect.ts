import fs from 'node:fs';
import path from 'node:path';

export type LocalToolKind = 'godot' | 'rife' | 'ffmpeg' | 'ffprobe';

export type ToolDetection = {
  kind: LocalToolKind;
  available: boolean;
  executable?: string;
  source?: 'environment' | 'configured' | 'bundled' | 'path';
};

const executableName = (kind: LocalToolKind) => process.platform === 'win32' ? `${kind}.exe` : kind;

const validFile = (candidate: string | undefined): candidate is string =>
  Boolean(candidate && path.isAbsolute(candidate) && fs.existsSync(candidate) && fs.statSync(candidate).isFile());

export const detectLocalTool = (
  kind: LocalToolKind,
  options: {configuredPath?: string; bundledCandidates?: string[]} = {},
): ToolDetection => {
  const environmentKey = `${kind.toUpperCase()}_PATH`;
  const environmentPath = process.env[environmentKey];
  if (validFile(environmentPath)) return {kind, available: true, executable: environmentPath, source: 'environment'};
  if (validFile(options.configuredPath)) return {kind, available: true, executable: options.configuredPath, source: 'configured'};
  for (const candidate of options.bundledCandidates ?? []) {
    if (validFile(candidate)) return {kind, available: true, executable: candidate, source: 'bundled'};
  }
  const pathEntries = (process.env.PATH ?? '').split(path.delimiter);
  for (const entry of pathEntries) {
    const candidate = path.resolve(entry, executableName(kind));
    if (validFile(candidate)) return {kind, available: true, executable: candidate, source: 'path'};
  }
  return {kind, available: false};
};

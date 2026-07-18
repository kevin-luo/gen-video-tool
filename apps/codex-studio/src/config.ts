import {existsSync} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';

export interface StudioConfig {
  repositoryRoot: string;
  dataRoot: string;
  projectsRoot: string;
  outputRoot: string;
  jobsFile: string;
  host: '127.0.0.1';
  port: number;
  baseUrl: string;
  sessionToken: string;
}

const readPort = (value: string | undefined): number => {
  const port = Number(value ?? 4390);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    throw new Error('GEN_VIDEO_STUDIO_PORT_INVALID');
  }
  return port;
};

const defaultDataRoot = (repositoryRoot: string): string => {
  if (existsSync(path.join(repositoryRoot, '.git'))) return path.join(repositoryRoot, '.desktop-data');
  return path.join(homedir(), '.gen-video-tool');
};

export const createStudioConfig = (): StudioConfig => {
  const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
  const dataRoot = path.resolve(
    process.env.GEN_VIDEO_STUDIO_HOME?.trim()
      || process.env.GEN_VIDEO_DESKTOP_DATA_ROOT?.trim()
      || defaultDataRoot(repositoryRoot),
  );
  const projectsRoot = path.resolve(process.env.GEN_VIDEO_PROJECTS_ROOT?.trim() || path.join(dataRoot, 'projects'));
  const outputRoot = path.resolve(process.env.GEN_VIDEO_OUTPUT_ROOT?.trim() || path.join(dataRoot, 'output'));
  const port = readPort(process.env.GEN_VIDEO_STUDIO_PORT);
  const sessionToken = process.env.GEN_VIDEO_STUDIO_TOKEN?.trim();
  if (!sessionToken || sessionToken.length < 32) throw new Error('GEN_VIDEO_STUDIO_TOKEN_REQUIRED');
  return {
    repositoryRoot,
    dataRoot,
    projectsRoot,
    outputRoot,
    jobsFile: path.join(dataRoot, 'codex-studio-jobs.json'),
    host: '127.0.0.1',
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    sessionToken,
  };
};

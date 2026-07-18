import fs from 'node:fs/promises';
import path from 'node:path';

import {
  importAssetPack,
  inspectAssetPack,
  loadProjectDirectory,
  projectDurationSeconds,
  type AssetPackSource,
} from '@gen-video-tool/asset-pack';
import {
  loadProductionState,
  type ProductionState,
} from '@gen-video-tool/video-generation';

import type {StudioConfig} from './config.js';
import {assertSafeId, resolveInside} from './path-safety.js';

const sourceFromPath = async (sourcePathValue: string): Promise<AssetPackSource> => {
  const sourcePath = path.resolve(sourcePathValue);
  const info = await fs.lstat(sourcePath);
  if (info.isSymbolicLink()) throw new Error('SOURCE_SYMLINK');
  if (info.isDirectory()) return {kind: 'directory', path: sourcePath};
  if (info.isFile() && path.extname(sourcePath).toLowerCase() === '.zip') return {kind: 'zip', path: sourcePath};
  throw new Error('SOURCE_FILE_UNSUPPORTED');
};

const loadState = async (projectRoot: string): Promise<ProductionState | null> => {
  try {
    return await loadProductionState(projectRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
};

export class ProjectService {
  constructor(private readonly config: StudioConfig) {}

  async initialize(): Promise<void> {
    await fs.mkdir(this.config.projectsRoot, {recursive: true});
    await fs.mkdir(this.config.outputRoot, {recursive: true});
  }

  projectRoot(projectIdValue: string): string {
    return path.join(this.config.projectsRoot, assertSafeId(projectIdValue, 'PROJECT_ID'));
  }

  async listProjects() {
    await this.initialize();
    const entries = await fs.readdir(this.config.projectsRoot, {withFileTypes: true});
    const projects = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !SAFE_DIRECTORY_NAME.test(entry.name)) continue;
      const projectRoot = this.projectRoot(entry.name);
      try {
        const [plan, state, info] = await Promise.all([
          loadProjectDirectory(projectRoot),
          loadState(projectRoot),
          fs.stat(path.join(projectRoot, 'production.json')),
        ]);
        projects.push({
          projectId: entry.name,
          productionProjectId: plan.projectId,
          title: plan.metadata.title,
          locale: plan.metadata.locale,
          durationSeconds: projectDurationSeconds(plan),
          shotCount: plan.shots.length,
          generatedShotCount: plan.shots.filter((shot) => shot.kind === 'generated-performance').length,
          selectedShotCount: state?.shots.filter((shot) => shot.status === 'selected' || shot.status === 'complete').length ?? 0,
          narrationStatus: state?.narration.status ?? 'queued',
          updatedAt: state?.updatedAt ?? info.mtime.toISOString(),
        });
      } catch {
        // A directory is not a project until its immutable production plan validates.
      }
    }
    return projects.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async getProject(projectId: string) {
    const projectRoot = this.projectRoot(projectId);
    const [plan, state] = await Promise.all([loadProjectDirectory(projectRoot), loadState(projectRoot)]);
    return {projectRoot, plan, state};
  }

  async inspectPack(sourcePath: string) {
    return await inspectAssetPack({source: await sourceFromPath(sourcePath)});
  }

  async importPack(sourcePath: string, destinationName?: string) {
    await this.initialize();
    return await importAssetPack({
      source: await sourceFromPath(sourcePath),
      projectsRoot: this.config.projectsRoot,
      ...(destinationName?.trim() ? {destinationName: assertSafeId(destinationName.trim(), 'DESTINATION_NAME')} : {}),
    });
  }

  resolveProjectMedia(projectId: string, relativePath: string): string {
    return resolveInside(this.projectRoot(projectId), relativePath);
  }

  resolveOutputMedia(projectId: string, relativePath: string): string {
    const outputProjectRoot = path.join(this.config.outputRoot, assertSafeId(projectId, 'PROJECT_ID'));
    return resolveInside(outputProjectRoot, relativePath);
  }
}

const SAFE_DIRECTORY_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;

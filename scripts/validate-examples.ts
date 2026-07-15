import path from 'node:path';
import process from 'node:process';
import {inspectAssetPack} from '@gen-video-tool/asset-pack';
import {loadProjectDirectory} from './project-files';

const root = path.resolve(import.meta.dirname, '..');
const examples = ['football-history', 'quiet-story'] as const;
let failed = false;

for (const id of examples) {
  const sourcePath = path.join(root, 'examples', id);
  const inspection = await inspectAssetPack({source: {kind: 'directory', path: sourcePath}});
  const project = inspection.status === 'ready' ? await loadProjectDirectory(sourcePath) : null;
  const errors = inspection.diagnostics.filter((item) => item.severity === 'error');
  const warnings = inspection.diagnostics.filter((item) => item.severity === 'warning');
  const summary = {
    id,
    status: inspection.status,
    shots: project?.shots.length ?? 0,
    durationSeconds: inspection.videoDurationSeconds,
    audioDurationSeconds: inspection.audioDurationSeconds,
    files: inspection.fileCount,
    errors: errors.length,
    warnings: warnings.length,
  };
  console.log(JSON.stringify(summary));
  for (const issue of [...errors, ...warnings]) {
    console.log(`  ${issue.severity.toUpperCase()} ${issue.code} ${issue.assetPath ?? issue.path ?? ''}: ${issue.message}`);
  }
  if (inspection.status !== 'ready' || !project) failed = true;
}

if (failed) process.exitCode = 1;

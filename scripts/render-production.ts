import path from 'node:path';
import {renderProjectDirectory} from '@gen-video-tool/render-service';
import {withProductionRunLock} from '@gen-video-tool/video-generation';

const workspaceRoot = path.resolve(import.meta.dirname, '..');
const projectArgument = process.argv[2];

if (!projectArgument) {
  throw new Error('USAGE:npm run render:production -- <projectRoot> [outputRoot]');
}

const projectRoot = path.resolve(projectArgument);
const outputRoot = path.resolve(
  process.argv[3] ?? path.join(workspaceRoot, 'output', path.basename(projectRoot)),
);

const result = await withProductionRunLock(projectRoot, {kind: 'render'}, async () =>
  await renderProjectDirectory({
    projectRoot,
    outputRoot,
    workspaceRoot,
    onProgress: (phase, progress) => {
      process.stdout.write(`${JSON.stringify({event: 'render-progress', phase, progress: Number(progress.toFixed(4))})}\n`);
    },
  }));

process.stdout.write(`${JSON.stringify({
  event: 'render-complete',
  videoPath: result.videoPath,
  subtitlesPath: result.subtitlesPath,
  qaFramePaths: result.qaFramePaths,
  durationSeconds: result.durationSeconds,
}, null, 2)}\n`);

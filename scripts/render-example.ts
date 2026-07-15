import path from 'node:path';
import process from 'node:process';
import {inspectAssetPack} from '@gen-video-tool/asset-pack';
import {renderProjectDirectory} from '@gen-video-tool/render-service';

const root = path.resolve(import.meta.dirname, '..');
const id = process.argv[2];
if (!id || !['football-history', 'quiet-story'].includes(id)) {
  throw new Error('Usage: tsx scripts/render-example.ts <football-history|quiet-story>');
}
const sourceRoot = path.join(root, 'examples', id);
const inspection = await inspectAssetPack({source: {kind: 'directory', path: sourceRoot}});
const blocking = inspection.diagnostics.filter((issue) => issue.severity === 'error');
if (blocking.length) {
  throw new Error(`Asset pack rejected:\n${blocking.map((issue) => `${issue.code} ${issue.assetPath ?? issue.path ?? ''}: ${issue.message}`).join('\n')}`);
}
const outputRoot = path.join(root, 'output', id === 'quiet-story' ? 'story' : 'football');
let lastPrinted = -1;
const result = await renderProjectDirectory({
  projectRoot: sourceRoot,
  outputRoot,
  workspaceRoot: root,
  onProgress: (phase, progress) => {
    const percent = Math.floor(progress * 100);
    if (percent !== lastPrinted && percent % 10 === 0) {
      lastPrinted = percent;
      console.log(`${phase} ${percent}%`);
    }
  },
});
console.log(result.videoPath);
if (result.subtitlesPath) console.log(result.subtitlesPath);
console.log(`qa frames: ${result.qaFramePaths.length}`);

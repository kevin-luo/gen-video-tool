import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {renderProjectDirectory} from '@gen-video-tool/render-service';

const root = path.resolve(import.meta.dirname, '..');
const examplesRoot = path.join(root, 'examples');
const requested = process.argv.slice(2).filter((argument) => !argument.startsWith('--'));
const projectIds = requested.length ? requested : (await fs.readdir(examplesRoot, {withFileTypes: true}))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);
if (!projectIds.length) throw new Error('BATCH_EXPORT_NO_PROJECTS');

const startedAt = new Date().toISOString();
const results: Array<{projectId: string; status: 'complete' | 'failed'; videoPath?: string; error?: string}> = [];
for (const [index, projectId] of projectIds.entries()) {
  const projectRoot = path.join(examplesRoot, projectId);
  try {
    await fs.access(path.join(projectRoot, 'manifest.json'));
    let lastProgress = '';
    const result = await renderProjectDirectory({
      projectRoot,
      outputRoot: path.join(root, 'output', 'batch', projectId),
      workspaceRoot: root,
      onProgress: (phase, progress) => {
        const label = `[${index + 1}/${projectIds.length}] ${projectId} ${phase} ${Math.round(progress * 100)}%`;
        if (label === lastProgress) return;
        lastProgress = label;
        process.stdout.write(`\r${label}   `);
      },
    });
    process.stdout.write('\n');
    results.push({projectId, status: 'complete', videoPath: result.videoPath});
  } catch (reason) {
    process.stdout.write('\n');
    results.push({projectId, status: 'failed', error: reason instanceof Error ? reason.message : String(reason)});
  }
}
const report = {startedAt, completedAt: new Date().toISOString(), results};
const reportPath = path.join(root, 'output', 'batch', 'batch-export-report.json');
await fs.mkdir(path.dirname(reportPath), {recursive: true});
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(reportPath);
if (results.some((result) => result.status === 'failed')) process.exitCode = 1;

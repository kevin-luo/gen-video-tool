import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {importAssetPack, inspectAssetPack, type AssetPackSource} from '@gen-video-tool/asset-pack';
import {loadProductionPlan} from '@gen-video-tool/video-generation';

const [sourceValue, projectsRootValue, destinationName] = process.argv.slice(2);
if (!sourceValue || !projectsRootValue) {
  throw new Error(
    'Usage: npm run verify:asset-pack -- <pack.zip|pack-directory> <projects-root> [destination-name]',
  );
}

const sourcePath = path.resolve(sourceValue);
const projectsRoot = path.resolve(projectsRootValue);
const sourceStat = await fs.stat(sourcePath);
const source: AssetPackSource = sourceStat.isDirectory()
  ? {kind: 'directory', path: sourcePath}
  : {kind: 'zip', path: sourcePath};

const inspection = await inspectAssetPack({source});
if (inspection.status === 'rejected') {
  throw new Error(`ASSET_PACK_INSPECTION_REJECTED:${JSON.stringify(inspection.diagnostics)}`);
}

await fs.mkdir(projectsRoot, {recursive: true});
const imported = await importAssetPack({
  source,
  projectsRoot,
  ...(destinationName === undefined ? {} : {destinationName}),
});
if (imported.status !== 'committed' || !imported.projectPath || !imported.projectId) {
  throw new Error(`ASSET_PACK_IMPORT_REJECTED:${JSON.stringify(imported.diagnostics)}`);
}

const plan = await loadProductionPlan(imported.projectPath);
if (plan.projectId !== imported.projectId) throw new Error('ASSET_PACK_PROJECT_ID_MISMATCH');

process.stdout.write(`${JSON.stringify({
  inspection: {
    status: inspection.status,
    projectId: inspection.projectId,
    fileCount: inspection.fileCount,
    totalBytes: inspection.totalBytes,
  },
  import: {
    status: imported.status,
    projectId: imported.projectId,
    projectPath: imported.projectPath,
  },
  open: {
    title: plan.metadata.title,
    shots: plan.shots.length,
    networkPolicy: plan.networkPolicy,
  },
}, null, 2)}\n`);

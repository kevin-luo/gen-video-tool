import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {_electron as electron} from 'playwright';

const TERMINAL = new Set(['complete', 'failed', 'cancelled']);
const ALLOWED_TARGETS = new Set([
  'fun-inp-1.3b',
  'fastwan-5b',
  'enhanced-lightning-14b',
  'lightx2v-4step',
]);

const workspaceRoot = process.cwd();
const sourceProjectRoot = path.resolve(
  process.argv[2] ?? path.join(workspaceRoot, 'examples', 'cat-noodle-stall-v3'),
);
const targetId = process.argv[3] ?? 'fun-inp-1.3b';
const snapshotOnly = targetId === 'snapshot';
const dataRoot = path.resolve(
  process.env.GEN_VIDEO_BENCHMARK_DATA_ROOT
    ?? path.join(workspaceRoot, '.desktop-data', 'wangp-benchmark'),
);
const timeoutMs = Number(process.env.GEN_VIDEO_BENCHMARK_TIMEOUT_MS ?? 12 * 60 * 60_000);

if (!snapshotOnly && !ALLOWED_TARGETS.has(targetId)) {
  throw new Error(`WANGP_BENCHMARK_TARGET_INVALID:${targetId}`);
}
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  throw new Error('WANGP_BENCHMARK_TIMEOUT_INVALID');
}

const plan = JSON.parse(await fs.readFile(path.join(sourceProjectRoot, 'production.json'), 'utf8'));
if (typeof plan.projectId !== 'string' || !plan.projectId) {
  throw new Error('WANGP_BENCHMARK_PROJECT_ID_INVALID');
}
const projectId = plan.projectId;
const generatedShot = plan.shots?.find((shot) => shot?.kind === 'generated-performance');
if (!generatedShot?.shotId) throw new Error('WANGP_BENCHMARK_GENERATED_SHOT_MISSING');

const destinationProjectRoot = path.join(dataRoot, 'projects', projectId);
try {
  await fs.access(path.join(destinationProjectRoot, 'production.json'));
} catch {
  await fs.mkdir(path.dirname(destinationProjectRoot), {recursive: true});
  await fs.cp(sourceProjectRoot, destinationProjectRoot, {
    recursive: true,
    filter: (candidate) => {
      const relative = path.relative(sourceProjectRoot, candidate);
      return relative === '' || (!relative.startsWith(`generated${path.sep}`) && relative !== 'generated');
    },
  });
}

const stderr = [];
const rendererErrors = [];
let rendererCrashed = false;
const application = await electron.launch({
  args: ['.'],
  cwd: workspaceRoot,
  env: {
    ...process.env,
    GEN_VIDEO_DESKTOP_DATA_ROOT: dataRoot,
  },
  timeout: 30_000,
});
application.process().stderr?.on('data', (chunk) => stderr.push(String(chunk)));

try {
  const page = await application.firstWindow({timeout: 30_000});
  page.on('crash', () => { rendererCrashed = true; });
  page.on('pageerror', (error) => rendererErrors.push(error.message));
  await page.waitForLoadState('domcontentloaded');

  await page.evaluate(async (id) => await window.genVideoDesktop.openProject(id), projectId);
  const production = await page.evaluate(
    async (id) => await window.genVideoDesktop.detectProductionProvider(id),
    projectId,
  );
  if (production.provider?.available !== true) {
    throw new Error(`WANGP_PROVIDER_UNAVAILABLE:${production.provider?.reason ?? 'unknown'}`);
  }

  let snapshot = await page.evaluate(
    async (id) => await window.genVideoDesktop.getWanGPBenchmark(id),
    projectId,
  );
  if (snapshotOnly) {
    const selectedRuntimeIds = new Set([
      ...snapshot.entries.map((entry) => entry.modelRuntimeId),
      ...(production.provider?.catalog?.tiers ?? []).map((tier) => tier.modelRuntimeId),
    ].filter(Boolean));
    const selectedProfileIds = new Set([
      ...snapshot.entries.map((entry) => entry.acceleratorProfileId),
      ...(production.provider?.catalog?.tiers ?? []).map((tier) => tier.acceleratorProfileId),
    ].filter(Boolean));
    const capabilityEvidence = production.provider?.catalog?.models
      .filter((model) => selectedRuntimeIds.has(model.runtimeModelId))
      .map((model) => ({
        runtimeModelId: model.runtimeModelId,
        tags: model.tags,
        quantization: model.quantization,
        availability: model.availability,
        profileDirectories: model.profileDirectories,
        modelUrls: model.schema?.model_def?.URLs,
        modelUrls2: model.schema?.model_def?.URLs2,
        modules: model.schema?.model_def?.modules,
      }));
    const profileEvidence = production.provider?.catalog?.acceleratorProfiles
      .filter((profile) => selectedProfileIds.has(profile.id))
      .map((profile) => ({
        id: profile.id,
        directory: profile.directory,
        label: profile.label,
        tags: profile.tags,
        steps: profile.steps,
        acceleratorLoras: profile.acceleratorLoras,
      }));
    process.stdout.write(`${JSON.stringify({
      event: 'wangp-benchmark-snapshot',
      projectId,
      dataRoot,
      projectRoot: destinationProjectRoot,
      capabilityEvidence,
      profileEvidence,
      tiers: production.provider?.catalog?.tiers ?? [],
      snapshot,
      rendererCrashed,
      rendererErrors,
      stderr: stderr.join('').slice(-4_000),
    }, null, 2)}\n`);
  } else {
  const discovered = snapshot.entries.find((entry) => entry.targetId === targetId);
  if (!discovered?.discovered) {
    process.stdout.write(`${JSON.stringify({
      event: 'wangp-benchmark-unavailable',
      projectId,
      targetId,
      reason: 'No RTX 30-compatible MCP model metadata was discovered.',
      entry: discovered ?? null,
    }, null, 2)}\n`);
    process.exitCode = 2;
  } else {
    snapshot = await page.evaluate(
      async ({id, shotId, target}) => await window.genVideoDesktop.startWanGPBenchmark({
        projectId: id,
        shotId,
        targetId: target,
      }),
      {id: projectId, shotId: generatedShot.shotId, target: targetId},
    );
    const deadline = Date.now() + timeoutMs;
    let lastStatus = '';
    let lastLogAt = 0;
    while (true) {
      const entry = snapshot.entries.find((candidate) => candidate.targetId === targetId);
      if (!entry) throw new Error(`WANGP_BENCHMARK_ENTRY_MISSING:${targetId}`);
      const shouldLog = entry.status !== lastStatus || Date.now() - lastLogAt >= 15_000;
      if (shouldLog) {
        lastStatus = entry.status;
        lastLogAt = Date.now();
        process.stderr.write(`[wangp-benchmark:${targetId}] ${entry.status} ${JSON.stringify(entry.metrics ?? {})}\n`);
      }
      if (TERMINAL.has(entry.status) && snapshot.runningTargetId === undefined) {
        process.stdout.write(`${JSON.stringify({
          event: 'wangp-benchmark-complete',
          projectId,
          targetId,
          dataRoot,
          projectRoot: destinationProjectRoot,
          entry,
          contactSheetRelativePath: snapshot.contactSheetRelativePath ?? null,
          reportRelativePath: snapshot.reportRelativePath ?? null,
          rendererCrashed,
          rendererErrors,
          stderr: stderr.join('').slice(-4_000),
        }, null, 2)}\n`);
        if (entry.status !== 'complete' || rendererCrashed || rendererErrors.length > 0) {
          process.exitCode = 2;
        }
        break;
      }
      if (Date.now() >= deadline) {
        await page.evaluate(
          async (id) => await window.genVideoDesktop.cancelWanGPBenchmark(id),
          projectId,
        );
        throw new Error(`WANGP_BENCHMARK_TIMEOUT:${targetId}`);
      }
      await page.waitForTimeout(2_000);
      snapshot = await page.evaluate(
        async (id) => await window.genVideoDesktop.getWanGPBenchmark(id),
        projectId,
      );
    }
  }
  }
} finally {
  await application.close();
}

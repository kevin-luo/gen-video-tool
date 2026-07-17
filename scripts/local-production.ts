import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  FileVideoGenerationJobStore,
  WanGPProvider,
  acquireProductionRunLock,
  assertProductionStateMatchesPlan,
  beginProductionCandidate,
  completeProductionCandidate,
  createProductionState,
  detectLocalGenerationCapability,
  loadProductionPlan,
  loadProductionState,
  loadProductionStateForRestart,
  inspectProductionRunLock,
  normalizeVideo,
  parseProductionState,
  reviewProductionCandidate,
  selectProductionCandidate,
  writeProductionState,
  type CandidateTechnicalQa,
  type GeneratedPerformanceShot,
  type ProductionPlan,
  type ProductionState,
  type VideoGenerationJob,
  type VideoGenerationPreset,
  type VideoProbe,
} from '@gen-video-tool/video-generation';
import {
  createLocalWanGPRuntime,
  discoverWanGPI2VModels,
  probeWanGPCudaRuntime,
  type LocalWanGPRuntime,
} from './local-wangp-runtime';

const sleep = async (milliseconds: number): Promise<void> =>
  await new Promise((resolve) => setTimeout(resolve, milliseconds));

const sha256File = async (filePath: string): Promise<string> =>
  createHash('sha256').update(await fs.readFile(filePath)).digest('hex');

const isTerminal = (job: VideoGenerationJob): boolean =>
  job.status === 'complete' || job.status === 'failed' || job.status === 'cancelled';

const safeError = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, 4_000);

const resolveProjectAsset = (projectRoot: string, relativePath: string): string => {
  const root = path.resolve(projectRoot);
  const candidate = path.resolve(root, ...relativePath.split('/'));
  const relative = path.relative(root, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`LOCAL_PRODUCTION_PATH_OUTSIDE_PROJECT:${relativePath}`);
  }
  return candidate;
};

export const ensureLocalProductionState = async (
  projectRoot: string,
  plan: ProductionPlan,
  options: {ownsRunLock?: boolean} = {},
): Promise<ProductionState> => {
  let state: ProductionState;
  try {
    state = options.ownsRunLock === true
      ? await loadProductionState(projectRoot, {recoverInterrupted: true})
      : await loadProductionStateForRestart(projectRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    state = await writeProductionState(projectRoot, createProductionState(plan));
  }
  assertProductionStateMatchesPlan(state, plan);
  return state;
};

export const resolveLocalGenerationPreset = (
  shot: GeneratedPerformanceShot,
  presets: readonly VideoGenerationPreset[],
): VideoGenerationPreset => {
  const exact = presets.find((preset) => preset.id === shot.generation.preset.id);
  const compatible = exact ?? presets.find((preset) =>
    preset.qualityTier === shot.generation.preset.quality
    && preset.width === shot.generation.raster.width
    && preset.height === shot.generation.raster.height
    && preset.fps === shot.generation.timeline.fps
    && preset.frameCount === shot.generation.timeline.frameCount);
  if (!compatible) throw new Error(`WANGP_PRESET_UNAVAILABLE:${shot.generation.preset.id}`);
  if (
    compatible.width !== shot.generation.raster.width
    || compatible.height !== shot.generation.raster.height
    || compatible.fps !== shot.generation.timeline.fps
    || compatible.frameCount !== shot.generation.timeline.frameCount
  ) {
    throw new Error(`WANGP_PRESET_CONTRACT_MISMATCH:${compatible.id}`);
  }
  return compatible;
};

export const buildLocalCandidateTechnicalQa = (
  shot: GeneratedPerformanceShot,
  probe: VideoProbe,
  checkedAt = new Date().toISOString(),
): CandidateTechnicalQa => {
  const issues: string[] = [];
  const {raster, timeline} = shot.generation;
  if (probe.width !== raster.width || probe.height !== raster.height) {
    issues.push(`resolution expected ${raster.width}x${raster.height}, received ${probe.width}x${probe.height}`);
  }
  if (probe.fps === null || Math.abs(probe.fps - timeline.fps) > 0.01) {
    issues.push(`fps expected ${timeline.fps}, received ${probe.fps ?? 'unknown'}`);
  }
  if (probe.frameCount === null || probe.frameCount !== timeline.frameCount) {
    issues.push(`frameCount expected ${timeline.frameCount}, received ${probe.frameCount ?? 'unknown'}`);
  }
  if (probe.codecName !== 'h264') issues.push(`codec expected h264, received ${probe.codecName ?? 'unknown'}`);
  if (probe.pixelFormat !== 'yuv420p') {
    issues.push(`pixelFormat expected yuv420p, received ${probe.pixelFormat ?? 'unknown'}`);
  }
  if (probe.hasAudio) issues.push('generated performance candidate must be silent');
  return {
    result: issues.length === 0 ? 'pass' : 'fail',
    checkedAt,
    probe: {
      width: probe.width,
      height: probe.height,
      fps: probe.fps ?? timeline.fps,
      frameCount: probe.frameCount ?? timeline.frameCount,
      codec: probe.codecName ?? 'unknown',
      pixelFormat: probe.pixelFormat ?? 'unknown',
      hasAudio: probe.hasAudio,
    },
    issues,
  };
};

const markCandidateFailed = (
  stateValue: ProductionState,
  shotId: string,
  candidateId: string,
  error: string,
  failedAt = new Date().toISOString(),
): ProductionState => {
  const state = structuredClone(parseProductionState(stateValue));
  const shot = state.shots.find((entry) => entry.shotId === shotId);
  const candidate = shot?.candidates.find((entry) => entry.candidateId === candidateId);
  if (!shot || !candidate) throw new Error(`PRODUCTION_STATE_CANDIDATE_NOT_FOUND:${candidateId}`);
  candidate.status = 'failed';
  candidate.finishedAt = failedAt;
  candidate.error = error.slice(0, 4_000);
  delete candidate.interruptedAt;
  delete candidate.relativePath;
  delete candidate.sha256;
  delete candidate.technicalQa;
  delete candidate.humanDecision;
  candidate.matte = {status: shot.occlusionRequirement === 'none' ? 'not-required' : 'queued'};
  delete shot.selection;
  delete shot.interruptedAt;
  shot.status = shot.candidates.some((entry) => entry.status === 'complete') ? 'awaiting-review' : 'failed';
  if (shot.status === 'failed') shot.error = error.slice(0, 4_000);
  else delete shot.error;
  state.updatedAt = failedAt;
  return parseProductionState(state);
};

const makeCandidateRetryable = (
  stateValue: ProductionState,
  shotId: string,
  candidateId: string,
): ProductionState => {
  const state = structuredClone(parseProductionState(stateValue));
  const shot = state.shots.find((entry) => entry.shotId === shotId);
  const candidate = shot?.candidates.find((entry) => entry.candidateId === candidateId);
  if (!shot || !candidate) throw new Error(`PRODUCTION_STATE_CANDIDATE_NOT_FOUND:${candidateId}`);
  if (candidate.status !== 'complete') return state;
  if (candidate.technicalQa?.result === 'pass' && candidate.humanDecision?.decision !== 'reject') return state;
  candidate.status = 'failed';
  candidate.error = 'Retrying a candidate that failed QA or was explicitly rejected.';
  candidate.finishedAt = new Date().toISOString();
  delete candidate.relativePath;
  delete candidate.sha256;
  delete candidate.technicalQa;
  delete candidate.humanDecision;
  candidate.matte = {status: shot.occlusionRequirement === 'none' ? 'not-required' : 'queued'};
  shot.status = 'awaiting-review';
  delete shot.selection;
  state.updatedAt = candidate.finishedAt;
  return parseProductionState(state);
};

const pollToCompletion = async (
  provider: WanGPProvider,
  initial: VideoGenerationJob,
  timeoutMs: number,
  onProgress?: (job: VideoGenerationJob) => void,
): Promise<VideoGenerationJob> => {
  const deadline = Date.now() + timeoutMs;
  let current = initial;
  onProgress?.(current);
  while (!isTerminal(current)) {
    if (Date.now() >= deadline) {
      await provider.cancel(current.id).catch(() => undefined);
      throw new Error(`LOCAL_PRODUCTION_GENERATION_TIMEOUT:${current.id}`);
    }
    await sleep(1_500);
    current = await provider.status(current.id);
    onProgress?.(current);
  }
  return current;
};

type OpenProvider = {
  runtime: LocalWanGPRuntime;
  provider: WanGPProvider;
};

const openProvider = async (projectRoot: string): Promise<OpenProvider> => {
  const providerRoot = path.join(projectRoot, 'generated', 'provider');
  await fs.mkdir(providerRoot, {recursive: true});
  const runtime = createLocalWanGPRuntime(path.join(providerRoot, 'wangp-raw'));
  const jobStore = new FileVideoGenerationJobStore(path.join(providerRoot, 'jobs.json'));
  await jobStore.initialize();
  return {
    runtime,
    provider: new WanGPProvider({
      transport: runtime.transport,
      outputDirectory: path.join(providerRoot, 'provider-jobs'),
      preferredModelTypes: {preview: 'fun_inp_1.3B', quality: 'fun_inp_1.3B'},
      callbacks: {
        persistJob: async (job) => { await jobStore.upsert({...job}); },
        log: (level, message, details) => console.error(`[wangp:${level}] ${message}`, details ?? ''),
      },
    }),
  };
};

export const detectLocalProductionRuntime = async (projectRootValue: string) => {
  const projectRoot = path.resolve(projectRootValue);
  const plan = await loadProductionPlan(projectRoot);
  const opened = await openProvider(projectRoot);
  try {
    const provider = await opened.provider.detect();
    const models = await discoverWanGPI2VModels(opened.runtime.transport).catch(() => []);
    const cudaRuntime = await probeWanGPCudaRuntime(opened.runtime.pythonExecutable);
    const installedModels = models
      .filter((model) => model.availability === 'available')
      .map((model) => model.modelType);
    const capability = await detectLocalGenerationCapability({
      providerAvailable: provider.available,
      installedModels,
      cudaRuntimeAvailable: cudaRuntime.available,
      ...(provider.reason === undefined ? {} : {providerReason: provider.reason}),
      ...(cudaRuntime.reason === undefined ? {} : {cudaRuntimeReason: cudaRuntime.reason}),
    });
    const presets = provider.available ? await opened.provider.listPresets() : [];
    const requestedShots: Array<{
      shotId: string;
      ready: boolean;
      preset?: VideoGenerationPreset;
      error?: string;
    }> = [];
    for (const shot of plan.shots) {
      if (shot.kind !== 'generated-performance') continue;
      try {
        const preset = resolveLocalGenerationPreset(shot, presets);
        requestedShots.push({shotId: shot.shotId, ready: true, preset});
      } catch (error) {
        requestedShots.push({shotId: shot.shotId, ready: false, error: safeError(error)});
      }
    }
    return {
      projectId: plan.projectId,
      available: provider.available
        && cudaRuntime.available
        && requestedShots.every((shot) => shot.ready),
      provider,
      transport: {
        mode: opened.runtime.mode,
        endpoint: opened.runtime.transport.endpointDescription,
        ...(opened.runtime.root === undefined ? {} : {root: opened.runtime.root}),
        ...(opened.runtime.pythonExecutable === undefined
          ? {}
          : {pythonExecutable: opened.runtime.pythonExecutable}),
      },
      models,
      cudaRuntime,
      capability,
      presets,
      requestedShots,
    };
  } finally {
    await opened.runtime.transport.close().catch(() => undefined);
  }
};

export type GenerateLocalProductionShotOptions = {
  projectRoot: string;
  shotId: string;
  timeoutMs?: number;
  onProgress?: (candidateId: string, job: VideoGenerationJob) => void;
};

export const generateLocalProductionShot = async (
  options: GenerateLocalProductionShotOptions,
) => {
  const projectRoot = path.resolve(options.projectRoot);
  const plan = await loadProductionPlan(projectRoot);
  const shot = plan.shots.find((entry) => entry.shotId === options.shotId);
  if (!shot) throw new Error(`PRODUCTION_SHOT_NOT_FOUND:${options.shotId}`);
  if (shot.kind !== 'generated-performance') throw new Error(`PRODUCTION_SHOT_NOT_GENERATED:${options.shotId}`);
  const runLock = await acquireProductionRunLock(projectRoot, {kind: 'generation'});
  try {
  let state = await ensureLocalProductionState(projectRoot, plan, {ownsRunLock: true});
  const shotState = state.shots.find((entry) => entry.shotId === shot.shotId);
  if (!shotState) throw new Error(`PRODUCTION_STATE_SHOT_NOT_FOUND:${shot.shotId}`);
  if (shotState.selection !== undefined) throw new Error(`PRODUCTION_SHOT_ALREADY_SELECTED:${shot.shotId}`);
  if (shotState.candidates.length !== 2) throw new Error(`PRODUCTION_CANDIDATE_COUNT_INVALID:${shot.shotId}`);

  const opened = await openProvider(projectRoot);
  const generated: string[] = [];
  const skipped: string[] = [];
  const failed: Array<{candidateId: string; error: string}> = [];
  try {
    const detection = await opened.provider.detect();
    if (!detection.available) throw new Error(`WANGP_UNAVAILABLE:${detection.reason ?? 'unknown'}`);
    const cuda = await probeWanGPCudaRuntime(opened.runtime.pythonExecutable);
    if (!cuda.available) throw new Error(`WANGP_CUDA_RUNTIME_UNAVAILABLE:${cuda.reason ?? 'unknown'}`);
    const preset = resolveLocalGenerationPreset(shot, await opened.provider.listPresets());

    for (const plannedCandidate of shotState.candidates) {
      state = makeCandidateRetryable(state, shot.shotId, plannedCandidate.candidateId);
      let candidate = state.shots.find((entry) => entry.shotId === shot.shotId)?.candidates
        .find((entry) => entry.candidateId === plannedCandidate.candidateId);
      if (!candidate) throw new Error(`PRODUCTION_STATE_CANDIDATE_NOT_FOUND:${plannedCandidate.candidateId}`);
      if (candidate.status === 'complete' && candidate.technicalQa?.result === 'pass') {
        skipped.push(candidate.candidateId);
        continue;
      }
      state = beginProductionCandidate(state, shot.shotId, candidate.candidateId);
      state = await writeProductionState(projectRoot, state);
      candidate = state.shots.find((entry) => entry.shotId === shot.shotId)!.candidates
        .find((entry) => entry.candidateId === candidate!.candidateId)!;
      try {
        const initial = await opened.provider.submit({
          projectId: plan.projectId,
          shotId: shot.shotId,
          keyframePath: resolveProjectAsset(projectRoot, shot.generation.conditioning.startKeyframePath),
          ...(shot.generation.conditioning.mode === 'start-end'
            ? {endKeyframePath: resolveProjectAsset(projectRoot, shot.generation.conditioning.endKeyframePath)}
            : {}),
          prompt: shot.hybridMotion.actor.prompt,
          negativePrompt: shot.hybridMotion.actor.negativePrompt,
          width: preset.width,
          height: preset.height,
          fps: preset.fps,
          frameCount: preset.frameCount,
          seed: candidate.seed,
          motionStrength: shot.generation.preset.motionStrength,
          presetId: preset.id,
        });
        const completed = await pollToCompletion(
          opened.provider,
          initial,
          options.timeoutMs ?? Number(process.env.LOCAL_PRODUCTION_TIMEOUT_MS ?? 6 * 60 * 60_000),
          (job) => options.onProgress?.(candidate!.candidateId, job),
        );
        if (completed.status !== 'complete' || completed.outputPath === undefined) {
          throw new Error(`${completed.error?.code ?? completed.status}:${completed.error?.message ?? 'no output'}`);
        }
        const candidateDirectory = path.join(projectRoot, 'generated', 'video', shot.shotId);
        await fs.mkdir(candidateDirectory, {recursive: true});
        const outputPath = path.join(candidateDirectory, `${candidate.candidateId}.mp4`);
        const normalized = await normalizeVideo({
          sourcePath: completed.outputPath,
          outputPath,
          outputRoot: candidateDirectory,
          targetFps: shot.generation.timeline.fps,
          durationSeconds: shot.generation.timeline.frameCount / shot.generation.timeline.fps,
          overwrite: true,
        });
        const checkedAt = new Date().toISOString();
        const relativePath = path.relative(projectRoot, outputPath).split(path.sep).join('/');
        state = completeProductionCandidate(state, shot.shotId, candidate.candidateId, {
          relativePath,
          sha256: await sha256File(outputPath),
          technicalQa: buildLocalCandidateTechnicalQa(shot, normalized.output, checkedAt),
          finishedAt: checkedAt,
        });
        state = await writeProductionState(projectRoot, state);
        generated.push(candidate.candidateId);
      } catch (error) {
        const message = safeError(error);
        state = markCandidateFailed(state, shot.shotId, candidate.candidateId, message);
        state = await writeProductionState(projectRoot, state);
        failed.push({candidateId: candidate.candidateId, error: message});
      }
    }
    const finalShot = state.shots.find((entry) => entry.shotId === shot.shotId)!;
    if (finalShot.selection !== undefined) throw new Error('LOCAL_PRODUCTION_GENERATE_MUST_NOT_SELECT');
    return {
      projectId: plan.projectId,
      shotId: shot.shotId,
      generated,
      skipped,
      failed,
      selection: null,
      humanSelectionRequired: true,
      state: finalShot,
    };
  } finally {
    await opened.runtime.transport.close().catch(() => undefined);
  }
  } finally {
    await runLock.release();
  }
};

export const selectLocalProductionCandidate = async (options: {
  projectRoot: string;
  shotId: string;
  candidateId: string;
  notes?: string;
}) => {
  const projectRoot = path.resolve(options.projectRoot);
  const plan = await loadProductionPlan(projectRoot);
  const runLock = await acquireProductionRunLock(projectRoot, {kind: 'review'});
  try {
    let state = await ensureLocalProductionState(projectRoot, plan, {ownsRunLock: true});
    const reviewedAt = new Date().toISOString();
    state = reviewProductionCandidate(state, options.shotId, options.candidateId, {
      decision: 'accept',
      reviewedAt,
      ...(options.notes === undefined ? {} : {notes: options.notes}),
    });
    state = selectProductionCandidate(state, options.shotId, options.candidateId, reviewedAt);
    state = await writeProductionState(projectRoot, state);
    return {
      projectId: plan.projectId,
      shotId: options.shotId,
      selectedCandidateId: options.candidateId,
      selectedAt: reviewedAt,
      state: state.shots.find((shot) => shot.shotId === options.shotId),
    };
  } finally {
    await runLock.release();
  }
};

export const rejectLocalProductionCandidate = async (options: {
  projectRoot: string;
  shotId: string;
  candidateId: string;
  notes?: string;
}) => {
  const projectRoot = path.resolve(options.projectRoot);
  const plan = await loadProductionPlan(projectRoot);
  const runLock = await acquireProductionRunLock(projectRoot, {kind: 'review'});
  try {
    let state = await ensureLocalProductionState(projectRoot, plan, {ownsRunLock: true});
    const reviewedAt = new Date().toISOString();
    state = reviewProductionCandidate(state, options.shotId, options.candidateId, {
      decision: 'reject',
      reviewedAt,
      ...(options.notes === undefined ? {} : {notes: options.notes}),
    });
    state = await writeProductionState(projectRoot, state);
    return {
      projectId: plan.projectId,
      shotId: options.shotId,
      rejectedCandidateId: options.candidateId,
      reviewedAt,
      selection: null,
      state: state.shots.find((shot) => shot.shotId === options.shotId),
    };
  } finally {
    await runLock.release();
  }
};

export const getLocalProductionStatus = async (projectRootValue: string) => {
  const projectRoot = path.resolve(projectRootValue);
  const plan = await loadProductionPlan(projectRoot);
  const runLock = await inspectProductionRunLock(projectRoot);
  let state: ProductionState;
  try {
    // Status is observational. Recovery belongs to a new generation owner or
    // desktop startup, never to a second process inspecting a live job.
    state = await loadProductionState(projectRoot, {recoverInterrupted: false});
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    state = createProductionState(plan);
  }
  assertProductionStateMatchesPlan(state, plan);
  return {
    schemaVersion: plan.schemaVersion,
    projectId: plan.projectId,
    title: plan.metadata.title,
    locale: plan.metadata.locale,
    projectRoot,
    runLock,
    delivery: plan.delivery,
    narration: state.narration,
    shots: plan.shots.map((shot) => {
      const runtime = state.shots.find((entry) => entry.shotId === shot.shotId);
      return {
        shotId: shot.shotId,
        kind: shot.kind,
        deliveryTimeline: shot.deliveryTimeline,
        runtime,
      };
    }),
  };
};

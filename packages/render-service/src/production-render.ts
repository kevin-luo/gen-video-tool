import {createHash} from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {probeAudio} from '@gen-video-tool/asset-pack';
import type {ProductionRenderData} from '@gen-video-tool/remotion-engine';
import {
  PRODUCTION_PLAN_RELATIVE_PATH,
  assertProductionStateMatchesPlan,
  buildTemporalQaSamples,
  generatedCandidateProbeIssues,
  loadProductionPlan,
  loadProductionState,
  probeVideo,
  productionShotToHybridMotionPlan,
  reprobeMatchesPersistedQa,
  type ProductionPlan,
  type ProductionState,
  type VideoProbe,
} from '@gen-video-tool/video-generation';

export type RenderQaFrameSample = {
  /** Global project frame, not the frame local to a shot. */
  frame: number;
  reasons: Array<'uniform' | 'milestone' | 'contact-adjacent'>;
  shotId?: string;
};

export type ProductionRenderContext = {
  plan: ProductionPlan;
  state: ProductionState;
  renderData: ProductionRenderData;
  /** Canonical local narration source declared by delivery.audio.path. */
  narrationPath: string;
  /** Canonical sidecar source. It is copied, never rendered into pixels. */
  subtitlePath: string;
};

export type ProductionRenderValidationOptions = {
  /** Injectable only for deterministic unit tests; production always re-probes. */
  probeVideo?: (absolutePath: string) => Promise<VideoProbe>;
};

const projectPath = (root: string, relativePath: string): string =>
  path.join(root, ...relativePath.split('/'));

const pathExists = async (candidate: string): Promise<boolean> => {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
};

const isFile = async (candidate: string): Promise<boolean> => {
  try {
    return (await fs.stat(candidate)).isFile();
  } catch {
    return false;
  }
};

const sha256File = async (filePath: string): Promise<string> =>
  await new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fsSync.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });

const assertSelectedCandidate = (
  productionShot: Extract<ProductionPlan['shots'][number], {kind: 'generated-performance'}>,
  state: ProductionState,
) => {
  const shotState = state.shots.find((shot) => shot.shotId === productionShot.shotId);
  if (shotState?.selection === undefined) {
    throw new Error(`GENERATED_VIDEO_NOT_SELECTED:${productionShot.shotId}`);
  }
  const candidate = shotState.candidates.find(
    (item) => item.candidateId === shotState.selection?.candidateId,
  );
  if (
    candidate === undefined
    || candidate.status !== 'complete'
    || candidate.relativePath === undefined
    || candidate.technicalQa?.result !== 'pass'
    || candidate.humanDecision?.decision !== 'accept'
  ) {
    throw new Error(`GENERATED_VIDEO_SELECTION_INVALID:${productionShot.shotId}:${shotState.selection.candidateId}`);
  }
  const probe = candidate.technicalQa.probe;
  if (
    probe.width !== productionShot.generation.raster.width
    || probe.height !== productionShot.generation.raster.height
    || Math.abs(probe.fps - productionShot.generation.timeline.fps) > 0.01
    || probe.frameCount !== productionShot.generation.timeline.frameCount
    || probe.codec !== 'h264'
    || probe.pixelFormat !== 'yuv420p'
    || probe.hasAudio
  ) {
    throw new Error(`GENERATED_VIDEO_TECHNICAL_QA_MISMATCH:${productionShot.shotId}:${candidate.candidateId}`);
  }
  if (candidate.matte.status === 'complete') {
    const matteProbe = candidate.matte.technicalQa?.probe;
    if (
      candidate.matte.relativePath === undefined
      || candidate.matte.technicalQa?.result !== 'pass'
      || matteProbe === undefined
      || matteProbe.width !== productionShot.generation.raster.width
      || matteProbe.height !== productionShot.generation.raster.height
      || Math.abs(matteProbe.fps - productionShot.generation.timeline.fps) > 0.01
      || matteProbe.frameCount !== productionShot.generation.timeline.frameCount
      || matteProbe.hasAudio
    ) {
      throw new Error(`GENERATED_VIDEO_MATTE_QA_MISMATCH:${productionShot.shotId}:${candidate.candidateId}`);
    }
  } else if (productionShot.occlusion.requirement === 'required') {
    throw new Error(`GENERATED_VIDEO_REQUIRED_MATTE_MISSING:${productionShot.shotId}:${candidate.candidateId}`);
  }
  return candidate;
};

/**
 * Compile immutable v3 intent plus mutable, reviewed state into JSON-safe
 * Remotion props. A generated shot cannot fall through to a static v2 scene.
 */
export const buildProductionRenderData = (
  production: ProductionPlan,
  state: ProductionState,
  narrationPath = production.delivery.audio.path,
): ProductionRenderData => {
  assertProductionStateMatchesPlan(state, production);
  const runtimeData: ProductionRenderData = {
    schemaVersion: 3,
    projectId: production.projectId,
    delivery: {
      width: production.delivery.raster.width,
      height: production.delivery.raster.height,
      fps: production.delivery.timeline.fps,
      durationFrames: production.delivery.timeline.durationFrames,
    },
    shots: production.shots.map((shot) => {
      if (shot.kind === 'layered-collage') {
        return {
          shotId: shot.shotId,
          kind: 'layered-collage',
          startFrame: shot.deliveryTimeline.startFrame,
          durationFrames: shot.deliveryTimeline.durationFrames,
          layers: shot.layers.map((layer) => structuredClone(layer)),
          camera: structuredClone(shot.editorialCamera),
        };
      }
      const candidate = assertSelectedCandidate(shot, state);
      const performanceVideoPath = candidate.relativePath;
      if (performanceVideoPath === undefined) {
        throw new Error(`GENERATED_VIDEO_SELECTION_INVALID:${shot.shotId}:${candidate.candidateId}`);
      }
      return {
        shotId: shot.shotId,
        kind: 'generated-performance',
        startFrame: shot.deliveryTimeline.startFrame,
        durationFrames: shot.deliveryTimeline.durationFrames,
        performanceVideoPath,
        source: {
          width: shot.generation.raster.width,
          height: shot.generation.raster.height,
          fps: shot.generation.timeline.fps,
          frameCount: shot.generation.timeline.frameCount,
        },
        conform: structuredClone(shot.generation.conformToDelivery),
        deterministicProps: shot.hybridMotion.deterministicProps.map((prop) => ({
          id: prop.propId,
          assetPath: prop.assetPath,
          renderSize: {...prop.renderSize},
          transform: {
            x: prop.transform.x,
            y: prop.transform.y,
            scaleX: prop.transform.scaleX,
            scaleY: prop.transform.scaleY,
            rotation: prop.transform.rotationDegrees,
          },
          motion: {
            contactFrame: prop.motion.contactFrame,
            flightFrames: prop.motion.flightFrames,
            targetX: prop.motion.targetX,
            targetY: prop.motion.targetY,
            targetScale: prop.motion.targetScale,
            curveX: prop.motion.curveX,
            spinDegrees: prop.motion.spinDegrees,
          },
        })),
        camera: {...shot.hybridMotion.editorialCamera},
        ...(candidate.matte.status === 'complete' && candidate.matte.relativePath !== undefined
          ? {foregroundOcclusionVideoPath: candidate.matte.relativePath}
          : {}),
        ...(shot.occlusion.mode === 'local-matte' && shot.occlusion.foregroundAssetPath !== undefined
          ? {foregroundOcclusionAssetPath: shot.occlusion.foregroundAssetPath}
          : {}),
      };
    }),
    narrationPath,
  };
  return runtimeData;
};

/** Load the one canonical v3 production contract; there is no legacy render fallback. */
export const loadProductionRenderContext = async (
  projectRoot: string,
  options: ProductionRenderValidationOptions = {},
): Promise<ProductionRenderContext> => {
  const productionPath = projectPath(projectRoot, PRODUCTION_PLAN_RELATIVE_PATH);
  if (!await pathExists(productionPath)) throw new Error('PRODUCTION_PLAN_MISSING');
  const plan = await loadProductionPlan(projectRoot);
  let state: ProductionState;
  try {
    state = await loadProductionState(projectRoot, {recoverInterrupted: false});
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('PRODUCTION_STATE_MISSING');
    }
    throw error;
  }
  assertProductionStateMatchesPlan(state, plan);
  if (state.narration.status !== 'complete') {
    throw new Error(`PRODUCTION_NARRATION_NOT_READY:${state.narration.status}`);
  }
  const narrationPath = plan.delivery.audio.path;
  const narrationAbsolutePath = projectPath(projectRoot, narrationPath);
  if (!await isFile(narrationAbsolutePath)) throw new Error('PRODUCTION_NARRATION_ASSET_MISSING');
  const narrationDigest = await sha256File(narrationAbsolutePath);
  if (narrationDigest !== state.narration.sha256) throw new Error('PRODUCTION_NARRATION_HASH_MISMATCH');
  const narrationProbe = await probeAudio(narrationAbsolutePath, narrationPath);
  if (narrationProbe.durationSeconds === null || narrationProbe.diagnostics.length > 0) {
    throw new Error('PRODUCTION_NARRATION_INVALID');
  }
  if (
    state.narration.durationSeconds === undefined
    || Math.abs(narrationProbe.durationSeconds - state.narration.durationSeconds) > 0.05
  ) {
    throw new Error('PRODUCTION_NARRATION_DURATION_MISMATCH');
  }
  const deliveryDurationSeconds = plan.delivery.timeline.durationFrames / plan.delivery.timeline.fps;
  if (narrationProbe.durationSeconds > deliveryDurationSeconds + 0.25) {
    throw new Error('PRODUCTION_NARRATION_EXCEEDS_TIMELINE');
  }
  const subtitlePath = plan.delivery.subtitles.path;
  if (!await isFile(projectPath(projectRoot, subtitlePath))) {
    throw new Error('PRODUCTION_SUBTITLE_NOT_READY');
  }
  const renderData = buildProductionRenderData(plan, state, narrationPath);
  const inspectVideo = options.probeVideo ?? (async (absolutePath: string) => probeVideo(absolutePath));
  for (const productionShot of plan.shots) {
    if (productionShot.kind !== 'generated-performance') continue;
    const shotState = state.shots.find((shot) => shot.shotId === productionShot.shotId);
    const candidate = shotState?.candidates.find((item) => item.candidateId === shotState.selection?.candidateId);
    if (
      candidate === undefined
      || candidate.relativePath === undefined
      || candidate.sha256 === undefined
      || candidate.technicalQa === undefined
    ) {
      throw new Error(`GENERATED_VIDEO_SELECTION_INVALID:${productionShot.shotId}:${shotState?.selection?.candidateId ?? 'none'}`);
    }
    const candidatePath = projectPath(projectRoot, candidate.relativePath);
    if (!await isFile(candidatePath)) {
      throw new Error(`GENERATED_VIDEO_SELECTED_ASSET_MISSING:${productionShot.shotId}:${candidate.relativePath}`);
    }
    if (await sha256File(candidatePath) !== candidate.sha256) {
      throw new Error(`GENERATED_VIDEO_SELECTED_ASSET_HASH_MISMATCH:${productionShot.shotId}:${candidate.candidateId}`);
    }
    const candidateProbe = await inspectVideo(candidatePath);
    if (
      generatedCandidateProbeIssues(productionShot, candidateProbe).length > 0
      || !reprobeMatchesPersistedQa(candidateProbe, candidate.technicalQa.probe)
    ) {
      throw new Error(`GENERATED_VIDEO_SELECTED_ASSET_REPROBE_MISMATCH:${productionShot.shotId}:${candidate.candidateId}`);
    }

    if (candidate.matte.status !== 'complete') continue;
    if (
      candidate.matte.relativePath === undefined
      || candidate.matte.sha256 === undefined
      || candidate.matte.technicalQa === undefined
    ) {
      throw new Error(`GENERATED_VIDEO_MATTE_QA_MISMATCH:${productionShot.shotId}:${candidate.candidateId}`);
    }
    const mattePath = projectPath(projectRoot, candidate.matte.relativePath);
    if (!await isFile(mattePath)) {
      throw new Error(`GENERATED_VIDEO_MATTE_ASSET_MISSING:${productionShot.shotId}:${candidate.matte.relativePath}`);
    }
    if (await sha256File(mattePath) !== candidate.matte.sha256) {
      throw new Error(`GENERATED_VIDEO_MATTE_ASSET_HASH_MISMATCH:${productionShot.shotId}:${candidate.candidateId}`);
    }
    const matteProbe = await inspectVideo(mattePath);
    if (!reprobeMatchesPersistedQa(matteProbe, candidate.matte.technicalQa.probe)) {
      throw new Error(`GENERATED_VIDEO_MATTE_ASSET_REPROBE_MISMATCH:${productionShot.shotId}:${candidate.candidateId}`);
    }
  }
  return {
    plan,
    state,
    renderData,
    narrationPath,
    subtitlePath,
  };
};

/** Twelve whole-project samples plus generated-shot milestones/contact neighbours. */
export const buildProjectQaFrameSamples = (
  production: ProductionPlan,
): RenderQaFrameSample[] => {
  const totalFrames = production.delivery.timeline.durationFrames;
  const samples: RenderQaFrameSample[] = Array.from({length: 12}, (_, index) => ({
    frame: Math.min(totalFrames - 1, Math.floor(totalFrames * ((index + 0.5) / 12))),
    reasons: ['uniform'],
  }));
  for (const shot of production.shots) {
    if (shot.kind === 'generated-performance') {
      const plan = productionShotToHybridMotionPlan(production, shot.shotId);
      const temporal = buildTemporalQaSamples(plan, 12, 2);
      for (const sample of temporal) {
        const reasons = sample.reasons.filter(
          (reason): reason is 'milestone' | 'contact-adjacent' => reason !== 'uniform',
        );
        if (reasons.length === 0) continue;
        const frame = shot.deliveryTimeline.startFrame + sample.frame;
        const existing = samples.find((item) => item.frame === frame);
        if (existing) {
          for (const reason of reasons) {
            if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
          }
          existing.shotId = shot.shotId;
        } else {
          samples.push({frame, reasons, shotId: shot.shotId});
        }
      }
    }
  }
  return samples.sort((a, b) => a.frame - b.frame);
};

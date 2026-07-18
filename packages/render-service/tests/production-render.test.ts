import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {
  createProductionState,
  parseProductionPlan,
  parseProductionState,
  writeProductionPlan,
  writeProductionState,
  type ProductionState,
} from '@gen-video-tool/video-generation';
import {makeProductionPlan} from '../../video-generation/tests/production-fixture';
import {
  buildProductionRenderData,
  buildProjectQaFrameSamples,
  loadProductionRenderContext,
} from '../src/production-render';

const roots: string[] = [];

const makeWav = (durationSeconds = 0.1, sampleRate = 8_000): Buffer => {
  const sampleCount = Math.floor(durationSeconds * sampleRate);
  const dataBytes = sampleCount * 2;
  const output = Buffer.alloc(44 + dataBytes);
  output.write('RIFF', 0, 'ascii');
  output.writeUInt32LE(36 + dataBytes, 4);
  output.write('WAVEfmt ', 8, 'ascii');
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22);
  output.writeUInt32LE(sampleRate, 24);
  output.writeUInt32LE(sampleRate * 2, 28);
  output.writeUInt16LE(2, 32);
  output.writeUInt16LE(16, 34);
  output.write('data', 36, 'ascii');
  output.writeUInt32LE(dataBytes, 40);
  return output;
};

const narrationWav = makeWav();
const narrationSha256 = createHash('sha256').update(narrationWav).digest('hex');
const candidateBytes = Buffer.from('candidate-video-fixture');
const matteBytes = Buffer.from('matte-video-fixture');
const candidateSha256 = createHash('sha256').update(candidateBytes).digest('hex');
const matteSha256 = createHash('sha256').update(matteBytes).digest('hex');

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, {recursive: true, force: true})));
});

const acceptedState = (): ProductionState => {
  const plan = makeProductionPlan();
  const state = createProductionState(plan, '2026-07-17T01:00:00.000Z');
  const shot = state.shots[0]!;
  const candidate = shot.candidates[0]!;
  candidate.status = 'complete';
  candidate.startedAt = '2026-07-17T01:01:00.000Z';
  candidate.finishedAt = '2026-07-17T01:06:00.000Z';
  candidate.relativePath = 'generated/candidates/kick-01-candidate-1.mp4';
  candidate.sha256 = candidateSha256;
  candidate.technicalQa = {
    result: 'pass',
    checkedAt: '2026-07-17T01:06:30.000Z',
    probe: {
      width: 480,
      height: 832,
      fps: 24,
      frameCount: 81,
      codec: 'h264',
      pixelFormat: 'yuv420p',
      hasAudio: false,
    },
    issues: [],
  };
  candidate.matte = {
    status: 'complete',
    startedAt: '2026-07-17T01:06:31.000Z',
    finishedAt: '2026-07-17T01:06:50.000Z',
    relativePath: 'generated/mattes/kick-01/kick-01-candidate-1.webm',
    sha256: matteSha256,
    technicalQa: {
      result: 'pass',
      checkedAt: '2026-07-17T01:06:51.000Z',
      probe: {
        width: 480,
        height: 832,
        fps: 24,
        frameCount: 81,
        codec: 'vp9',
        pixelFormat: 'yuva420p',
        hasAudio: false,
      },
      issues: [],
    },
  };
  candidate.humanDecision = {
    decision: 'accept',
    reviewedAt: '2026-07-17T01:07:00.000Z',
  };
  shot.status = 'selected';
  shot.selection = {
    candidateId: candidate.candidateId,
    selectedAt: '2026-07-17T01:07:00.000Z',
  };
  state.narration = {
    status: 'complete',
    startedAt: '2026-07-17T01:00:00.000Z',
    finishedAt: '2026-07-17T01:00:10.000Z',
    mergedAudioPath: plan.narration.mergedAudioPath,
    sha256: narrationSha256,
    durationSeconds: 0.1,
    speechDurationSeconds: 0.1,
    tailPaddingSeconds: 0,
    segments: [{
      segmentId: plan.narration.segments[0]!.segmentId,
      outputPath: plan.narration.segments[0]!.outputPath,
      startSeconds: 0,
      endSeconds: 0.1,
      durationSeconds: 0.1,
    }],
  };
  state.updatedAt = '2026-07-17T01:07:00.000Z';
  return parseProductionState(state);
};

const temporaryRoot = async (): Promise<string> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'render-production-'));
  roots.push(root);
  return root;
};

const inspectedProbe = async (absolutePath: string) => {
  const matte = absolutePath.endsWith('.webm');
  return {
    sourcePath: absolutePath,
    width: 480,
    height: 832,
    fps: 24,
    frameCount: 81,
    durationSeconds: 81 / 24,
    codecName: matte ? 'vp9' : 'h264',
    pixelFormat: matte ? 'yuva420p' : 'yuv420p',
    formatName: matte ? 'matroska,webm' : 'mov,mp4,m4a,3gp,3g2,mj2',
    hasAudio: false,
    fileSizeBytes: matte ? matteBytes.length : candidateBytes.length,
  };
};

const makeLayeredAssemblyPlan = (assemblyOverrides: Record<string, unknown> = {}) => {
  const raw = structuredClone(makeProductionPlan()) as unknown as Record<string, unknown>;
  raw.requiredCapabilities = ['local-f5-tts', 'remotion-render', 'ffmpeg', 'sidecar-srt'];
  raw.shots = [
    {
      kind: 'layered-collage',
      shotId: 'collage-01',
      deliveryTimeline: {startFrame: 0, durationFrames: 40},
      layers: [{
        id: 'background-01',
        assetPath: 'assets/shots/collage-01/background.png',
        role: 'background',
        zIndex: 0,
        transform: {x: 0, y: 0, scaleX: 1, scaleY: 1, rotationDegrees: 0, opacity: 1},
        motionPreset: 'locked',
      }],
      editorialCamera: {owner: 'editorial-camera', operation: 'locked', strength: 0},
    },
    {
      kind: 'layered-collage',
      shotId: 'collage-02',
      deliveryTimeline: {startFrame: 40, durationFrames: 61},
      layers: [
        {
          id: 'background-02',
          assetPath: 'assets/shots/collage-02/background.png',
          role: 'background',
          zIndex: 0,
          transform: {x: 0, y: 0, scaleX: 1, scaleY: 1, rotationDegrees: 0, opacity: 1},
          motionPreset: 'locked',
        },
        {
          id: 'hero-02',
          assetPath: 'assets/shots/collage-02/hero.png',
          role: 'actor',
          zIndex: 10,
          transform: {x: 540, y: 1_080, scaleX: 1, scaleY: 1, rotationDegrees: 0, opacity: 1},
          motionPreset: 'locked',
          assembly: {
            kind: 'stamp',
            startFrame: 10,
            durationFrames: 12,
            distance: 320,
            rotationDegrees: -8,
            steps: 6,
            ...assemblyOverrides,
          },
        },
      ],
      editorialCamera: {owner: 'editorial-camera', operation: 'push', strength: 0.08},
    },
  ];
  const narration = raw.narration as Record<string, unknown>;
  const segments = narration.segments as Array<Record<string, unknown>>;
  segments[0]!.shotId = 'collage-02';
  return parseProductionPlan(raw);
};

const writeRenderFixture = async (
  root: string,
  options: {candidate?: Buffer; matte?: Buffer} = {},
): Promise<{plan: ReturnType<typeof makeProductionPlan>; state: ProductionState}> => {
  const plan = makeProductionPlan();
  const state = acceptedState();
  await writeProductionPlan(root, plan);
  await writeProductionState(root, state);
  const candidatePath = path.join(root, ...state.shots[0]!.candidates[0]!.relativePath!.split('/'));
  const narrationPath = path.join(root, ...plan.narration.mergedAudioPath.split('/'));
  const subtitlePath = path.join(root, ...plan.delivery.subtitles.path.split('/'));
  const mattePath = path.join(root, ...state.shots[0]!.candidates[0]!.matte.relativePath!.split('/'));
  await Promise.all([
    fs.mkdir(path.dirname(candidatePath), {recursive: true}),
    fs.mkdir(path.dirname(narrationPath), {recursive: true}),
    fs.mkdir(path.dirname(subtitlePath), {recursive: true}),
    fs.mkdir(path.dirname(mattePath), {recursive: true}),
  ]);
  await Promise.all([
    fs.writeFile(candidatePath, options.candidate ?? candidateBytes),
    fs.writeFile(narrationPath, narrationWav),
    fs.writeFile(subtitlePath, '1\n00:00:00,000 --> 00:00:00,100\nTest\n'),
    fs.writeFile(mattePath, options.matte ?? matteBytes),
  ]);
  return {plan, state};
};

describe('v3 production render bridge', () => {
  it('fails with a stable error when a generated shot has no accepted selection', () => {
    const plan = makeProductionPlan();
    const state = createProductionState(plan, '2026-07-17T01:00:00.000Z');

    expect(() => buildProductionRenderData(plan, state)).toThrow(
      'GENERATED_VIDEO_NOT_SELECTED:kick-01',
    );
  });

  it('maps the selected candidate, deterministic ball and editorial camera without static fallback', () => {
    const data = buildProductionRenderData(makeProductionPlan(), acceptedState());
    const generated = data.shots[0];

    expect(generated).toMatchObject({
      shotId: 'kick-01',
      kind: 'generated-performance',
      startFrame: 0,
      durationFrames: 101,
      performanceVideoPath: 'generated/candidates/kick-01-candidate-1.mp4',
      source: {width: 480, height: 832, fps: 24, frameCount: 81},
      conform: {
        spatialFit: 'cover',
        focalPoint: {x: 0.5, y: 0.56},
        temporalFit: 'preserve-duration',
      },
      foregroundOcclusionVideoPath: 'generated/mattes/kick-01/kick-01-candidate-1.webm',
      foregroundOcclusionAssetPath: 'assets/shots/kick-01/foreground-net.png',
      deterministicProps: [{
        id: 'ball',
        renderSize: {width: 64, height: 64},
        transform: {x: 522, y: 1556, rotation: 0},
        motion: {contactFrame: 50, targetY: 429},
      }],
      camera: {owner: 'editorial-camera', operation: 'push', strength: 0.16},
    });

    const samples = buildProjectQaFrameSamples(makeProductionPlan());
    expect(samples.filter((sample) => sample.reasons.includes('uniform')).length).toBeGreaterThanOrEqual(12);
    expect(samples.filter((sample) => sample.reasons.includes('contact-adjacent')).map(({frame}) => frame)).toEqual(
      expect.arrayContaining([48, 49, 51, 52]),
    );
    expect(samples.some((sample) => sample.reasons.includes('assembly-adjacent'))).toBe(false);
  });

  it('samples paper assembly before, during, after, and at exact identity', () => {
    const samples = buildProjectQaFrameSamples(makeLayeredAssemblyPlan());
    const assemblySamples = samples.filter((sample) => sample.reasons.includes('assembly-adjacent'));

    expect(assemblySamples.map(({frame}) => frame)).toEqual([49, 50, 56, 61, 62]);
    expect(assemblySamples.every((sample) => sample.shotId === 'collage-02')).toBe(true);
  });

  it('samples a finite paper follow-through before, during, and at its exact hold', () => {
    const samples = buildProjectQaFrameSamples(makeLayeredAssemblyPlan({
      followThrough: {
        kind: 'gesture-right',
        delayFrames: 3,
        durationFrames: 12,
        distance: 40,
        rotationDegrees: 4,
        cadenceFps: 3,
      },
    }));
    const frames = samples
      .filter((sample) => sample.reasons.includes('assembly-adjacent'))
      .map(({frame}) => frame);

    expect(frames).toEqual([49, 50, 56, 61, 62, 64, 65, 71, 76, 77]);
  });

  it('deduplicates assembly samples and skips an exact-identity frame outside the shot', () => {
    const samples = buildProjectQaFrameSamples(makeLayeredAssemblyPlan({
      startFrame: 58,
      durationFrames: 3,
    }));
    const frames = samples
      .filter((sample) => sample.reasons.includes('assembly-adjacent'))
      .map(({frame}) => frame);

    expect(frames).toEqual([97, 98, 99, 100]);
    expect(new Set(frames).size).toBe(frames.length);
    expect(frames).not.toContain(101);
  });

  it('loads reviewed state and prefers existing v3 narration/SRT files', async () => {
    const root = await temporaryRoot();
    const {plan} = await writeRenderFixture(root);

    const context = await loadProductionRenderContext(root, {probeVideo: inspectedProbe});

    expect(context.narrationPath).toBe(plan.delivery.audio.path);
    expect(context.subtitlePath).toBe(plan.delivery.subtitles.path);
    expect(context.renderData.narrationPath).toBe(plan.delivery.audio.path);
  });

  it('rejects a selected candidate whose bytes changed after human review', async () => {
    const root = await temporaryRoot();
    await writeRenderFixture(root, {candidate: Buffer.from('tampered-candidate')});

    await expect(loadProductionRenderContext(root, {probeVideo: inspectedProbe})).rejects.toThrow(
      'GENERATED_VIDEO_SELECTED_ASSET_HASH_MISMATCH:kick-01:kick-01-candidate-1',
    );
  });

  it('re-probes the candidate with the same exact 81-frame contract used by selection', async () => {
    const root = await temporaryRoot();
    await writeRenderFixture(root);

    await expect(loadProductionRenderContext(root, {
      probeVideo: async (absolutePath) => {
        const probe = await inspectedProbe(absolutePath);
        return absolutePath.endsWith('.mp4') ? {...probe, frameCount: 80} : probe;
      },
    })).rejects.toThrow(
      'GENERATED_VIDEO_SELECTED_ASSET_REPROBE_MISMATCH:kick-01:kick-01-candidate-1',
    );
  });

  it('rejects a selected matte whose bytes changed after technical review', async () => {
    const root = await temporaryRoot();
    await writeRenderFixture(root, {matte: Buffer.from('tampered-matte')});

    await expect(loadProductionRenderContext(root, {probeVideo: inspectedProbe})).rejects.toThrow(
      'GENERATED_VIDEO_MATTE_ASSET_HASH_MISMATCH:kick-01:kick-01-candidate-1',
    );
  });

  it('rejects a selected matte whose current probe no longer matches reviewed metadata', async () => {
    const root = await temporaryRoot();
    await writeRenderFixture(root);

    await expect(loadProductionRenderContext(root, {
      probeVideo: async (absolutePath) => {
        const probe = await inspectedProbe(absolutePath);
        return absolutePath.endsWith('.webm') ? {...probe, frameCount: 80} : probe;
      },
    })).rejects.toThrow(
      'GENERATED_VIDEO_MATTE_ASSET_REPROBE_MISMATCH:kick-01:kick-01-candidate-1',
    );
  });

  it('refuses to export a v3 project before local narration is complete', async () => {
    const root = await temporaryRoot();
    const plan = makeProductionPlan();
    await writeProductionPlan(root, plan);
    await writeProductionState(root, createProductionState(plan, '2026-07-17T01:00:00.000Z'));
    await expect(loadProductionRenderContext(root)).rejects.toThrow(
      'PRODUCTION_NARRATION_NOT_READY:queued',
    );
  });

  it('rejects a directory without the canonical v3 production contract', async () => {
    const root = await temporaryRoot();
    await expect(loadProductionRenderContext(root)).rejects.toThrow('PRODUCTION_PLAN_MISSING');
  });
});

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {makeProductionPlan} from './production-fixture';
import {
  assertProductionStateMatchesPlan,
  beginProductionCandidateMatte,
  beginProductionNarration,
  beginProductionCandidate,
  completeProductionCandidateMatte,
  completeProductionNarration,
  completeProductionCandidate,
  createProductionState,
  parseProductionState,
  recoverInterruptedProductionState,
  reviewProductionCandidate,
  selectProductionCandidate,
  type ProductionState,
} from '../src/production/production-state';
import {
  loadProductionPlan,
  loadProductionState,
  loadProductionStateForRestart,
  PRODUCTION_PLAN_RELATIVE_PATH,
  PRODUCTION_STATE_RELATIVE_PATH,
  resolveProductionPlanPath,
  resolveProductionStatePath,
  writeProductionPlan,
  writeProductionState,
} from '../src/production/storage';

const temporaryRoots: string[] = [];
const temporaryProject = async (): Promise<string> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gen-video-production-'));
  temporaryRoots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, {recursive: true, force: true})));
});

const acceptedCandidateState = (): ProductionState => {
  const state = createProductionState(makeProductionPlan(), '2026-07-17T01:00:00.000Z');
  const shot = state.shots[0]!;
  const candidate = shot.candidates[0]!;
  candidate.status = 'complete';
  candidate.startedAt = '2026-07-17T01:01:00.000Z';
  candidate.finishedAt = '2026-07-17T01:06:00.000Z';
  candidate.relativePath = 'generated/candidates/kick-01-candidate-1.mp4';
  candidate.sha256 = 'a'.repeat(64);
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
    sha256: 'd'.repeat(64),
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
    notes: 'Feet stay planted and the action axis is correct.',
  };
  shot.status = 'selected';
  shot.selection = {candidateId: candidate.candidateId, selectedAt: '2026-07-17T01:07:00.000Z'};
  state.updatedAt = '2026-07-17T01:07:00.000Z';
  return parseProductionState(state);
};

describe('production state', () => {
  it('initializes exactly two backend-neutral candidates from the immutable plan', () => {
    const plan = makeProductionPlan();
    const state = createProductionState(plan, '2026-07-17T01:00:00.000Z');

    expect(state).toMatchObject({schemaVersion: 3, projectId: plan.projectId});
    expect(state.shots[0]?.candidates.map(({candidateId, seed, status}) => ({candidateId, seed, status}))).toEqual([
      {candidateId: 'kick-01-candidate-1', seed: 42, status: 'queued'},
      {candidateId: 'kick-01-candidate-2', seed: 314159, status: 'queued'},
    ]);
    expect(state.shots[0]).toMatchObject({
      occlusionRequirement: 'required',
      candidates: [{matte: {status: 'queued'}}, {matte: {status: 'queued'}}],
    });
    expect(() => assertProductionStateMatchesPlan(state, plan)).not.toThrow();
  });

  it('records output path, hash, technical QA, human decision, and valid selection', () => {
    const state = acceptedCandidateState();

    expect(state.shots[0]).toMatchObject({
      status: 'selected',
      selection: {candidateId: 'kick-01-candidate-1'},
      candidates: [{
        status: 'complete',
        relativePath: expect.stringMatching(/candidate-1\.mp4$/u),
        sha256: 'a'.repeat(64),
        technicalQa: {result: 'pass'},
        humanDecision: {decision: 'accept'},
      }, {status: 'queued'}],
    });
  });

  it('provides validated immutable lifecycle transitions for the desktop bridge', () => {
    const initial = createProductionState(makeProductionPlan(), '2026-07-17T01:00:00.000Z');
    const generating = beginProductionCandidate(
      initial,
      'kick-01',
      'kick-01-candidate-1',
      '2026-07-17T01:01:00.000Z',
    );
    const complete = completeProductionCandidate(generating, 'kick-01', 'kick-01-candidate-1', {
      relativePath: 'generated/candidates/kick-01-candidate-1.mp4',
      sha256: 'b'.repeat(64),
      finishedAt: '2026-07-17T01:06:00.000Z',
      technicalQa: {
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
      },
    });
    const matteGenerating = beginProductionCandidateMatte(
      complete,
      'kick-01',
      'kick-01-candidate-1',
      '2026-07-17T01:06:31.000Z',
    );
    const matteComplete = completeProductionCandidateMatte(
      matteGenerating,
      'kick-01',
      'kick-01-candidate-1',
      {
        relativePath: 'generated/mattes/kick-01/kick-01-candidate-1.webm',
        sha256: 'd'.repeat(64),
        finishedAt: '2026-07-17T01:06:50.000Z',
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
      },
    );
    const reviewed = reviewProductionCandidate(matteComplete, 'kick-01', 'kick-01-candidate-1', {
      decision: 'accept',
      reviewedAt: '2026-07-17T01:07:00.000Z',
    });
    const selected = selectProductionCandidate(
      reviewed,
      'kick-01',
      'kick-01-candidate-1',
      '2026-07-17T01:07:30.000Z',
    );

    expect(initial.shots[0]?.status).toBe('queued');
    expect(generating.shots[0]?.status).toBe('generating');
    expect(generating.shots[0]?.candidates[0]?.status).toBe('generating');
    expect(complete.shots[0]?.status).toBe('awaiting-review');
    expect(complete.shots[0]?.candidates[0]?.status).toBe('complete');
    expect(matteGenerating.shots[0]?.candidates[0]?.matte.status).toBe('generating');
    expect(matteComplete.shots[0]?.candidates[0]?.matte).toMatchObject({status: 'complete', technicalQa: {result: 'pass'}});
    expect(reviewed.shots[0]?.candidates[0]?.humanDecision?.decision).toBe('accept');
    expect(selected.shots[0]).toMatchObject({
      status: 'selected',
      selection: {candidateId: 'kick-01-candidate-1'},
    });
  });

  it('rejects selecting a candidate without both technical pass and human acceptance', () => {
    const raw = structuredClone(acceptedCandidateState());
    const selected = raw.shots[0]!.candidates[0]!;
    selected.technicalQa = {...selected.technicalQa!, result: 'fail', issues: ['wrong dimensions']};
    selected.humanDecision = {...selected.humanDecision!, decision: 'reject'};

    const parsed = parseProductionState.bind(null, raw);
    expect(parsed).toThrow(/Selected candidate must pass technical QA|human acceptance/u);
  });

  it('does not allow a required matte project to select a candidate before matte QA passes', () => {
    const raw = structuredClone(acceptedCandidateState());
    const selected = raw.shots[0]!.candidates[0]!;
    selected.matte = {status: 'queued'};
    raw.shots[0]!.status = 'awaiting-review';
    delete raw.shots[0]!.selection;

    expect(() => selectProductionCandidate(
      parseProductionState(raw),
      'kick-01',
      'kick-01-candidate-1',
      '2026-07-17T01:07:30.000Z',
    )).toThrow(/MATTE|SELECTABLE/u);
  });

  it('converts in-flight shot and candidate state to retryable interruption', () => {
    const state = createProductionState(makeProductionPlan(), '2026-07-17T01:00:00.000Z');
    const shot = state.shots[0]!;
    shot.status = 'generating';
    shot.candidates[0]!.status = 'generating';
    shot.candidates[0]!.startedAt = '2026-07-17T01:01:00.000Z';

    const recovered = recoverInterruptedProductionState(state, '2026-07-17T01:02:00.000Z');

    expect(recovered.changed).toBe(true);
    expect(recovered.state.shots[0]).toMatchObject({
      status: 'interrupted',
      interruptedAt: '2026-07-17T01:02:00.000Z',
      candidates: [{status: 'interrupted', interruptedAt: '2026-07-17T01:02:00.000Z'}, {status: 'queued'}],
    });
    expect(state.shots[0]?.status).toBe('generating');
  });

  it('persists measured local narration timing and validates it against the immutable plan', () => {
    const plan = makeProductionPlan();
    const initial = createProductionState(plan, '2026-07-17T01:00:00.000Z');
    const generating = beginProductionNarration(initial, '2026-07-17T01:00:30.000Z');
    const complete = completeProductionNarration(generating, {
      mergedAudioPath: plan.narration.mergedAudioPath,
      sha256: 'c'.repeat(64),
      durationSeconds: 3.2,
      speechDurationSeconds: 3.2,
      tailPaddingSeconds: 0,
      finishedAt: '2026-07-17T01:01:30.000Z',
      segments: [{
        segmentId: plan.narration.segments[0]!.segmentId,
        outputPath: plan.narration.segments[0]!.outputPath,
        startSeconds: 0,
        endSeconds: 3.2,
        durationSeconds: 3.2,
      }],
    });

    expect(generating.narration.status).toBe('generating');
    expect(complete.narration).toMatchObject({
      status: 'complete',
      durationSeconds: 3.2,
      mergedAudioPath: plan.narration.mergedAudioPath,
      segments: [{startSeconds: 0, endSeconds: 3.2}],
    });
    expect(() => assertProductionStateMatchesPlan(complete, plan)).not.toThrow();
  });

  it('recovers local narration generation as an explicit interruption', () => {
    const state = beginProductionNarration(
      createProductionState(makeProductionPlan(), '2026-07-17T01:00:00.000Z'),
      '2026-07-17T01:00:30.000Z',
    );
    const recovered = recoverInterruptedProductionState(state, '2026-07-17T01:02:00.000Z');
    expect(recovered.changed).toBe(true);
    expect(recovered.state.narration).toMatchObject({
      status: 'interrupted',
      interruptedAt: '2026-07-17T01:02:00.000Z',
    });
  });

  it('detects project, shot, and candidate-seed drift from production.json', () => {
    const plan = makeProductionPlan();
    const wrongProject = createProductionState(plan);
    wrongProject.projectId = 'another-project';
    expect(() => assertProductionStateMatchesPlan(wrongProject, plan)).toThrow(/projectId/u);

    const wrongSeed = createProductionState(plan);
    wrongSeed.shots[0]!.candidates[0]!.seed = 999;
    expect(() => assertProductionStateMatchesPlan(wrongSeed, plan)).toThrow(/seeds:kick-01/u);
  });
});

describe('fixed production storage', () => {
  it('atomically writes and loads production.json and generated/production-state.json', async () => {
    const projectRoot = await temporaryProject();
    const plan = makeProductionPlan();
    const state = createProductionState(plan, '2026-07-17T01:00:00.000Z');

    await writeProductionPlan(projectRoot, plan);
    await writeProductionState(projectRoot, state);

    expect(resolveProductionPlanPath(projectRoot)).toBe(path.join(projectRoot, PRODUCTION_PLAN_RELATIVE_PATH));
    expect(resolveProductionStatePath(projectRoot)).toBe(path.join(projectRoot, 'generated', 'production-state.json'));
    expect(PRODUCTION_STATE_RELATIVE_PATH).toBe('generated/production-state.json');
    expect(await loadProductionPlan(projectRoot)).toEqual(plan);
    expect(await loadProductionState(projectRoot, {recoverInterrupted: false})).toEqual(state);
    expect((await fs.readdir(projectRoot)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect((await fs.readdir(path.join(projectRoot, 'generated'))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('persists restart recovery when loading active generation state', async () => {
    const projectRoot = await temporaryProject();
    const state = createProductionState(makeProductionPlan(), '2026-07-17T01:00:00.000Z');
    state.shots[0]!.status = 'generating';
    state.shots[0]!.candidates[0]!.status = 'generating';
    state.shots[0]!.candidates[0]!.startedAt = '2026-07-17T01:01:00.000Z';
    await writeProductionState(projectRoot, state);

    const ordinaryRead = await loadProductionState(projectRoot);
    expect(ordinaryRead.shots[0]?.status).toBe('generating');

    const loaded = await loadProductionStateForRestart(projectRoot, '2026-07-17T01:02:00.000Z');
    const persisted = JSON.parse(await fs.readFile(resolveProductionStatePath(projectRoot), 'utf8')) as ProductionState;

    expect(loaded.shots[0]?.status).toBe('interrupted');
    expect(persisted.shots[0]?.status).toBe('interrupted');
    expect(persisted.shots[0]?.candidates[0]?.status).toBe('interrupted');
  });

  it('validates before writing and requires an absolute project root', async () => {
    const projectRoot = await temporaryProject();
    await expect(writeProductionPlan(projectRoot, {...makeProductionPlan(), networkPolicy: 'online'})).rejects.toThrow();
    await expect(fs.stat(resolveProductionPlanPath(projectRoot))).rejects.toMatchObject({code: 'ENOENT'});
    expect(() => resolveProductionPlanPath('relative/project')).toThrow(/MUST_BE_ABSOLUTE/u);
  });
});

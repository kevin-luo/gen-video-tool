import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {
  acquireProductionRunLock,
  beginProductionCandidate,
  createProductionState,
  loadProductionState,
  parseProductionPlan,
  parseProductionState,
  writeProductionPlan,
  writeProductionState,
  type VideoProbe,
} from '@gen-video-tool/video-generation';
import {makeProductionPlan} from '../../packages/video-generation/tests/production-fixture';
import {
  buildLocalCandidateTechnicalQa,
  getLocalProductionStatus,
  rejectLocalProductionCandidate,
  resolveLocalGenerationPreset,
  selectLocalProductionCandidate,
} from '../../scripts/local-production';

const roots: string[] = [];

const temporaryRoot = async (): Promise<string> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-production-cli-'));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, {recursive: true, force: true})));
});

const validProbe = (): VideoProbe => ({
  sourcePath: 'C:/generated/candidate.mp4',
  width: 480,
  height: 832,
  fps: 24,
  frameCount: 81,
  durationSeconds: 81 / 24,
  codecName: 'h264',
  pixelFormat: 'yuv420p',
  formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
  hasAudio: false,
  fileSizeBytes: 100_000,
});

describe('headless v3 local production CLI core', () => {
  it('uses the native WanGP preset while keeping delivery geometry separate', () => {
    const plan = makeProductionPlan();
    const shot = plan.shots[0];
    if (shot?.kind !== 'generated-performance') throw new Error('fixture');
    const preset = resolveLocalGenerationPreset(shot, [{
      id: 'local-i2v-quality-portrait',
      label: 'Local I2V Quality Portrait',
      width: 480,
      height: 832,
      fps: 24,
      frameCount: 81,
      candidateCount: 2,
      qualityTier: 'quality',
      allowUpscale: true,
      allowInterpolation: true,
    }]);

    expect(preset).toMatchObject({width: 480, height: 832, fps: 24, frameCount: 81});
    expect(plan.delivery.raster).toMatchObject({width: 1080, height: 1920});
  });

  it('produces the same strict H.264/yuv420p/CFR/silent technical QA gate as desktop generation', () => {
    const plan = makeProductionPlan();
    const shot = plan.shots[0];
    if (shot?.kind !== 'generated-performance') throw new Error('fixture');

    expect(buildLocalCandidateTechnicalQa(shot, validProbe(), '2026-07-17T01:00:00.000Z')).toMatchObject({
      result: 'pass',
      issues: [],
      probe: {width: 480, height: 832, fps: 24, frameCount: 81, codec: 'h264', pixelFormat: 'yuv420p', hasAudio: false},
    });
    const invalid = validProbe();
    invalid.frameCount = 80;
    invalid.hasAudio = true;
    const failed = buildLocalCandidateTechnicalQa(shot, invalid, '2026-07-17T01:00:00.000Z');
    expect(failed.result).toBe('fail');
    expect(failed.issues.join('\n')).toMatch(/frameCount/);
    expect(failed.issues.join('\n')).toMatch(/silent/);
  });

  it('reports status without selecting or mutating either immutable candidate', async () => {
    const root = await temporaryRoot();
    const plan = makeProductionPlan();
    await writeProductionPlan(root, plan);

    const status = await getLocalProductionStatus(root);

    expect(status.runLock).toEqual({status: 'unlocked'});
    expect(status.shots[0]?.runtime?.candidates.map(({seed}) => seed)).toEqual([42, 314159]);
    expect(status.shots[0]?.runtime?.selection).toBeUndefined();
    expect(status.shots[0]?.runtime?.candidates.every((candidate) => candidate.humanDecision === undefined)).toBe(true);
    await expect(loadProductionState(root)).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('does not mark a live generating candidate interrupted when status is inspected', async () => {
    const root = await temporaryRoot();
    const plan = makeProductionPlan();
    const queued = createProductionState(plan, '2026-07-17T01:00:00.000Z');
    const running = beginProductionCandidate(
      queued,
      plan.shots[0]!.shotId,
      queued.shots[0]!.candidates[0]!.candidateId,
      '2026-07-17T01:00:01.000Z',
    );
    await writeProductionPlan(root, plan);
    await writeProductionState(root, running);

    const lock = await acquireProductionRunLock(root, {kind: 'generation', ownerId: 'test-headless'});
    const status = await getLocalProductionStatus(root);
    const persisted = await loadProductionState(root, {recoverInterrupted: false});

    expect(status.runLock).toMatchObject({status: 'active', record: {ownerId: 'test-headless'}});
    expect(status.shots[0]?.runtime?.status).toBe('generating');
    expect(status.shots[0]?.runtime?.candidates[0]?.status).toBe('generating');
    expect(persisted.shots[0]?.candidates[0]?.status).toBe('generating');
    expect(persisted.shots[0]?.candidates[0]?.interruptedAt).toBeUndefined();
    await lock.release();
  });

  it('records human acceptance only in the explicit select command', async () => {
    const root = await temporaryRoot();
    const raw = structuredClone(makeProductionPlan());
    const generated = raw.shots[0];
    if (generated?.kind !== 'generated-performance') throw new Error('fixture');
    generated.occlusion = {mode: 'none', requirement: 'none'};
    const plan = parseProductionPlan(raw);
    const state = createProductionState(plan, '2026-07-17T01:00:00.000Z');
    const candidate = state.shots[0]!.candidates[0]!;
    candidate.status = 'complete';
    candidate.startedAt = '2026-07-17T01:00:01.000Z';
    candidate.finishedAt = '2026-07-17T01:00:02.000Z';
    candidate.relativePath = 'generated/video/kick-01/kick-01-candidate-1.mp4';
    candidate.sha256 = 'a'.repeat(64);
    candidate.technicalQa = {
      result: 'pass',
      checkedAt: '2026-07-17T01:00:02.000Z',
      probe: {width: 480, height: 832, fps: 24, frameCount: 81, codec: 'h264', pixelFormat: 'yuv420p', hasAudio: false},
      issues: [],
    };
    state.shots[0]!.status = 'awaiting-review';
    await writeProductionPlan(root, plan);
    await writeProductionState(root, parseProductionState(state));

    expect((await loadProductionState(root)).shots[0]?.selection).toBeUndefined();
    await selectLocalProductionCandidate({
      projectRoot: root,
      shotId: 'kick-01',
      candidateId: 'kick-01-candidate-1',
      notes: 'Manual frame review passed.',
    });
    const selected = await loadProductionState(root);

    expect(selected.shots[0]).toMatchObject({
      status: 'selected',
      selection: {candidateId: 'kick-01-candidate-1'},
      candidates: [{humanDecision: {decision: 'accept', notes: 'Manual frame review passed.'}}, {}],
    });
  });

  it('persists an explicit rejection without selecting or changing the other candidate', async () => {
    const root = await temporaryRoot();
    const raw = structuredClone(makeProductionPlan());
    const generated = raw.shots[0];
    if (generated?.kind !== 'generated-performance') throw new Error('fixture');
    generated.occlusion = {mode: 'none', requirement: 'none'};
    const plan = parseProductionPlan(raw);
    const state = createProductionState(plan, '2026-07-17T01:00:00.000Z');
    const [rejectedCandidate, otherCandidate] = state.shots[0]!.candidates;
    if (!rejectedCandidate || !otherCandidate) throw new Error('fixture');
    for (const [index, candidate] of state.shots[0]!.candidates.entries()) {
      candidate.status = 'complete';
      candidate.startedAt = `2026-07-17T01:00:0${index + 1}.000Z`;
      candidate.finishedAt = `2026-07-17T01:00:0${index + 3}.000Z`;
      candidate.relativePath = `generated/video/kick-01/${candidate.candidateId}.mp4`;
      candidate.sha256 = String(index + 1).repeat(64);
      candidate.technicalQa = {
        result: 'pass',
        checkedAt: candidate.finishedAt,
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
    }
    state.shots[0]!.status = 'awaiting-review';
    const otherCandidateBefore = structuredClone(otherCandidate);
    await writeProductionPlan(root, plan);
    await writeProductionState(root, parseProductionState(state));

    const result = await rejectLocalProductionCandidate({
      projectRoot: root,
      shotId: 'kick-01',
      candidateId: rejectedCandidate.candidateId,
      notes: 'Foot contact is physically implausible.',
    });
    const persisted = await loadProductionState(root);

    expect(result).toMatchObject({
      projectId: plan.projectId,
      shotId: 'kick-01',
      rejectedCandidateId: rejectedCandidate.candidateId,
      selection: null,
    });
    expect(persisted.shots[0]?.status).toBe('awaiting-review');
    expect(persisted.shots[0]?.candidates[0]).toMatchObject({
      candidateId: rejectedCandidate.candidateId,
      humanDecision: {
        decision: 'reject',
        notes: 'Foot contact is physically implausible.',
      },
    });
    expect(persisted.shots[0]?.selection).toBeUndefined();
    expect(persisted.shots[0]?.candidates[1]).toEqual(otherCandidateBefore);
  });
});

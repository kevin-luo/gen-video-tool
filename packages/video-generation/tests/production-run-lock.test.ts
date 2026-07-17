import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {makeProductionPlan} from './production-fixture';
import {
  acquireProductionRunLock,
  inspectProductionRunLock,
  releaseProductionRunLock,
  resolveProductionRunLockPath,
} from '../src/production/run-lock';
import {
  beginProductionCandidate,
  createProductionState,
} from '../src/production/production-state';
import {
  loadProductionState,
  loadProductionStateForRestart,
  writeProductionState,
} from '../src/production/storage';

const roots: string[] = [];

const temporaryProject = async (): Promise<string> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gen-video-run-lock-'));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, {recursive: true, force: true})));
});

describe('production run lock', () => {
  it('exclusively rejects a second owner while the local PID is alive', async () => {
    const root = await temporaryProject();
    const first = await acquireProductionRunLock(root, {
      kind: 'generation',
      ownerId: 'desktop-owner',
    });

    await expect(acquireProductionRunLock(root, {
      kind: 'narration',
      ownerId: 'headless-owner',
    })).rejects.toMatchObject({code: 'PRODUCTION_RUN_LOCKED'});
    await expect(inspectProductionRunLock(root)).resolves.toMatchObject({
      status: 'active',
      record: {ownerId: 'desktop-owner', kind: 'generation', pid: process.pid},
    });

    await expect(first.release()).resolves.toBe(true);
    await expect(inspectProductionRunLock(root)).resolves.toEqual({status: 'unlocked'});
  });

  it('recovers a stale local-PID lock before granting a new owner', async () => {
    const root = await temporaryProject();
    const stale = await acquireProductionRunLock(root, {
      kind: 'generation',
      ownerId: 'dead-owner',
      pid: 999_999_999,
      isPidAlive: () => false,
    });

    const replacement = await acquireProductionRunLock(root, {
      kind: 'narration',
      ownerId: 'replacement-owner',
      isPidAlive: (pid) => pid === process.pid,
    });
    await expect(inspectProductionRunLock(root)).resolves.toMatchObject({
      status: 'active',
      record: {ownerId: 'replacement-owner', kind: 'narration'},
    });
    await expect(stale.release()).resolves.toBe(false);
    await expect(replacement.release()).resolves.toBe(true);
  });

  it('never releases a lock for the wrong owner', async () => {
    const root = await temporaryProject();
    const lock = await acquireProductionRunLock(root, {kind: 'generation', ownerId: 'right-owner'});

    await expect(releaseProductionRunLock(root, 'wrong-owner')).resolves.toBe(false);
    await expect(fs.access(resolveProductionRunLockPath(root))).resolves.toBeUndefined();
    await expect(inspectProductionRunLock(root)).resolves.toMatchObject({
      status: 'active',
      record: {ownerId: 'right-owner'},
    });

    await lock.release();
  });

  it('keeps live external work generating, then recovers it after the lease is gone', async () => {
    const root = await temporaryProject();
    const plan = makeProductionPlan();
    const initial = createProductionState(plan, '2026-07-17T01:00:00.000Z');
    const generating = beginProductionCandidate(
      initial,
      plan.shots[0]!.shotId,
      initial.shots[0]!.candidates[0]!.candidateId,
      '2026-07-17T01:01:00.000Z',
    );
    await writeProductionState(root, generating);
    const external = await acquireProductionRunLock(root, {
      kind: 'generation',
      ownerId: 'headless-cli',
    });

    const observed = await loadProductionStateForRestart(root, '2026-07-17T01:02:00.000Z');
    expect(observed.shots[0]?.status).toBe('generating');
    expect(observed.shots[0]?.candidates[0]?.status).toBe('generating');
    expect((await loadProductionState(root)).shots[0]?.status).toBe('generating');

    await external.release();
    const deadOwner = await acquireProductionRunLock(root, {
      kind: 'generation',
      ownerId: 'crashed-headless-cli',
      pid: 999_999_999,
      isPidAlive: () => false,
    });
    const recovered = await loadProductionStateForRestart(root, '2026-07-17T01:03:00.000Z');
    expect(recovered.shots[0]?.status).toBe('interrupted');
    expect(recovered.shots[0]?.candidates[0]?.status).toBe('interrupted');
    expect(recovered.shots[0]?.candidates[0]?.interruptedAt).toBe('2026-07-17T01:03:00.000Z');
    await expect(deadOwner.release()).resolves.toBe(false);
    await expect(inspectProductionRunLock(root)).resolves.toEqual({status: 'unlocked'});
  });
});

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import type {VideoGenerationJob} from '../src/providers/provider';
import {FileVideoGenerationJobStore} from '../src/jobs/file-job-store';
import {PersistentVideoGenerationQueue, type VideoGenerationJobRunner} from '../src/queue/persistent-queue';

const temporaryRoots: string[] = [];

const createStore = async (): Promise<FileVideoGenerationJobStore> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gen-video-queue-'));
  temporaryRoots.push(root);
  return new FileVideoGenerationJobStore(path.join(root, 'jobs.json'));
};

const queuedJob = (id: string): VideoGenerationJob => ({
  id,
  providerId: 'wangp',
  status: 'queued',
  progress: 0,
  createdAt: '',
  updatedAt: '',
});

const waitUntil = async (predicate: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('TEST_WAIT_TIMEOUT');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, {recursive: true, force: true})));
});

describe('PersistentVideoGenerationQueue', () => {
  it('runs one local generation job at a time by default', async () => {
    const store = await createStore();
    const releases = new Map<string, () => void>();
    const started: string[] = [];
    let active = 0;
    let peakActive = 0;
    const runner: VideoGenerationJobRunner = async (job, context) => {
      started.push(job.id);
      active += 1;
      peakActive = Math.max(peakActive, active);
      await context.update({status: 'running', progress: 0.25});
      await new Promise<void>((resolve) => releases.set(job.id, resolve));
      active -= 1;
      return {...job, status: 'complete', progress: 1, outputPath: `${job.id}.mp4`};
    };
    const queue = new PersistentVideoGenerationQueue(store, runner, {
      now: (() => {
        let tick = 0;
        return () => `2026-07-16T08:00:${String(tick++).padStart(2, '0')}.000Z`;
      })(),
    });

    await queue.enqueue(queuedJob('candidate-01'));
    await queue.enqueue(queuedJob('candidate-02'));
    await waitUntil(() => started.length === 1 && releases.has('candidate-01'));
    expect(started).toEqual(['candidate-01']);
    expect(queue.concurrency).toBe(1);

    releases.get('candidate-01')?.();
    await waitUntil(() => started.length === 2 && releases.has('candidate-02'));
    expect(started).toEqual(['candidate-01', 'candidate-02']);
    releases.get('candidate-02')?.();
    await queue.waitForIdle();

    expect(peakActive).toBe(1);
    expect((await queue.list()).map(({id, status}) => ({id, status}))).toEqual([
      {id: 'candidate-01', status: 'complete'},
      {id: 'candidate-02', status: 'complete'},
    ]);
  });

  it('cancels a queued job without ever launching it', async () => {
    const store = await createStore();
    let releaseFirst: (() => void) | undefined;
    const started: string[] = [];
    const runner: VideoGenerationJobRunner = async (job) => {
      started.push(job.id);
      if (job.id === 'candidate-01') await new Promise<void>((resolve) => { releaseFirst = resolve; });
      return {...job, status: 'complete', progress: 1};
    };
    const queue = new PersistentVideoGenerationQueue(store, runner);

    await queue.enqueue(queuedJob('candidate-01'));
    await queue.enqueue(queuedJob('candidate-02'));
    await waitUntil(() => started.length === 1);
    await queue.cancel('candidate-02');
    releaseFirst?.();
    await queue.waitForIdle();

    expect(started).toEqual(['candidate-01']);
    expect(await queue.get('candidate-02')).toMatchObject({status: 'cancelled'});
  });

  it('allows an interrupted job to be explicitly retried', async () => {
    const firstProcessStore = await createStore();
    await firstProcessStore.upsert({...queuedJob('candidate-01'), status: 'running', progress: 0.5});
    const store = new FileVideoGenerationJobStore(firstProcessStore.filePath);
    const runs: string[] = [];
    const queue = new PersistentVideoGenerationQueue(store, async (job) => {
      runs.push(job.id);
      return {...job, status: 'complete', progress: 1};
    });

    await queue.start();
    expect(await queue.get('candidate-01')).toMatchObject({
      status: 'failed',
      error: {code: 'JOB_INTERRUPTED', details: {recoverable: true}},
    });

    await queue.retry('candidate-01');
    await queue.waitForIdle();
    expect(runs).toEqual(['candidate-01']);
    expect(await queue.get('candidate-01')).toMatchObject({status: 'complete', progress: 1});
  });
});

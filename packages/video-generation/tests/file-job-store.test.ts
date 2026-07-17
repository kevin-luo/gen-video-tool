import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import type {VideoGenerationJob} from '../src/providers/provider';
import {FileVideoGenerationJobStore} from '../src/jobs/file-job-store';

const temporaryRoots: string[] = [];

const temporaryStorePath = async (): Promise<string> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gen-video-job-store-'));
  temporaryRoots.push(root);
  return path.join(root, 'state', 'jobs.json');
};

const job = (
  id: string,
  status: VideoGenerationJob['status'] = 'queued',
  progress = 0,
): VideoGenerationJob => ({
  id,
  providerId: 'wangp',
  status,
  progress,
  createdAt: '2026-07-16T08:00:00.000Z',
  updatedAt: '2026-07-16T08:00:00.000Z',
  seed: 42,
});

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, {recursive: true, force: true})));
});

describe('FileVideoGenerationJobStore', () => {
  it('atomically persists jobs and does not expose mutable internal state', async () => {
    const filePath = await temporaryStorePath();
    const store = new FileVideoGenerationJobStore(filePath);
    const original = job('candidate-01');

    const persisted = await store.upsert(original);
    original.progress = 0.9;
    persisted.progress = 0.7;

    expect(await store.get('candidate-01')).toMatchObject({status: 'queued', progress: 0});
    expect(JSON.parse(await fs.readFile(filePath, 'utf8'))).toMatchObject({
      version: 1,
      jobs: [{id: 'candidate-01', status: 'queued', progress: 0}],
    });
    expect((await fs.readdir(path.dirname(filePath))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it.each(['preparing', 'running', 'downloading'] as const)(
    'recovers a %s job as a retryable interruption, never as complete',
    async (status) => {
      const filePath = await temporaryStorePath();
      await new FileVideoGenerationJobStore(filePath).upsert(job('candidate-01', status, 0.64));

      const [recovered] = await new FileVideoGenerationJobStore(filePath).initialize();

      expect(recovered).toMatchObject({
        id: 'candidate-01',
        status: 'failed',
        progress: 0.64,
        error: {
          code: 'JOB_INTERRUPTED',
          details: {recoverable: true, previousStatus: status},
        },
      });
      expect(recovered?.status).not.toBe('complete');
    },
  );

  it('leaves completed and queued jobs intact across restart', async () => {
    const filePath = await temporaryStorePath();
    const first = new FileVideoGenerationJobStore(filePath);
    await first.upsert(job('candidate-01', 'complete', 1));
    await first.upsert(job('candidate-02', 'queued', 0));

    const jobs = await new FileVideoGenerationJobStore(filePath).initialize();

    expect(jobs.map(({id, status}) => ({id, status}))).toEqual([
      {id: 'candidate-01', status: 'complete'},
      {id: 'candidate-02', status: 'queued'},
    ]);
  });
});

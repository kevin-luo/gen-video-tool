import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {AddressInfo} from 'node:net';

import {afterEach, describe, expect, it} from 'vitest';

import {createStudioApp} from '../../../apps/codex-studio/src/server';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, {recursive: true, force: true})));
});

describe('creator-mode routes', () => {
  it('persists a bounded script as an awaiting-assets paper-collage request', async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gen-video-creator-route-'));
    roots.push(dataRoot);
    const token = 'test-session-token-0123456789-abcdefghijklmnopqrstuvwxyz';
    const app = await createStudioApp({
      repositoryRoot: path.join(dataRoot, 'empty-repository'),
      dataRoot,
      projectsRoot: path.join(dataRoot, 'projects'),
      outputRoot: path.join(dataRoot, 'output'),
      jobsFile: path.join(dataRoot, 'jobs.json'),
      host: '127.0.0.1',
      port: 4390,
      baseUrl: 'http://127.0.0.1:4390',
      sessionToken: token,
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const response = await fetch(`http://127.0.0.1:${port}/api/creations?session=${token}`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({
          script: '小猫在夜市认真炒完最后一份炒粉。',
          platform: 'douyin',
          durationSeconds: 20,
          voice: true,
        }),
      });
      expect(response.status).toBe(202);
      const creation = await response.json() as Record<string, unknown>;
      expect(creation).toMatchObject({
        platform: 'douyin',
        durationSeconds: 20,
        voice: true,
        subtitles: 'sidecar-srt',
        bgm: false,
        visualMode: 'paper-collage',
        assetStatus: 'awaiting-assets',
        status: 'awaiting-assets',
      });
      expect(creation.jobId).toBeUndefined();

      const listResponse = await fetch(`http://127.0.0.1:${port}/api/creations?session=${token}`);
      const list = await listResponse.json() as {total: number; creations: unknown[]};
      expect(list.total).toBe(1);
      expect(list.creations).toHaveLength(1);
      const jobs = await fetch(`http://127.0.0.1:${port}/api/jobs?session=${token}`).then(async (item) => await item.json()) as {jobs: unknown[]};
      expect(jobs.jobs).toEqual([]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('rejects unsupported durations and oversized scripts before creating a job', async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gen-video-creator-limit-'));
    roots.push(dataRoot);
    const token = 'test-session-token-0123456789-abcdefghijklmnopqrstuvwxyz';
    const app = await createStudioApp({
      repositoryRoot: path.join(dataRoot, 'empty-repository'),
      dataRoot,
      projectsRoot: path.join(dataRoot, 'projects'),
      outputRoot: path.join(dataRoot, 'output'),
      jobsFile: path.join(dataRoot, 'jobs.json'),
      host: '127.0.0.1',
      port: 4390,
      baseUrl: 'http://127.0.0.1:4390',
      sessionToken: token,
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const shortResponse = await fetch(`http://127.0.0.1:${port}/api/creations?session=${token}`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({script: '小猫认真炒完一份炒粉。', platform: 'douyin', durationSeconds: 15, voice: true}),
      });
      expect(shortResponse.status).toBe(400);
      const response = await fetch(`http://127.0.0.1:${port}/api/creations?session=${token}`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({script: '猫'.repeat(301), platform: 'douyin', durationSeconds: 20, voice: true}),
      });
      expect(response.status).toBe(400);
      const jobs = await fetch(`http://127.0.0.1:${port}/api/jobs?session=${token}`).then(async (item) => await item.json()) as {jobs: unknown[]};
      expect(jobs.jobs).toEqual([]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

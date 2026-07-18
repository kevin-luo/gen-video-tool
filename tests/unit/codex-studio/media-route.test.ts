import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {AddressInfo} from 'node:net';
import {afterEach, describe, expect, it} from 'vitest';

import {createStudioApp} from '../../../apps/codex-studio/src/server';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, {recursive: true, force: true})));
});

describe('Codex Studio media route', () => {
  it('serves byte ranges from the hidden local data directory', async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gen-video-studio-media-'));
    temporaryRoots.push(temporaryRoot);
    const dataRoot = path.join(temporaryRoot, '.studio-data');
    const projectsRoot = path.join(dataRoot, 'projects');
    const outputRoot = path.join(dataRoot, 'output');
    const mediaPath = path.join(projectsRoot, 'demo-project', 'generated', 'video', 'candidate.mp4');
    await fs.mkdir(path.dirname(mediaPath), {recursive: true});
    await fs.writeFile(mediaPath, Buffer.from('0123456789'));

    const token = 'test-session-token-0123456789-abcdefghijklmnopqrstuvwxyz';
    const app = await createStudioApp({
      repositoryRoot: path.resolve(import.meta.dirname, '../../..'),
      dataRoot,
      projectsRoot,
      outputRoot,
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
      const response = await fetch(
        `http://127.0.0.1:${port}/api/media?session=${token}&scope=project&projectId=demo-project&path=generated%2Fvideo%2Fcandidate.mp4`,
        {headers: {range: 'bytes=2-5'}},
      );
      expect(response.status).toBe(206);
      expect(response.headers.get('accept-ranges')).toBe('bytes');
      expect(await response.text()).toBe('2345');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

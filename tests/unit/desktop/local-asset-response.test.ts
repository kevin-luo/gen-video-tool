import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {
  createLocalAssetResponse,
  parseByteRange,
} from '../../../apps/desktop/src/main/local-asset-response';

const roots: string[] = [];

const makeFixture = async (): Promise<string> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gen-video-asset-response-'));
  roots.push(root);
  const target = path.join(root, 'voice.wav');
  await fs.writeFile(target, Buffer.from(Array.from({length: 32}, (_, index) => index)));
  return target;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, {recursive: true, force: true})));
});

describe('desktop local asset range responses', () => {
  it('parses open, closed, and suffix byte ranges', () => {
    expect(parseByteRange(null, 100)).toBeNull();
    expect(parseByteRange('bytes=5-9', 100)).toEqual({start: 5, end: 9});
    expect(parseByteRange('bytes=95-', 100)).toEqual({start: 95, end: 99});
    expect(parseByteRange('bytes=-8', 100)).toEqual({start: 92, end: 99});
    expect(parseByteRange('bytes=100-', 100)).toBe('invalid');
    expect(parseByteRange('bytes=10-2', 100)).toBe('invalid');
  });

  it('returns a seekable 206 response for media range requests', async () => {
    const target = await makeFixture();
    const response = await createLocalAssetResponse(
      target,
      new Request('gen-video-asset://fixture/voice.wav', {headers: {Range: 'bytes=4-11'}}),
    );

    expect(response.status).toBe(206);
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('content-range')).toBe('bytes 4-11/32');
    expect(response.headers.get('content-length')).toBe('8');
    expect(response.headers.get('content-type')).toBe('audio/wav');
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('returns 416 for an unsatisfiable range', async () => {
    const target = await makeFixture();
    const response = await createLocalAssetResponse(
      target,
      new Request('gen-video-asset://fixture/voice.wav', {headers: {Range: 'bytes=99-'}}),
    );

    expect(response.status).toBe(416);
    expect(response.headers.get('content-range')).toBe('bytes */32');
  });
});

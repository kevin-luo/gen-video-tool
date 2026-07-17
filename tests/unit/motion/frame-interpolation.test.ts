import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {runRifeInterpolation} from '@gen-video-tool/frame-interpolation';

const temporaryRoots: string[] = [];
const temporaryRoot = async (): Promise<string> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gen-video-rife-'));
  temporaryRoots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, {recursive: true, force: true})));
});

describe('optional RIFE delivery interpolation', () => {
  it('rejects a destructive in-place request before launching a worker', async () => {
    const root = await temporaryRoot();
    await expect(runRifeInterpolation(path.resolve(root, 'rife.exe'), {
      inputDirectory: root,
      outputDirectory: root,
    })).rejects.toThrow('RIFE_OUTPUT_MUST_DIFFER');
  });

  it('does not erase an existing output directory', async () => {
    const root = await temporaryRoot();
    const input = path.join(root, 'input');
    const output = path.join(root, 'output');
    await fs.mkdir(input);
    await fs.mkdir(output);
    await fs.writeFile(path.join(input, 'frame_000001.png'), 'a');
    await fs.writeFile(path.join(input, 'frame_000002.png'), 'b');
    await fs.writeFile(path.join(output, 'keep.txt'), 'keep');
    await expect(runRifeInterpolation(path.resolve(root, 'rife.exe'), {
      inputDirectory: input,
      outputDirectory: output,
    })).rejects.toThrow('RIFE_OUTPUT_NOT_EMPTY');
    await expect(fs.readFile(path.join(output, 'keep.txt'), 'utf8')).resolves.toBe('keep');
  });
});

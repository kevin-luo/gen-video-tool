import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import sharp from 'sharp';
import {afterEach, describe, expect, it} from 'vitest';

import {stylizePaperCutout} from '../../../scripts/stylize-paper-cutout';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, {recursive: true, force: true})));
});

describe('stylizePaperCutout', () => {
  it('keeps the complete silhouette and alpha while applying printed dots', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gen-video-paper-style-'));
    roots.push(root);
    const input = path.join(root, 'input.png');
    const output = path.join(root, 'output.png');
    const pixels = Buffer.alloc(16 * 16 * 4);
    for (let y = 2; y < 14; y += 1) {
      for (let x = 3; x < 13; x += 1) {
        const offset = (y * 16 + x) * 4;
        pixels[offset] = 210;
        pixels[offset + 1] = 80;
        pixels[offset + 2] = 40;
        pixels[offset + 3] = 255;
      }
    }
    await sharp(pixels, {raw: {width: 16, height: 16, channels: 4}}).png().toFile(input);

    const result = await stylizePaperCutout({inputPath: input, outputPath: output, cellSize: 4});
    expect(result).toEqual({width: 16, height: 16, cellSize: 4});
    const decoded = await sharp(output).ensureAlpha().raw().toBuffer({resolveWithObject: true});
    expect(decoded.info.width).toBe(16);
    expect(decoded.info.height).toBe(16);
    expect(decoded.data[(0 * 16 + 0) * 4 + 3]).toBe(0);
    expect(decoded.data[(8 * 16 + 8) * 4 + 3]).toBe(255);
    const distinctRgb = new Set<number>();
    for (let offset = 0; offset < decoded.data.length; offset += 4) {
      if (decoded.data[offset + 3] !== 0) distinctRgb.add(decoded.data[offset] ?? 0);
    }
    expect(distinctRgb.size).toBeGreaterThan(1);
  });

  it('rejects in-place writes and unsupported dot sizes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gen-video-paper-style-invalid-'));
    roots.push(root);
    const input = path.join(root, 'input.png');
    await sharp({create: {width: 4, height: 4, channels: 4, background: {r: 1, g: 2, b: 3, alpha: 1}}}).png().toFile(input);
    await expect(stylizePaperCutout({inputPath: input, outputPath: input})).rejects.toThrow('PAPER_STYLE_OUTPUT_MUST_DIFFER_FROM_INPUT');
    await expect(stylizePaperCutout({inputPath: input, outputPath: path.join(root, 'out.png'), cellSize: 2})).rejects.toThrow('PAPER_STYLE_CELL_SIZE_INVALID');
  });
});

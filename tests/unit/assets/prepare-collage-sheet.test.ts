import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {afterEach, describe, expect, it} from 'vitest';
import {
  parsePrepareCollageSheetArgs,
  prepareCollageSheet,
} from '../../../scripts/prepare-collage-sheet.ts';

const temporaryDirectories: string[] = [];

const makeTemporaryDirectory = async (): Promise<string> => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'prepare-collage-sheet-'));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await fs.rm(directory, {recursive: true, force: true});
  }));
});

const svg = (width: number, height: number, body: string): Buffer => Buffer.from(
  `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${body}</svg>`,
);

describe('prepareCollageSheet', () => {
  it('keys a 3x2 green-screen sheet, pads PNGs, and reports empty and cross-cell material', async () => {
    const root = await makeTemporaryDirectory();
    const inputPath = path.join(root, 'sheet.png');
    const outputDirectory = path.join(root, 'pieces');
    await sharp({
      create: {width: 180, height: 120, channels: 3, background: '#00ff00'},
    }).composite([{
      input: svg(180, 120, [
        '<rect x="12" y="12" width="26" height="24" fill="#ef4444"/>',
        '<rect x="52" y="20" width="18" height="16" fill="#2563eb"/>',
        '<rect x="128" y="12" width="22" height="22" fill="#f97316"/>',
        '<rect x="16" y="78" width="24" height="22" fill="#7c3aed"/>',
        '<rect x="78" y="76" width="22" height="24" fill="#0891b2"/>',
      ].join('')),
    }]).png().toFile(inputPath);

    const manifest = await prepareCollageSheet({
      inputPath,
      outputDirectory,
      chroma: '#00ff00',
      chromaTolerance: 20,
      chromaSoftness: 0,
      padding: 5,
      edgeBand: 2,
    });

    expect(manifest.cells).toHaveLength(6);
    expect(manifest.cells[5]?.status).toBe('empty');
    expect(manifest.qa.issues.some((issue) => issue.code === 'empty-cell' && issue.cells.includes(5))).toBe(true);
    expect(manifest.boundaries.some((boundary) => (
      boundary.firstCell === 0
      && boundary.secondCell === 1
      && boundary.suspectedCrossCellFragment
    ))).toBe(true);
    expect(manifest.qa.issues.some((issue) => issue.code === 'cross-cell-fragment')).toBe(true);

    const firstOutput = path.join(outputDirectory, manifest.cells[0]?.output.path ?? 'missing.png');
    const decoded = await sharp(firstOutput).ensureAlpha().raw().toBuffer({resolveWithObject: true});
    expect(decoded.info.channels).toBe(4);
    const cornerOffsets = [
      3,
      (decoded.info.width - 1) * 4 + 3,
      ((decoded.info.height - 1) * decoded.info.width) * 4 + 3,
      (decoded.info.height * decoded.info.width - 1) * 4 + 3,
    ];
    expect(cornerOffsets.map((offset) => decoded.data[offset])).toEqual([0, 0, 0, 0]);
    await expect(fs.readFile(path.join(outputDirectory, 'manifest.json'), 'utf8')).resolves.toContain('cross-cell-fragment');
  });

  it('supports configurable alpha grids with uneven cell widths and deterministic trim padding', async () => {
    const root = await makeTemporaryDirectory();
    const inputPath = path.join(root, 'alpha-sheet.png');
    const outputDirectory = path.join(root, 'pieces');
    await sharp({
      create: {width: 101, height: 40, channels: 4, background: {r: 0, g: 0, b: 0, alpha: 0}},
    }).composite([{
      input: svg(101, 40, [
        '<rect x="10" y="10" width="20" height="20" fill="#dc2626"/>',
        '<rect x="66" y="10" width="20" height="20" fill="#2563eb"/>',
      ].join('')),
    }]).png().toFile(inputPath);

    const manifest = await prepareCollageSheet({
      inputPath,
      outputDirectory,
      rows: 1,
      columns: 2,
      padding: 3,
      prefix: 'actor',
    });

    expect(manifest.qa.passed).toBe(true);
    expect(manifest.cells.map((cell) => cell.sourceRect.width)).toEqual([50, 51]);
    expect(manifest.cells.map((cell) => cell.output)).toEqual([
      {path: 'actor-r01-c01.png', width: 26, height: 26},
      {path: 'actor-r01-c02.png', width: 26, height: 26},
    ]);
    expect(manifest.cells.every((cell) => Object.values(cell.transparentCorners).every(Boolean))).toBe(true);
    expect(manifest.cells.every((cell) => cell.alphaCoverage.source > 0 && cell.alphaCoverage.source < 1)).toBe(true);
  });

  it('removes green spill from anti-aliased keyed edges while preserving opaque colors', async () => {
    const root = await makeTemporaryDirectory();
    const inputPath = path.join(root, 'spill-sheet.png');
    const outputDirectory = path.join(root, 'pieces');
    await sharp({
      create: {width: 20, height: 20, channels: 4, background: {r: 0, g: 255, b: 0, alpha: 1}},
    }).composite([{
      input: svg(20, 20, '<rect x="5" y="5" width="10" height="10" fill="#f5e6c8"/>'),
    }]).png().toFile(inputPath);

    const manifest = await prepareCollageSheet({
      inputPath,
      outputDirectory,
      rows: 1,
      columns: 1,
      chroma: '#00ff00',
      chromaTolerance: 10,
      chromaSoftness: 80,
      padding: 2,
    });
    expect(manifest.qa.passed).toBe(true);
    const outputPath = path.join(outputDirectory, 'piece-r01-c01.png');
    const decoded = await sharp(outputPath).ensureAlpha().raw().toBuffer({resolveWithObject: true});
    const edgeOffset = (2 * decoded.info.width + 2) * 4;
    expect(decoded.data[edgeOffset + 1]).toBeLessThan(245);
  });

  it('never allows the manifest or an output destination to overwrite the input sheet', async () => {
    const root = await makeTemporaryDirectory();
    const inputPath = path.join(root, 'sheet.png');
    await sharp({
      create: {width: 20, height: 20, channels: 4, background: {r: 255, g: 0, b: 0, alpha: 1}},
    }).png().toFile(inputPath);

    await expect(prepareCollageSheet({
      inputPath,
      outputDirectory: path.join(root, 'pieces'),
      rows: 1,
      columns: 1,
      manifestPath: inputPath,
      overwrite: true,
    })).rejects.toThrow('DESTINATION_OVERLAPS_INPUT');
  });

  it('parses explicit CLI grid and matte settings without positional ambiguity', () => {
    const parsed = parsePrepareCollageSheetArgs([
      '--input', 'sheet.png',
      '--output-dir', 'pieces',
      '--rows', '3',
      '--columns', '4',
      '--chroma', 'green',
      '--padding', '24',
      '--force',
      '--allow-qa-issues',
    ]);

    expect(parsed.help).toBe(false);
    expect(parsed.allowQaIssues).toBe(true);
    expect(parsed.options).toMatchObject({
      inputPath: 'sheet.png',
      outputDirectory: 'pieces',
      rows: 3,
      columns: 4,
      chroma: 'green',
      padding: 24,
      overwrite: true,
    });
  });
});

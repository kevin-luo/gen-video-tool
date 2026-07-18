import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import sharp from 'sharp';

type Rgb = {r: number; g: number; b: number};

export type StylizePaperCutoutOptions = {
  inputPath: string;
  outputPath: string;
  /** Printed-dot pitch in source pixels. */
  cellSize?: number;
  ink?: string;
  paper?: string;
  overwrite?: boolean;
};

const parseColor = (value: string, label: string): Rgb => {
  const normalized = value.trim().replace(/^#/u, '');
  if (!/^[0-9a-fA-F]{6}$/u.test(normalized)) throw new Error(`${label}_COLOR_INVALID:${value}`);
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16),
  };
};

const mix = (from: number, to: number, amount: number): number => (
  Math.round(from + (to - from) * Math.min(1, Math.max(0, amount)))
);

/**
 * Turns an existing complete RGBA cutout into a two-ink editorial halftone.
 * Geometry and alpha are copied exactly; only RGB ink is restyled, so the
 * operation cannot invent limbs, warp a silhouette, or change its pose.
 */
export const stylizePaperCutout = async (
  requested: StylizePaperCutoutOptions,
): Promise<{width: number; height: number; cellSize: number}> => {
  const inputPath = path.resolve(requested.inputPath);
  const outputPath = path.resolve(requested.outputPath);
  if (inputPath.toLocaleLowerCase('en-US') === outputPath.toLocaleLowerCase('en-US')) {
    throw new Error('PAPER_STYLE_OUTPUT_MUST_DIFFER_FROM_INPUT');
  }
  const cellSize = requested.cellSize ?? 6;
  if (!Number.isInteger(cellSize) || cellSize < 3 || cellSize > 32) {
    throw new Error(`PAPER_STYLE_CELL_SIZE_INVALID:${cellSize}`);
  }
  const inputStat = await fs.stat(inputPath).catch(() => null);
  if (inputStat?.isFile() !== true) throw new Error(`PAPER_STYLE_INPUT_NOT_FOUND:${inputPath}`);
  const outputStat = await fs.stat(outputPath).catch(() => null);
  if (outputStat !== null && requested.overwrite !== true) {
    throw new Error(`PAPER_STYLE_OUTPUT_EXISTS:${outputPath}`);
  }

  const ink = parseColor(requested.ink ?? '#25282b', 'INK');
  const paper = parseColor(requested.paper ?? '#f1dfba', 'PAPER');
  const decoded = await sharp(inputPath).ensureAlpha().raw().toBuffer({resolveWithObject: true});
  const {width, height, channels} = decoded.info;
  if (channels !== 4) throw new Error(`PAPER_STYLE_RGBA_REQUIRED:${channels}`);
  const output = Buffer.alloc(decoded.data.length);

  for (let cellTop = 0; cellTop < height; cellTop += cellSize) {
    for (let cellLeft = 0; cellLeft < width; cellLeft += cellSize) {
      const cellRight = Math.min(width, cellLeft + cellSize);
      const cellBottom = Math.min(height, cellTop + cellSize);
      let weightedLuminance = 0;
      let alphaWeight = 0;
      for (let y = cellTop; y < cellBottom; y += 1) {
        for (let x = cellLeft; x < cellRight; x += 1) {
          const offset = (y * width + x) * 4;
          const alpha = decoded.data[offset + 3] ?? 0;
          if (alpha === 0) continue;
          const red = decoded.data[offset] ?? 0;
          const green = decoded.data[offset + 1] ?? 0;
          const blue = decoded.data[offset + 2] ?? 0;
          const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
          weightedLuminance += luminance * alpha;
          alphaWeight += alpha;
        }
      }
      const coverage = alphaWeight === 0
        ? 0
        : Math.min(1, Math.max(0, 1 - weightedLuminance / alphaWeight / 255));
      const dotRadius = cellSize * Math.sqrt(coverage / Math.PI);
      const centerX = cellLeft + (cellRight - cellLeft) / 2;
      const centerY = cellTop + (cellBottom - cellTop) / 2;
      for (let y = cellTop; y < cellBottom; y += 1) {
        for (let x = cellLeft; x < cellRight; x += 1) {
          const offset = (y * width + x) * 4;
          const alpha = decoded.data[offset + 3] ?? 0;
          if (alpha === 0) continue;
          const distance = Math.hypot(x + 0.5 - centerX, y + 0.5 - centerY);
          const inkAmount = dotRadius <= 0
            ? 0
            : Math.min(1, Math.max(0, dotRadius + 0.75 - distance));
          output[offset] = mix(paper.r, ink.r, inkAmount);
          output[offset + 1] = mix(paper.g, ink.g, inkAmount);
          output[offset + 2] = mix(paper.b, ink.b, inkAmount);
          output[offset + 3] = alpha;
        }
      }
    }
  }

  await fs.mkdir(path.dirname(outputPath), {recursive: true});
  await sharp(output, {raw: {width, height, channels: 4}})
    .png({compressionLevel: 9, adaptiveFiltering: true})
    .toFile(outputPath);
  return {width, height, cellSize};
};

const usage = 'Usage: npx tsx scripts/stylize-paper-cutout.ts <input.png> <output.png> [cell-size]';

const main = async (): Promise<void> => {
  const [inputPath, outputPath, cellSizeValue] = process.argv.slice(2);
  if (inputPath === undefined || outputPath === undefined) throw new Error(usage);
  const result = await stylizePaperCutout({
    inputPath,
    outputPath,
    ...(cellSizeValue === undefined ? {} : {cellSize: Number(cellSizeValue)}),
    overwrite: true,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
};

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(path.resolve(entryPath)).href) {
  await main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

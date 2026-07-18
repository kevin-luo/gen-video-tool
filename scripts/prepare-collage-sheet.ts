import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import sharp from 'sharp';

type RgbColor = {r: number; g: number; b: number};
type EdgeName = 'top' | 'right' | 'bottom' | 'left';
type QaSeverity = 'error' | 'warning';

export type PrepareCollageSheetOptions = {
  inputPath: string;
  outputDirectory: string;
  /** Grid rows. Defaults to 2 for a 3x2 asset sheet. */
  rows?: number;
  /** Grid columns. Defaults to 3 for a 3x2 asset sheet. */
  columns?: number;
  /** Optional chroma key, for example #00ff00, green, or 0,255,0. */
  chroma?: string | null;
  /** Fully transparent distance from the chroma color in RGB space. */
  chromaTolerance?: number;
  /** Distance over which keyed pixels transition to their source alpha. */
  chromaSoftness?: number;
  /** Transparent pixels retained around every trimmed asset. */
  padding?: number;
  /** Alpha values at or below this threshold count as transparent. */
  alphaThreshold?: number;
  /** Cells below this mean-alpha coverage are reported as empty. */
  minAlphaCoverage?: number;
  /** Width in source pixels inspected at every grid boundary. */
  edgeBand?: number;
  /** Output filename prefix. */
  prefix?: string;
  /** Defaults to <outputDirectory>/manifest.json. */
  manifestPath?: string;
  /** May replace prior outputs, but can never replace the input sheet. */
  overwrite?: boolean;
};

export type CollageSheetQaIssue = {
  severity: QaSeverity;
  code: string;
  message: string;
  cells: number[];
  boundary?: {
    orientation: 'vertical' | 'horizontal';
    firstCell: number;
    secondCell: number;
  };
};

export type CollageSheetCellManifest = {
  index: number;
  row: number;
  column: number;
  sourceRect: {left: number; top: number; width: number; height: number};
  trimBox: {left: number; top: number; width: number; height: number} | null;
  output: {path: string; width: number; height: number};
  alphaCoverage: {source: number; output: number};
  transparentCorners: {
    topLeft: boolean;
    topRight: boolean;
    bottomRight: boolean;
    bottomLeft: boolean;
  };
  edgeOccupancy: Record<EdgeName, number>;
  status: 'ok' | 'needs-review' | 'empty';
  issues: string[];
};

export type CollageSheetBoundaryManifest = {
  orientation: 'vertical' | 'horizontal';
  firstCell: number;
  secondCell: number;
  matchingForegroundSamples: number;
  sampleCount: number;
  overlapFraction: number;
  suspectedCrossCellFragment: boolean;
};

export type CollageSheetManifest = {
  schemaVersion: 1;
  source: {
    path: string;
    width: number;
    height: number;
    channels: number;
    hasAlpha: boolean;
    rows: number;
    columns: number;
  };
  options: {
    chroma: RgbColor | null;
    chromaTolerance: number;
    chromaSoftness: number;
    padding: number;
    alphaThreshold: number;
    minAlphaCoverage: number;
    edgeBand: number;
    prefix: string;
  };
  cells: CollageSheetCellManifest[];
  boundaries: CollageSheetBoundaryManifest[];
  qa: {
    passed: boolean;
    errorCount: number;
    warningCount: number;
    issues: CollageSheetQaIssue[];
  };
};

type NormalizedOptions = {
  inputPath: string;
  outputDirectory: string;
  rows: number;
  columns: number;
  chroma: RgbColor | null;
  chromaTolerance: number;
  chromaSoftness: number;
  padding: number;
  alphaThreshold: number;
  minAlphaCoverage: number;
  edgeBand: number;
  prefix: string;
  manifestPath: string;
  overwrite: boolean;
};

type RawImage = {data: Buffer; width: number; height: number};
type EdgeProfiles = Record<EdgeName, boolean[]>;
type PreparedCell = {
  raw: RawImage;
  profiles: EdgeProfiles;
  manifest: CollageSheetCellManifest;
};

const defaultRows = 2;
const defaultColumns = 3;
const defaultChromaTolerance = 48;
const defaultChromaSoftness = 32;
const defaultPadding = 16;
const defaultAlphaThreshold = 8;
const defaultMinAlphaCoverage = 0.002;
const defaultEdgeBand = 2;

const round = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;

const parseInteger = (name: string, value: number, minimum: number, maximum: number): number => {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name.toUpperCase()}_OUT_OF_RANGE:${value}`);
  }
  return value;
};

const parseFinite = (name: string, value: number, minimum: number, maximum: number): number => {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name.toUpperCase()}_OUT_OF_RANGE:${value}`);
  }
  return value;
};

const parseChroma = (value: string | null | undefined): RgbColor | null => {
  if (value === undefined || value === null || value.trim().toLowerCase() === 'none') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'green') return {r: 0, g: 255, b: 0};
  const hex = normalized.startsWith('#') ? normalized.slice(1) : normalized;
  if (/^[0-9a-f]{6}$/u.test(hex)) {
    return {
      r: Number.parseInt(hex.slice(0, 2), 16),
      g: Number.parseInt(hex.slice(2, 4), 16),
      b: Number.parseInt(hex.slice(4, 6), 16),
    };
  }
  const channels = normalized.split(',').map((part) => Number(part.trim()));
  if (channels.length === 3 && channels.every((channel) => Number.isInteger(channel) && channel >= 0 && channel <= 255)) {
    const [r, g, b] = channels;
    if (r !== undefined && g !== undefined && b !== undefined) return {r, g, b};
  }
  throw new Error(`CHROMA_COLOR_INVALID:${value}`);
};

const normalizeOptions = (options: PrepareCollageSheetOptions): NormalizedOptions => {
  const inputPath = path.resolve(options.inputPath);
  const outputDirectory = path.resolve(options.outputDirectory);
  const prefix = options.prefix ?? 'piece';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(prefix)) {
    throw new Error(`OUTPUT_PREFIX_INVALID:${prefix}`);
  }
  return {
    inputPath,
    outputDirectory,
    rows: parseInteger('rows', options.rows ?? defaultRows, 1, 100),
    columns: parseInteger('columns', options.columns ?? defaultColumns, 1, 100),
    chroma: parseChroma(options.chroma),
    chromaTolerance: parseFinite('chroma_tolerance', options.chromaTolerance ?? defaultChromaTolerance, 0, 442),
    chromaSoftness: parseFinite('chroma_softness', options.chromaSoftness ?? defaultChromaSoftness, 0, 442),
    padding: parseInteger('padding', options.padding ?? defaultPadding, 0, 4_096),
    alphaThreshold: parseInteger('alpha_threshold', options.alphaThreshold ?? defaultAlphaThreshold, 0, 254),
    minAlphaCoverage: parseFinite('min_alpha_coverage', options.minAlphaCoverage ?? defaultMinAlphaCoverage, 0, 1),
    edgeBand: parseInteger('edge_band', options.edgeBand ?? defaultEdgeBand, 1, 1_024),
    prefix,
    manifestPath: path.resolve(options.manifestPath ?? path.join(outputDirectory, 'manifest.json')),
    overwrite: options.overwrite ?? false,
  };
};

const canonicalDestination = async (destination: string): Promise<string> => {
  const existing = await fs.realpath(destination).catch(() => null);
  if (existing !== null) return path.normalize(existing).toLowerCase();
  const parent = await fs.realpath(path.dirname(destination)).catch(() => path.resolve(path.dirname(destination)));
  return path.normalize(path.join(parent, path.basename(destination))).toLowerCase();
};

const ensureSafeDestinations = async (
  inputPath: string,
  destinations: string[],
  overwrite: boolean,
): Promise<void> => {
  const canonicalInput = path.normalize(await fs.realpath(inputPath)).toLowerCase();
  const canonicalDestinations = await Promise.all(destinations.map(canonicalDestination));
  const unique = new Set(canonicalDestinations);
  if (unique.size !== canonicalDestinations.length) throw new Error('DUPLICATE_OUTPUT_DESTINATION');
  for (const [index, destination] of destinations.entries()) {
    if (canonicalDestinations[index] === canonicalInput) {
      throw new Error(`DESTINATION_OVERLAPS_INPUT:${destination}`);
    }
    const stat = await fs.stat(destination).catch(() => null);
    if (stat?.isDirectory() === true) throw new Error(`OUTPUT_DESTINATION_IS_DIRECTORY:${destination}`);
    if (stat !== null && !overwrite) throw new Error(`OUTPUT_ALREADY_EXISTS:${destination}`);
  }
};

const applyChromaAlpha = (source: Buffer, chroma: RgbColor | null, tolerance: number, softness: number): Buffer => {
  if (chroma === null) return Buffer.from(source);
  const output = Buffer.from(source);
  const transitionEnd = tolerance + softness;
  for (let offset = 0; offset < output.length; offset += 4) {
    const red = output[offset] ?? 0;
    const green = output[offset + 1] ?? 0;
    const blue = output[offset + 2] ?? 0;
    const sourceAlpha = output[offset + 3] ?? 0;
    const distance = Math.hypot(red - chroma.r, green - chroma.g, blue - chroma.b);
    const keyAlpha = distance <= tolerance
      ? 0
      : softness === 0 || distance >= transitionEnd
        ? 1
        : (distance - tolerance) / softness;
    const alpha = Math.round(sourceAlpha * keyAlpha);
    output[offset + 3] = alpha;
    const residualGreenScreen = green > 100 && green - Math.max(red, blue) > 25;
    if (residualGreenScreen) {
      // A hard chroma edge can remain above the soft-key range because the
      // generator painted a saturated green pixel, not an anti-aliased mix.
      // Treat that unmistakable screen color as transparent instead of
      // leaving isolated neon specks around the paper outline.
      output[offset] = 0;
      output[offset + 1] = 0;
      output[offset + 2] = 0;
      output[offset + 3] = 0;
    } else if (alpha === 0) {
      output[offset] = 0;
      output[offset + 1] = 0;
      output[offset + 2] = 0;
    } else if (
      chroma.g >= chroma.r
      && chroma.g >= chroma.b
      && (
        keyAlpha < 1
        || (green > 150 && green - Math.max(red, blue) > 18)
      )
    ) {
      // Anti-aliased edges contain a mixture of foreground and the green
      // screen. Alpha-keying alone leaves a fluorescent fringe after the
      // screen is composited away. Remove only the estimated green spill;
      // opaque interior pixels stay byte-for-byte unchanged.
      const spill = keyAlpha < 1
        ? Math.max(0, Math.min(1, 1 - keyAlpha))
        : 1;
      const neutralGreen = Math.max(red, blue);
      output[offset + 1] = Math.max(0, Math.round(green - (green - neutralGreen) * spill));
    }
  }
  return output;
};

const extractRaw = (source: RawImage, left: number, top: number, width: number, height: number): RawImage => {
  const output = Buffer.alloc(width * height * 4);
  const rowBytes = width * 4;
  for (let row = 0; row < height; row += 1) {
    const sourceStart = ((top + row) * source.width + left) * 4;
    source.data.copy(output, row * rowBytes, sourceStart, sourceStart + rowBytes);
  }
  return {data: output, width, height};
};

const alphaAt = (image: RawImage, x: number, y: number): number => image.data[(y * image.width + x) * 4 + 3] ?? 0;

const alphaCoverage = (image: RawImage): number => {
  if (image.width === 0 || image.height === 0) return 0;
  let alpha = 0;
  for (let offset = 3; offset < image.data.length; offset += 4) alpha += image.data[offset] ?? 0;
  return round(alpha / (image.width * image.height * 255));
};

const findAlphaBounds = (
  image: RawImage,
  threshold: number,
): {left: number; top: number; width: number; height: number} | null => {
  let minimumX = image.width;
  let minimumY = image.height;
  let maximumX = -1;
  let maximumY = -1;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (alphaAt(image, x, y) <= threshold) continue;
      minimumX = Math.min(minimumX, x);
      minimumY = Math.min(minimumY, y);
      maximumX = Math.max(maximumX, x);
      maximumY = Math.max(maximumY, y);
    }
  }
  if (maximumX < minimumX || maximumY < minimumY) return null;
  return {
    left: minimumX,
    top: minimumY,
    width: maximumX - minimumX + 1,
    height: maximumY - minimumY + 1,
  };
};

const addTransparentPadding = (image: RawImage | null, padding: number): RawImage => {
  const innerWidth = image?.width ?? 1;
  const innerHeight = image?.height ?? 1;
  const width = innerWidth + padding * 2;
  const height = innerHeight + padding * 2;
  const output = Buffer.alloc(width * height * 4);
  if (image !== null) {
    const rowBytes = image.width * 4;
    for (let row = 0; row < image.height; row += 1) {
      const destinationStart = ((row + padding) * width + padding) * 4;
      image.data.copy(output, destinationStart, row * rowBytes, (row + 1) * rowBytes);
    }
  }
  return {data: output, width, height};
};

const edgeProfiles = (image: RawImage, requestedBand: number, threshold: number): EdgeProfiles => {
  const band = Math.max(1, Math.min(requestedBand, image.width, image.height));
  const top = Array.from({length: image.width}, (_, x) => {
    for (let y = 0; y < band; y += 1) if (alphaAt(image, x, y) > threshold) return true;
    return false;
  });
  const bottom = Array.from({length: image.width}, (_, x) => {
    for (let y = image.height - band; y < image.height; y += 1) if (alphaAt(image, x, y) > threshold) return true;
    return false;
  });
  const left = Array.from({length: image.height}, (_, y) => {
    for (let x = 0; x < band; x += 1) if (alphaAt(image, x, y) > threshold) return true;
    return false;
  });
  const right = Array.from({length: image.height}, (_, y) => {
    for (let x = image.width - band; x < image.width; x += 1) if (alphaAt(image, x, y) > threshold) return true;
    return false;
  });
  return {top, right, bottom, left};
};

const occupancy = (profile: boolean[]): number => profile.length === 0
  ? 0
  : round(profile.filter(Boolean).length / profile.length);

const profileOverlap = (first: boolean[], second: boolean[]): {matches: number; samples: number} => {
  const samples = Math.max(first.length, second.length);
  let matches = 0;
  for (let index = 0; index < samples; index += 1) {
    const firstIndex = Math.min(first.length - 1, Math.floor(index * first.length / samples));
    const secondIndex = Math.min(second.length - 1, Math.floor(index * second.length / samples));
    if (first[firstIndex] === true && second[secondIndex] === true) matches += 1;
  }
  return {matches, samples};
};

const transparentCorners = (image: RawImage, threshold: number): CollageSheetCellManifest['transparentCorners'] => ({
  topLeft: alphaAt(image, 0, 0) <= threshold,
  topRight: alphaAt(image, image.width - 1, 0) <= threshold,
  bottomRight: alphaAt(image, image.width - 1, image.height - 1) <= threshold,
  bottomLeft: alphaAt(image, 0, image.height - 1) <= threshold,
});

const writePng = async (image: RawImage, destination: string): Promise<void> => {
  await sharp(image.data, {raw: {width: image.width, height: image.height, channels: 4}})
    .png({compressionLevel: 9, adaptiveFiltering: true})
    .toFile(destination);
};

const outputName = (prefix: string, row: number, column: number): string => (
  `${prefix}-r${String(row + 1).padStart(2, '0')}-c${String(column + 1).padStart(2, '0')}.png`
);

export const prepareCollageSheet = async (
  requestedOptions: PrepareCollageSheetOptions,
): Promise<CollageSheetManifest> => {
  const options = normalizeOptions(requestedOptions);
  const inputStat = await fs.stat(options.inputPath).catch(() => null);
  if (inputStat?.isFile() !== true) throw new Error(`COLLAGE_SHEET_NOT_FOUND:${options.inputPath}`);

  const metadata = await sharp(options.inputPath).metadata();
  const decoded = await sharp(options.inputPath)
    .ensureAlpha()
    .raw()
    .toBuffer({resolveWithObject: true});
  if (decoded.info.channels !== 4) throw new Error(`COLLAGE_SHEET_RGBA_DECODE_FAILED:${decoded.info.channels}`);
  if (decoded.info.width < options.columns || decoded.info.height < options.rows) {
    throw new Error(`COLLAGE_SHEET_GRID_TOO_DENSE:${decoded.info.width}x${decoded.info.height}:${options.columns}x${options.rows}`);
  }

  await fs.mkdir(options.outputDirectory, {recursive: true});
  await fs.mkdir(path.dirname(options.manifestPath), {recursive: true});
  const outputPaths = Array.from({length: options.rows * options.columns}, (_, index) => {
    const row = Math.floor(index / options.columns);
    const column = index % options.columns;
    return path.join(options.outputDirectory, outputName(options.prefix, row, column));
  });
  await ensureSafeDestinations(
    options.inputPath,
    [...outputPaths, options.manifestPath],
    options.overwrite,
  );

  const keyedSource: RawImage = {
    data: applyChromaAlpha(decoded.data, options.chroma, options.chromaTolerance, options.chromaSoftness),
    width: decoded.info.width,
    height: decoded.info.height,
  };
  const issues: CollageSheetQaIssue[] = [];
  const cellIssueCodes = Array.from({length: outputPaths.length}, () => new Set<string>());
  const addIssue = (issue: CollageSheetQaIssue): void => {
    issues.push(issue);
    for (const cell of issue.cells) cellIssueCodes[cell]?.add(issue.code);
  };

  const cells: PreparedCell[] = [];
  for (let row = 0; row < options.rows; row += 1) {
    const top = Math.floor(row * keyedSource.height / options.rows);
    const bottom = Math.floor((row + 1) * keyedSource.height / options.rows);
    for (let column = 0; column < options.columns; column += 1) {
      const left = Math.floor(column * keyedSource.width / options.columns);
      const right = Math.floor((column + 1) * keyedSource.width / options.columns);
      const index = row * options.columns + column;
      const cellRaw = extractRaw(keyedSource, left, top, right - left, bottom - top);
      const sourceCoverage = alphaCoverage(cellRaw);
      const trimBox = findAlphaBounds(cellRaw, options.alphaThreshold);
      const trimmed = trimBox === null
        ? null
        : extractRaw(cellRaw, trimBox.left, trimBox.top, trimBox.width, trimBox.height);
      const outputRaw = addTransparentPadding(trimmed, options.padding);
      const corners = transparentCorners(outputRaw, options.alphaThreshold);
      const profiles = edgeProfiles(cellRaw, options.edgeBand, options.alphaThreshold);
      const outputPath = outputPaths[index];
      if (outputPath === undefined) throw new Error(`OUTPUT_PATH_MISSING:${index}`);
      await writePng(outputRaw, outputPath);

      if (trimBox === null || sourceCoverage < options.minAlphaCoverage) {
        addIssue({
          severity: 'error',
          code: 'empty-cell',
          message: `Cell ${index} has no meaningful foreground alpha.`,
          cells: [index],
        });
      }
      if (Object.values(corners).some((transparent) => !transparent)) {
        addIssue({
          severity: 'error',
          code: 'opaque-output-corner',
          message: `Cell ${index} does not have four transparent output corners; add padding or repair the matte.`,
          cells: [index],
        });
      }

      const edgeOccupancy = {
        top: occupancy(profiles.top),
        right: occupancy(profiles.right),
        bottom: occupancy(profiles.bottom),
        left: occupancy(profiles.left),
      };
      for (const edge of ['top', 'right', 'bottom', 'left'] as const) {
        if (edgeOccupancy[edge] === 0) continue;
        const internal = (edge === 'top' && row > 0)
          || (edge === 'bottom' && row < options.rows - 1)
          || (edge === 'left' && column > 0)
          || (edge === 'right' && column < options.columns - 1);
        addIssue({
          severity: 'warning',
          code: internal ? 'foreground-touches-grid-boundary' : 'foreground-touches-sheet-edge',
          message: `Cell ${index} foreground touches its ${edge} ${internal ? 'grid boundary' : 'sheet edge'}.`,
          cells: [index],
        });
      }

      cells.push({
        raw: cellRaw,
        profiles,
        manifest: {
          index,
          row,
          column,
          sourceRect: {left, top, width: right - left, height: bottom - top},
          trimBox,
          output: {
            path: path.relative(options.outputDirectory, outputPath).replaceAll(path.sep, '/'),
            width: outputRaw.width,
            height: outputRaw.height,
          },
          alphaCoverage: {source: sourceCoverage, output: alphaCoverage(outputRaw)},
          transparentCorners: corners,
          edgeOccupancy,
          status: trimBox === null ? 'empty' : 'ok',
          issues: [],
        },
      });
    }
  }

  const boundaries: CollageSheetBoundaryManifest[] = [];
  const addBoundary = (
    orientation: 'vertical' | 'horizontal',
    firstCell: PreparedCell,
    secondCell: PreparedCell,
    firstProfile: boolean[],
    secondProfile: boolean[],
  ): void => {
    const overlap = profileOverlap(firstProfile, secondProfile);
    const threshold = Math.max(1, Math.ceil(overlap.samples * 0.005));
    const suspected = overlap.matches >= threshold;
    boundaries.push({
      orientation,
      firstCell: firstCell.manifest.index,
      secondCell: secondCell.manifest.index,
      matchingForegroundSamples: overlap.matches,
      sampleCount: overlap.samples,
      overlapFraction: overlap.samples === 0 ? 0 : round(overlap.matches / overlap.samples),
      suspectedCrossCellFragment: suspected,
    });
    if (suspected) {
      addIssue({
        severity: 'error',
        code: 'cross-cell-fragment',
        message: `Matching foreground crosses the ${orientation} boundary between cells ${firstCell.manifest.index} and ${secondCell.manifest.index}.`,
        cells: [firstCell.manifest.index, secondCell.manifest.index],
        boundary: {
          orientation,
          firstCell: firstCell.manifest.index,
          secondCell: secondCell.manifest.index,
        },
      });
    }
  };

  for (let row = 0; row < options.rows; row += 1) {
    for (let column = 0; column < options.columns - 1; column += 1) {
      const first = cells[row * options.columns + column];
      const second = cells[row * options.columns + column + 1];
      if (first !== undefined && second !== undefined) {
        addBoundary('vertical', first, second, first.profiles.right, second.profiles.left);
      }
    }
  }
  for (let row = 0; row < options.rows - 1; row += 1) {
    for (let column = 0; column < options.columns; column += 1) {
      const first = cells[row * options.columns + column];
      const second = cells[(row + 1) * options.columns + column];
      if (first !== undefined && second !== undefined) {
        addBoundary('horizontal', first, second, first.profiles.bottom, second.profiles.top);
      }
    }
  }

  for (const cell of cells) {
    const codes = [...(cellIssueCodes[cell.manifest.index] ?? [])].sort();
    cell.manifest.issues = codes;
    if (codes.includes('empty-cell')) cell.manifest.status = 'empty';
    else if (codes.length > 0) cell.manifest.status = 'needs-review';
  }

  const errorCount = issues.filter((issue) => issue.severity === 'error').length;
  const warningCount = issues.length - errorCount;
  const manifest: CollageSheetManifest = {
    schemaVersion: 1,
    source: {
      path: options.inputPath,
      width: decoded.info.width,
      height: decoded.info.height,
      channels: metadata.channels ?? decoded.info.channels,
      hasAlpha: metadata.hasAlpha ?? false,
      rows: options.rows,
      columns: options.columns,
    },
    options: {
      chroma: options.chroma,
      chromaTolerance: options.chromaTolerance,
      chromaSoftness: options.chromaSoftness,
      padding: options.padding,
      alphaThreshold: options.alphaThreshold,
      minAlphaCoverage: options.minAlphaCoverage,
      edgeBand: options.edgeBand,
      prefix: options.prefix,
    },
    cells: cells.map((cell) => cell.manifest),
    boundaries,
    qa: {
      passed: errorCount === 0,
      errorCount,
      warningCount,
      issues,
    },
  };
  await fs.writeFile(
    options.manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    {encoding: 'utf8', flag: options.overwrite ? 'w' : 'wx'},
  );
  return manifest;
};

export const prepareCollageSheetUsage = [
  'Usage:',
  '  npx tsx scripts/prepare-collage-sheet.ts --input <sheet.png> --output-dir <directory> [options]',
  '',
  'Grid options:',
  '  --rows <n>                 Grid rows (default: 2)',
  '  --columns <n>              Grid columns (default: 3)',
  '',
  'Matte options:',
  '  --chroma <color|none>      Optional key color: #00ff00, green, or 0,255,0',
  '  --chroma-tolerance <n>     Fully transparent RGB distance (default: 48)',
  '  --chroma-softness <n>      Feather distance after tolerance (default: 32)',
  '  --alpha-threshold <0-254>  Transparency/trim threshold (default: 8)',
  '',
  'Output and QA:',
  '  --padding <px>             Transparent margin after trim (default: 16)',
  '  --min-alpha-coverage <0-1> Empty-cell threshold (default: 0.002)',
  '  --edge-band <px>           Grid-edge inspection width (default: 2)',
  '  --prefix <name>            PNG prefix (default: piece)',
  '  --manifest <path>          Manifest path (default: output-dir/manifest.json)',
  '  --force                    Replace prior outputs; never replaces the input',
  '  --allow-qa-issues          Exit successfully even if manifest QA fails',
  '  --help                     Show this help',
].join('\n');

export type ParsedPrepareCollageSheetCli = {
  help: boolean;
  allowQaIssues: boolean;
  options: PrepareCollageSheetOptions | null;
};

export const parsePrepareCollageSheetArgs = (argv: string[]): ParsedPrepareCollageSheetCli => {
  let inputPath: string | undefined;
  let outputDirectory: string | undefined;
  let rows: number | undefined;
  let columns: number | undefined;
  let chroma: string | null | undefined;
  let chromaTolerance: number | undefined;
  let chromaSoftness: number | undefined;
  let padding: number | undefined;
  let alphaThreshold: number | undefined;
  let minAlphaCoverage: number | undefined;
  let edgeBand: number | undefined;
  let prefix: string | undefined;
  let manifestPath: string | undefined;
  let overwrite = false;
  let allowQaIssues = false;
  let help = false;

  const valueAfter = (index: number, flag: string): string => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`CLI_VALUE_REQUIRED:${flag}`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    switch (flag) {
      case '--input': inputPath = valueAfter(index, flag); index += 1; break;
      case '--output-dir': outputDirectory = valueAfter(index, flag); index += 1; break;
      case '--rows': rows = Number(valueAfter(index, flag)); index += 1; break;
      case '--columns': columns = Number(valueAfter(index, flag)); index += 1; break;
      case '--chroma': {
        const value = valueAfter(index, flag);
        chroma = value.toLowerCase() === 'none' ? null : value;
        index += 1;
        break;
      }
      case '--chroma-tolerance': chromaTolerance = Number(valueAfter(index, flag)); index += 1; break;
      case '--chroma-softness': chromaSoftness = Number(valueAfter(index, flag)); index += 1; break;
      case '--padding': padding = Number(valueAfter(index, flag)); index += 1; break;
      case '--alpha-threshold': alphaThreshold = Number(valueAfter(index, flag)); index += 1; break;
      case '--min-alpha-coverage': minAlphaCoverage = Number(valueAfter(index, flag)); index += 1; break;
      case '--edge-band': edgeBand = Number(valueAfter(index, flag)); index += 1; break;
      case '--prefix': prefix = valueAfter(index, flag); index += 1; break;
      case '--manifest': manifestPath = valueAfter(index, flag); index += 1; break;
      case '--force': overwrite = true; break;
      case '--allow-qa-issues': allowQaIssues = true; break;
      case '--help': help = true; break;
      default: throw new Error(`CLI_ARGUMENT_UNKNOWN:${flag ?? ''}`);
    }
  }
  if (help) return {help: true, allowQaIssues, options: null};
  if (inputPath === undefined || outputDirectory === undefined) {
    throw new Error(`CLI_REQUIRED_ARGUMENT_MISSING\n${prepareCollageSheetUsage}`);
  }
  const options: PrepareCollageSheetOptions = {inputPath, outputDirectory, overwrite};
  if (rows !== undefined) options.rows = rows;
  if (columns !== undefined) options.columns = columns;
  if (chroma !== undefined) options.chroma = chroma;
  if (chromaTolerance !== undefined) options.chromaTolerance = chromaTolerance;
  if (chromaSoftness !== undefined) options.chromaSoftness = chromaSoftness;
  if (padding !== undefined) options.padding = padding;
  if (alphaThreshold !== undefined) options.alphaThreshold = alphaThreshold;
  if (minAlphaCoverage !== undefined) options.minAlphaCoverage = minAlphaCoverage;
  if (edgeBand !== undefined) options.edgeBand = edgeBand;
  if (prefix !== undefined) options.prefix = prefix;
  if (manifestPath !== undefined) options.manifestPath = manifestPath;
  return {help: false, allowQaIssues, options};
};

const runCli = async (): Promise<void> => {
  const parsed = parsePrepareCollageSheetArgs(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(`${prepareCollageSheetUsage}\n`);
    return;
  }
  if (parsed.options === null) throw new Error('CLI_OPTIONS_MISSING');
  const manifest = await prepareCollageSheet(parsed.options);
  const manifestPath = path.resolve(
    parsed.options.manifestPath ?? path.join(parsed.options.outputDirectory, 'manifest.json'),
  );
  process.stdout.write(`${JSON.stringify({
    manifestPath,
    cells: manifest.cells.length,
    passed: manifest.qa.passed,
    errors: manifest.qa.errorCount,
    warnings: manifest.qa.warningCount,
  }, null, 2)}\n`);
  if (!manifest.qa.passed && !parsed.allowQaIssues) {
    throw new Error(`COLLAGE_SHEET_QA_FAILED:${manifestPath}`);
  }
};

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(path.resolve(entryPath)).href) {
  await runCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}

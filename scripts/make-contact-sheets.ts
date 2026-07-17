import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  loadProductionPlan,
  type ProductionPlan,
} from '@gen-video-tool/video-generation';
import sharp from 'sharp';
import {findRemotionTool} from './local-tools';

type QaReason = 'uniform' | 'milestone' | 'contact-adjacent';

type QaSample = {
  frame: number;
  reasons: QaReason[];
  shotIds: string[];
  milestoneIds: string[];
};

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const ffmpeg = findRemotionTool(repositoryRoot, 'ffmpeg');
const uniformSampleCount = 12;
const contactRadiusFrames = 2;

const usage = [
  'Usage:',
  '  npm run qa:frames -- <project-root> <rendered-video> [output-directory]',
  '',
  'Example:',
  '  npm run qa:frames -- examples/morning-light-v3 output/morning-light/final.mp4 output/morning-light/qa',
].join('\n');

const resolveCliPath = (value: string): string => path.resolve(process.cwd(), value);

const runFfmpeg = (args: string[]): Promise<void> => new Promise((resolve, reject) => {
  const child = spawn(ffmpeg, args, {
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let error = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    error = `${error}${chunk}`.slice(-8_000);
  });
  child.once('error', reject);
  child.once('exit', (code) => {
    if (code === 0) resolve();
    else reject(new Error(`FFMPEG_FRAME_EXTRACTION_FAILED:${code ?? 'unknown'}\n${error}`));
  });
});

const addReason = (sample: QaSample, reason: QaReason): void => {
  if (!sample.reasons.includes(reason)) sample.reasons.push(reason);
};

const addUnique = (values: string[], value: string): void => {
  if (!values.includes(value)) values.push(value);
};

/**
 * Build whole-project review targets in delivery frames. Uniform coverage always
 * contributes twelve targets; generated-performance shots additionally expose
 * every world milestone and two delivery frames on either side of contact and
 * release milestones.
 */
const buildQaSamples = (plan: ProductionPlan): QaSample[] => {
  const totalFrames = plan.delivery.timeline.durationFrames;
  const samples = new Map<number, QaSample>();
  const add = (
    frame: number,
    reason: QaReason,
    shotId?: string,
    milestoneId?: string,
  ): void => {
    if (frame < 0 || frame >= totalFrames) return;
    const sample = samples.get(frame) ?? {
      frame,
      reasons: [],
      shotIds: [],
      milestoneIds: [],
    };
    addReason(sample, reason);
    if (shotId !== undefined) addUnique(sample.shotIds, shotId);
    if (milestoneId !== undefined) addUnique(sample.milestoneIds, milestoneId);
    samples.set(frame, sample);
  };

  for (let index = 0; index < uniformSampleCount; index += 1) {
    add(
      Math.min(
        totalFrames - 1,
        Math.floor(totalFrames * ((index + 0.5) / uniformSampleCount)),
      ),
      'uniform',
    );
  }

  for (const shot of plan.shots) {
    if (shot.kind !== 'generated-performance') continue;
    const shotStart = shot.deliveryTimeline.startFrame;
    const shotEnd = shotStart + shot.deliveryTimeline.durationFrames - 1;
    for (const milestone of shot.hybridMotion.world.milestones) {
      const absoluteFrame = shotStart + milestone.frame;
      add(absoluteFrame, 'milestone', shot.shotId, milestone.id);
      if (milestone.kind !== 'contact' && milestone.kind !== 'release') continue;
      for (let offset = -contactRadiusFrames; offset <= contactRadiusFrames; offset += 1) {
        if (offset === 0) continue;
        const adjacentFrame = absoluteFrame + offset;
        if (adjacentFrame < shotStart || adjacentFrame > shotEnd) continue;
        add(adjacentFrame, 'contact-adjacent', shot.shotId, milestone.id);
      }
    }
  }

  return [...samples.values()].sort((left, right) => left.frame - right.frame);
};

const extractFrames = async (
  videoPath: string,
  samples: QaSample[],
  fps: number,
  temporaryDirectory: string,
): Promise<string[]> => {
  const extracted: string[] = [];
  for (const [index, sample] of samples.entries()) {
    const destination = path.join(temporaryDirectory, `${String(index).padStart(4, '0')}.png`);
    const seconds = sample.frame / fps;
    await runFfmpeg([
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-ss',
      seconds.toFixed(6),
      '-i',
      videoPath,
      '-frames:v',
      '1',
      destination,
    ]);
    extracted.push(destination);
  }
  return extracted;
};

const escapeXml = (value: string): string => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&apos;');

const makeLabelSvg = (sample: QaSample, width: number, height: number): Buffer => {
  const reasonLabel = sample.reasons.join(' + ');
  const contextLabel = [sample.shotIds.join(','), sample.milestoneIds.join(',')]
    .filter((value) => value.length > 0)
    .join(' / ');
  return Buffer.from(`
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="${height - 64}" width="${width}" height="64" fill="rgba(0,0,0,0.78)"/>
      <text x="12" y="${height - 38}" fill="#ffffff" font-size="18" font-family="Arial, sans-serif" font-weight="700">
        ${escapeXml(`F${sample.frame} · ${reasonLabel}`)}
      </text>
      <text x="12" y="${height - 14}" fill="#d4d4d8" font-size="14" font-family="Arial, sans-serif">
        ${escapeXml(contextLabel || 'whole-project sample')}
      </text>
    </svg>
  `);
};

const composeContactSheet = async (
  framePaths: string[],
  samples: QaSample[],
  destination: string,
): Promise<void> => {
  const columns = 4;
  const cellWidth = 270;
  const cellHeight = 480;
  const rows = Math.ceil(framePaths.length / columns);
  const composites = await Promise.all(framePaths.map(async (framePath, index) => {
    const sample = samples[index];
    if (sample === undefined) throw new Error(`QA_SAMPLE_MISSING:${index}`);
    const thumbnail = await sharp(framePath)
      .resize(cellWidth, cellHeight, {fit: 'cover', position: 'centre'})
      .composite([{input: makeLabelSvg(sample, cellWidth, cellHeight)}])
      .jpeg({quality: 90})
      .toBuffer();
    return {
      input: thumbnail,
      left: (index % columns) * cellWidth,
      top: Math.floor(index / columns) * cellHeight,
    };
  }));

  await sharp({
    create: {
      width: columns * cellWidth,
      height: rows * cellHeight,
      channels: 3,
      background: '#111315',
    },
  })
    .composite(composites)
    .jpeg({quality: 90})
    .toFile(destination);
};

const main = async (): Promise<void> => {
  const [projectRootArgument, videoArgument, outputArgument] = process.argv.slice(2);
  if (projectRootArgument === undefined || videoArgument === undefined) {
    throw new Error(`QA_ARGUMENTS_REQUIRED\n${usage}`);
  }

  const projectRoot = resolveCliPath(projectRootArgument);
  const videoPath = resolveCliPath(videoArgument);
  const outputDirectory = outputArgument === undefined
    ? path.join(path.dirname(videoPath), 'qa')
    : resolveCliPath(outputArgument);
  const videoStat = await fs.stat(videoPath).catch(() => null);
  if (videoStat?.isFile() !== true) throw new Error(`RENDERED_VIDEO_NOT_FOUND:${videoPath}`);

  const plan = await loadProductionPlan(projectRoot);
  const samples = buildQaSamples(plan);
  if (samples.length === 0) throw new Error('QA_SAMPLE_SET_EMPTY');

  await fs.mkdir(outputDirectory, {recursive: true});
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'gen-video-v3-qa-'));
  try {
    const framePaths = await extractFrames(
      videoPath,
      samples,
      plan.delivery.timeline.fps,
      temporaryDirectory,
    );
    const contactSheetPath = path.join(outputDirectory, 'contact-sheet.jpg');
    await composeContactSheet(framePaths, samples, contactSheetPath);
    await fs.writeFile(
      path.join(outputDirectory, 'qa-samples.json'),
      `${JSON.stringify({
        schemaVersion: plan.schemaVersion,
        projectId: plan.projectId,
        renderedVideoPath: videoPath,
        fps: plan.delivery.timeline.fps,
        samples,
      }, null, 2)}\n`,
      'utf8',
    );
    process.stdout.write(`${JSON.stringify({
      projectId: plan.projectId,
      sampleCount: samples.length,
      contactSheetPath,
    }, null, 2)}\n`);
  } finally {
    await fs.rm(temporaryDirectory, {recursive: true, force: true});
  }
};

await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});

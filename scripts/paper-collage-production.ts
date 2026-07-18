import {spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {
  acquireProductionRunLock,
  assertProductionStateMatchesPlan,
  beginProductionNarration,
  completeProductionNarration,
  createProductionState,
  failProductionNarration,
  loadProductionPlan,
  loadProductionState,
  writeProductionState,
  type ProductionState,
} from '@gen-video-tool/video-generation';

type JsonRecord = Record<string, unknown>;

export type PaperCollageCommandKind = 'synthesize' | 'render';

export type PaperCollageCommand = {
  kind: PaperCollageCommandKind;
  executable: string;
  args: string[];
  cwd: string;
};

export type PaperCollageCommandResult = {
  stdout: string;
  stderr: string;
};

export type PaperCollageProductionResult = {
  status: 'paper-collage-complete';
  creationRoot: string;
  projectRoot: string;
  outputRoot: string;
  videoPath: string;
  subtitlePath: string;
  thumbnailPath: string;
  durationSeconds: number;
  bgm: null;
  subtitlesBurnIn: false;
  visualMode: 'paper-collage';
  voice: boolean;
  hasAudio: boolean;
};

export type PaperCollageProductionDependencies = {
  runCommand?: (command: PaperCollageCommand) => Promise<PaperCollageCommandResult>;
  makeThumbnail?: (videoPath: string, thumbnailPath: string) => Promise<void>;
  prepareMutedNarration?: (projectRoot: string) => Promise<void>;
  removeAudio?: (videoPath: string, mutedVideoPath: string) => Promise<void>;
};

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const tsxCli = path.join(repositoryRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const requiredAssetProjectError = 'PAPER_COLLAGE_ASSET_PROJECT_REQUIRED';

const progress = (value: number, stage: string, detail: string): void => {
  process.stdout.write(`${JSON.stringify({
    event: 'paper-collage-progress',
    progress: value,
    stage,
    detail,
  })}\n`);
};

const usage = [
  'Usage:',
  '  npx tsx scripts/paper-collage-production.ts <creation-root> <output-root>',
  '',
  'The creation root must contain:',
  '  creation.json',
  '  paper-project/production.json',
  '',
  'The paper project is rendered locally with Remotion and optional F5-TTS.',
  'It never falls back to FastWan and never burns subtitles or adds BGM.',
].join('\n');

const isRecord = (value: unknown): value is JsonRecord => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const readJsonRecord = async (filePath: string, missingError: string): Promise<JsonRecord> => {
  let source: string;
  try {
    source = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(missingError);
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    throw new Error(`${missingError}:${path.basename(filePath)}_JSON_INVALID`);
  }
  if (!isRecord(parsed)) throw new Error(`${missingError}:${path.basename(filePath)}_OBJECT_REQUIRED`);
  return parsed;
};

const stringField = (record: JsonRecord, key: string, errorCode: string): string => {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(errorCode);
  return value;
};

const numberField = (record: JsonRecord, key: string, errorCode: string): number => {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(errorCode);
  return value;
};

const booleanField = (record: JsonRecord, key: string, errorCode: string): boolean => {
  const value = record[key];
  if (typeof value !== 'boolean') throw new Error(errorCode);
  return value;
};

const resolveProjectFile = (projectRoot: string, relativePath: string): string => {
  const target = path.resolve(projectRoot, ...relativePath.split('/'));
  const relative = path.relative(projectRoot, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`PAPER_COLLAGE_PROJECT_PATH_OUTSIDE_ROOT:${relativePath}`);
  }
  return target;
};

const commandRunner = (command: PaperCollageCommand): Promise<PaperCollageCommandResult> => (
  new Promise((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
      cwd: command.cwd,
      env: {...process.env, FORCE_COLOR: '0'},
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout = `${stdout}${chunk}`.slice(-128_000);
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-32_000);
      process.stderr.write(chunk);
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve({stdout, stderr});
        return;
      }
      const detail = (stderr || stdout).trim().slice(-2_000);
      reject(new Error(`PAPER_COLLAGE_${command.kind.toUpperCase()}_FAILED:${code ?? signal ?? 'unknown'}${detail ? `:${detail}` : ''}`));
    });
  })
);

const executableName = (name: 'ffmpeg'): string => process.platform === 'win32' ? `${name}.exe` : name;

const findFfmpeg = (): string => {
  const configured = process.env.FFMPEG_PATH;
  if (configured && path.isAbsolute(configured) && fsSync.existsSync(configured)) return configured;
  const remotionRoot = path.join(repositoryRoot, 'node_modules', '@remotion');
  if (fsSync.existsSync(remotionRoot)) {
    for (const directory of fsSync.readdirSync(remotionRoot)) {
      if (!directory.startsWith('compositor-')) continue;
      const candidate = path.join(remotionRoot, directory, executableName('ffmpeg'));
      if (fsSync.existsSync(candidate)) return candidate;
    }
  }
  return executableName('ffmpeg');
};

const runBinary = (executable: string, args: string[]): Promise<void> => (
  new Promise((resolve, reject) => {
    const child = spawn(executable, args, {shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe']});
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-4_000); });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`PAPER_COLLAGE_FFMPEG_FAILED:${code ?? signal ?? 'unknown'}:${stderr}`));
    });
  })
);

const removeAudio = async (videoPath: string, mutedVideoPath: string): Promise<void> => {
  await runBinary(findFfmpeg(), [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    videoPath,
    '-map',
    '0:v:0',
    '-c:v',
    'copy',
    '-an',
    '-movflags',
    '+faststart',
    mutedVideoPath,
  ]);
};

const makeThumbnail = async (videoPath: string, thumbnailPath: string): Promise<void> => {
  await fs.mkdir(path.dirname(thumbnailPath), {recursive: true});
  await runBinary(findFfmpeg(), [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-ss',
    '1',
    '-i',
    videoPath,
    '-frames:v',
    '1',
    '-q:v',
    '2',
    thumbnailPath,
  ]);
};

const fileExists = async (candidate: string): Promise<boolean> => {
  try {
    return (await fs.stat(candidate)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
};

const copyFileAtomic = async (source: string, target: string): Promise<void> => {
  await fs.mkdir(path.dirname(target), {recursive: true});
  const staged = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  const backup = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.bak`);
  const hadTarget = await fileExists(target);
  await fs.copyFile(source, staged);
  try {
    if (hadTarget) await fs.rename(target, backup);
    await fs.rename(staged, target);
    if (hadTarget) await fs.rm(backup, {force: true});
  } catch (error) {
    if (!await fileExists(target) && await fileExists(backup)) await fs.rename(backup, target);
    throw error;
  } finally {
    await fs.rm(staged, {force: true});
    await fs.rm(backup, {force: true});
  }
};

const sha256File = async (filePath: string): Promise<string> =>
  await new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fsSync.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });

const createPcmSilenceWav = async (
  targetPath: string,
  durationSeconds: number,
  sampleRate = 48_000,
): Promise<void> => {
  const channels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const sampleCount = Math.max(1, Math.round(durationSeconds * sampleRate));
  const dataBytes = sampleCount * channels * bytesPerSample;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0, 4, 'ascii');
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write('WAVE', 8, 4, 'ascii');
  wav.write('fmt ', 12, 4, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  wav.writeUInt16LE(channels * bytesPerSample, 32);
  wav.writeUInt16LE(bitsPerSample, 34);
  wav.write('data', 36, 4, 'ascii');
  wav.writeUInt32LE(dataBytes, 40);
  await fs.mkdir(path.dirname(targetPath), {recursive: true});
  const staged = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(staged, wav, {flag: 'wx'});
    await copyFileAtomic(staged, targetPath);
  } finally {
    await fs.rm(staged, {force: true});
  }
};

/**
 * The canonical renderer currently validates one narration WAV before muxing.
 * A muted creation therefore receives a local silence compatibility source,
 * never an F5 invocation. The wrapper removes that track from the published
 * MP4 after render; the authored root SRT remains an external sidecar.
 */
export const prepareMutedPaperProject = async (projectRoot: string): Promise<void> => {
  const plan = await loadProductionPlan(projectRoot);
  const lock = await acquireProductionRunLock(projectRoot, {kind: 'narration'});
  let state: ProductionState;
  try {
    try {
      state = await loadProductionState(projectRoot, {recoverInterrupted: true});
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      state = createProductionState(plan);
      await writeProductionState(projectRoot, state);
    }
    assertProductionStateMatchesPlan(state, plan);
    state = beginProductionNarration(state);
    await writeProductionState(projectRoot, state);
    try {
      const durationSeconds = plan.delivery.timeline.durationFrames / plan.delivery.timeline.fps;
      const narrationPath = resolveProjectFile(projectRoot, plan.delivery.audio.path);
      await createPcmSilenceWav(narrationPath, durationSeconds, plan.delivery.audio.muxSampleRate);

      const authoredSubtitlePath = path.join(projectRoot, 'subtitles.srt');
      if (!await fileExists(authoredSubtitlePath)) {
        throw new Error('PAPER_COLLAGE_SOURCE_SRT_MISSING');
      }
      await copyFileAtomic(
        authoredSubtitlePath,
        resolveProjectFile(projectRoot, plan.delivery.subtitles.path),
      );

      // ProductionState v3 requires positive measured segment spans even for
      // compatibility silence. Keep them at one millisecond each so the state
      // records no meaningful synthesized speech while preserving plan IDs.
      const compatibilitySegmentSeconds = Math.min(
        0.001,
        durationSeconds / (plan.narration.segments.length * 2),
      );
      const compatibilitySpeechSeconds = plan.narration.segments.length * compatibilitySegmentSeconds;
      const segments = plan.narration.segments.map((segment, index) => ({
        segmentId: segment.segmentId,
        outputPath: segment.outputPath,
        startSeconds: index * compatibilitySegmentSeconds,
        endSeconds: (index + 1) * compatibilitySegmentSeconds,
        durationSeconds: compatibilitySegmentSeconds,
      }));
      state = completeProductionNarration(state, {
        mergedAudioPath: plan.narration.mergedAudioPath,
        sha256: await sha256File(narrationPath),
        durationSeconds,
        speechDurationSeconds: compatibilitySpeechSeconds,
        tailPaddingSeconds: durationSeconds - compatibilitySpeechSeconds,
        segments,
      });
      await writeProductionState(projectRoot, state);
    } catch (error) {
      state = failProductionNarration(state, error instanceof Error ? error.message : String(error));
      await writeProductionState(projectRoot, state);
      throw error;
    }
  } finally {
    await lock.release();
  }
};

const readDeliveryContract = (production: JsonRecord) => {
  const delivery = production.delivery;
  if (!isRecord(delivery)) throw new Error('PAPER_COLLAGE_DELIVERY_CONTRACT_INVALID:delivery');
  const video = delivery.video;
  const subtitles = delivery.subtitles;
  const timeline = delivery.timeline;
  if (!isRecord(video) || !isRecord(subtitles) || !isRecord(timeline)) {
    throw new Error('PAPER_COLLAGE_DELIVERY_CONTRACT_INVALID:paths');
  }
  const videoRelativePath = stringField(video, 'path', 'PAPER_COLLAGE_DELIVERY_CONTRACT_INVALID:video.path');
  const subtitleRelativePath = stringField(subtitles, 'path', 'PAPER_COLLAGE_DELIVERY_CONTRACT_INVALID:subtitles.path');
  const burnIn = subtitles.burnIn;
  if (burnIn !== false || delivery.bgm !== null) {
    throw new Error('PAPER_COLLAGE_DELIVERY_CONTRACT_INVALID:NO_BGM_OR_BURN_IN_REQUIRED');
  }
  const fps = numberField(timeline, 'fps', 'PAPER_COLLAGE_DELIVERY_CONTRACT_INVALID:timeline.fps');
  const durationFrames = numberField(timeline, 'durationFrames', 'PAPER_COLLAGE_DELIVERY_CONTRACT_INVALID:timeline.durationFrames');
  if (fps <= 0 || durationFrames <= 0) throw new Error('PAPER_COLLAGE_DELIVERY_CONTRACT_INVALID:timeline');
  return {
    videoRelativePath,
    subtitleRelativePath,
    durationSeconds: durationFrames / fps,
  };
};

const assertPaperOnlyShots = (production: JsonRecord): void => {
  const shots = production.shots;
  if (!Array.isArray(shots) || shots.length === 0) {
    throw new Error('PAPER_COLLAGE_SHOTS_REQUIRED');
  }
  for (const shot of shots) {
    if (!isRecord(shot) || shot.kind !== 'layered-collage') {
      throw new Error('PAPER_COLLAGE_GENERATED_SHOTS_FORBIDDEN');
    }
  }
};

const buildSynthesizeCommand = (projectRoot: string): PaperCollageCommand => ({
  kind: 'synthesize',
  executable: process.execPath,
  cwd: repositoryRoot,
  args: [tsxCli, path.join(repositoryRoot, 'scripts', 'synthesize-production.ts'), projectRoot],
});

const buildRenderCommand = (projectRoot: string, renderRoot: string): PaperCollageCommand => ({
  kind: 'render',
  executable: process.execPath,
  cwd: repositoryRoot,
  args: [tsxCli, path.join(repositoryRoot, 'scripts', 'render-production.ts'), projectRoot, renderRoot],
});

export const runPaperCollageProduction = async (
  creationRootValue: string,
  outputRootValue: string,
  dependencies: PaperCollageProductionDependencies = {},
): Promise<PaperCollageProductionResult> => {
  const creationRoot = path.resolve(creationRootValue);
  const outputRoot = path.resolve(outputRootValue);
  const creationPath = path.join(creationRoot, 'creation.json');
  const projectRoot = path.join(creationRoot, 'paper-project');
  const productionPath = path.join(projectRoot, 'production.json');
  progress(0.02, 'validate-paper-assets', '正在检查纸片资产、时长和交付约束');
  const creation = await readJsonRecord(creationPath, requiredAssetProjectError);
  // Reading the creation manifest is intentional: a paper render is always
  // attached to a creator record, never an unowned project folder.
  stringField(creation, 'id', `${requiredAssetProjectError}:creation.id`);
  const requestedDurationSeconds = numberField(
    creation,
    'durationSeconds',
    `${requiredAssetProjectError}:creation.durationSeconds`,
  );
  const voice = booleanField(creation, 'voice', `${requiredAssetProjectError}:creation.voice`);
  const production = await readJsonRecord(productionPath, requiredAssetProjectError);
  assertPaperOnlyShots(production);
  const delivery = readDeliveryContract(production);
  if (Math.abs(delivery.durationSeconds - requestedDurationSeconds) > 0.05) {
    throw new Error(
      `PAPER_COLLAGE_DURATION_MISMATCH:${delivery.durationSeconds.toFixed(6)}!=${requestedDurationSeconds}`,
    );
  }
  resolveProjectFile(projectRoot, delivery.videoRelativePath);
  resolveProjectFile(projectRoot, delivery.subtitleRelativePath);
  if (path.resolve(outputRoot) === path.resolve(projectRoot)) {
    throw new Error('PAPER_COLLAGE_OUTPUT_ROOT_UNSAFE');
  }

  await fs.mkdir(outputRoot, {recursive: true});
  const renderRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gen-video-paper-render-'));
  const runCommand = dependencies.runCommand ?? commandRunner;
  const createThumbnail = dependencies.makeThumbnail ?? makeThumbnail;
  const prepareMuted = dependencies.prepareMutedNarration ?? prepareMutedPaperProject;
  const stripAudio = dependencies.removeAudio ?? removeAudio;
  try {
    // Deliberately invoke both canonical local stages. There is no FastWan
    // branch here: if the paper project cannot render, this run fails loudly.
    if (voice) {
      progress(0.08, 'synthesize-narration', '正在用 F5-TTS 生成旁白和外挂字幕');
      await runCommand(buildSynthesizeCommand(projectRoot));
    } else {
      progress(0.08, 'prepare-muted-timeline', '已关闭旁白，正在准备无声画面和外挂字幕');
      await prepareMuted(projectRoot);
    }
    progress(0.32, 'render-paper-collage', '正在按图层顺序组装完整纸片角色');
    await runCommand(buildRenderCommand(projectRoot, renderRoot));

    const renderedVideoPath = path.join(renderRoot, path.basename(delivery.videoRelativePath));
    const renderedSubtitlePath = path.join(renderRoot, path.basename(delivery.subtitleRelativePath));
    if (!await fileExists(renderedVideoPath)) {
      throw new Error(`PAPER_COLLAGE_RENDER_OUTPUT_MISSING:${renderedVideoPath}`);
    }
    if (!await fileExists(renderedSubtitlePath)) {
      throw new Error(`PAPER_COLLAGE_RENDER_SRT_MISSING:${renderedSubtitlePath}`);
    }

    const publishVideoPath = voice
      ? renderedVideoPath
      : path.join(renderRoot, 'paper-collage-muted.mp4');
    if (!voice) await stripAudio(renderedVideoPath, publishVideoPath);
    if (!await fileExists(publishVideoPath)) {
      throw new Error(`PAPER_COLLAGE_MUTED_OUTPUT_MISSING:${publishVideoPath}`);
    }

    progress(0.94, 'publish-paper-collage', '正在生成封面并发布本地成片');
    const stagedThumbnailPath = path.join(renderRoot, 'thumbnail.jpg');
    await createThumbnail(publishVideoPath, stagedThumbnailPath);
    if (!await fileExists(stagedThumbnailPath)) {
      throw new Error(`PAPER_COLLAGE_THUMBNAIL_MISSING:${stagedThumbnailPath}`);
    }

    const finalVideoPath = path.join(outputRoot, 'final.mp4');
    const finalSubtitlePath = path.join(outputRoot, 'final.srt');
    const finalThumbnailPath = path.join(outputRoot, 'thumbnail.jpg');
    await copyFileAtomic(publishVideoPath, finalVideoPath);
    await copyFileAtomic(renderedSubtitlePath, finalSubtitlePath);
    await copyFileAtomic(stagedThumbnailPath, finalThumbnailPath);
    progress(1, 'complete', '纸片动画视频已完成');
    return {
      status: 'paper-collage-complete',
      creationRoot,
      projectRoot,
      outputRoot,
      videoPath: path.basename(finalVideoPath),
      subtitlePath: path.basename(finalSubtitlePath),
      thumbnailPath: path.basename(finalThumbnailPath),
      durationSeconds: Number(delivery.durationSeconds.toFixed(6)),
      bgm: null,
      subtitlesBurnIn: false,
      visualMode: 'paper-collage',
      voice,
      hasAudio: voice,
    };
  } finally {
    await fs.rm(renderRoot, {recursive: true, force: true});
  }
};

const main = async (): Promise<void> => {
  const [creationRoot, outputRoot] = process.argv.slice(2);
  if (creationRoot === undefined || outputRoot === undefined) throw new Error(usage);
  const result = await runPaperCollageProduction(creationRoot, outputRoot);
  process.stdout.write(`${JSON.stringify(result)}\n`);
};

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(path.resolve(entryPath)).href) {
  await main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}

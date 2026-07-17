import {createHash, randomUUID} from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  concatenatePcmWavFiles,
  createLocalF5TtsRuntime,
  padPcmWavFileToDuration,
  prepareLocalF5TtsEnvironment,
  probeWav,
} from '../packages/local-tts/src/index.js';
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
} from '../packages/video-generation/src/index.js';

const projectArgument = process.argv[2];
if (!projectArgument) {
  throw new Error('Usage: npm run narrate:production -- <project-directory>');
}

const projectRoot = path.resolve(projectArgument);
const repositoryRoot = path.resolve(import.meta.dirname, '..');
const plan = await loadProductionPlan(projectRoot);
const runLock = await acquireProductionRunLock(projectRoot, {kind: 'narration'});

const resolveProjectPath = (relativePath: string): string => {
  const target = path.resolve(projectRoot, ...relativePath.split('/'));
  const relative = path.relative(projectRoot, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`PRODUCTION_PATH_OUTSIDE_ROOT:${relativePath}`);
  }
  return target;
};

const exists = async (filePath: string): Promise<boolean> => {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
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

const replaceFileAtomic = async (stagedPath: string, targetPath: string): Promise<void> => {
  await fs.mkdir(path.dirname(targetPath), {recursive: true});
  const backupPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${randomUUID()}.bak`);
  const hadTarget = await exists(targetPath);
  try {
    if (hadTarget) await fs.rename(targetPath, backupPath);
    await fs.rename(stagedPath, targetPath);
    if (hadTarget) await fs.rm(backupPath, {force: true});
  } catch (error) {
    if (!(await exists(targetPath)) && await exists(backupPath)) await fs.rename(backupPath, targetPath);
    throw error;
  } finally {
    await fs.rm(stagedPath, {force: true});
    await fs.rm(backupPath, {force: true});
  }
};

const srtTimestamp = (seconds: number): string => {
  const milliseconds = Math.max(0, Math.round(seconds * 1_000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const wholeSeconds = Math.floor((milliseconds % 60_000) / 1_000);
  const millis = milliseconds % 1_000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
};

try {
let state: ProductionState;
try {
  state = await loadProductionState(projectRoot, {recoverInterrupted: true});
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  state = createProductionState(plan);
  await writeProductionState(projectRoot, state);
}
assertProductionStateMatchesPlan(state, plan);

const unfinishedShot = state.shots.find((shot) =>
  shot.shotKind === 'generated-performance' && shot.status !== 'selected');
if (unfinishedShot) {
  throw new Error(`NARRATION_REQUIRES_SELECTED_VIDEO:${unfinishedShot.shotId}`);
}

state = beginProductionNarration(state);
await writeProductionState(projectRoot, state);

try {
  const ttsEnvironment = await prepareLocalF5TtsEnvironment({
    cacheRoot: path.join(projectRoot, 'generated', 'cache', 'f5-tts'),
    ffmpegDirectory: path.join(
      repositoryRoot,
      'node_modules',
      '@remotion',
      'compositor-win32-x64-msvc',
    ),
    offline: plan.networkPolicy === 'offline-only',
  });
  const runtime = await createLocalF5TtsRuntime({
    compatibility: {mode: 'compat-wrapper'},
    speed: plan.narration.speed,
    device: process.env.F5_TTS_DEVICE ?? 'cuda',
    environment: ttsEnvironment,
    ...(process.env.F5_TTS_MODEL === undefined ? {} : {model: process.env.F5_TTS_MODEL}),
  });
  const referenceAudioPath = resolveProjectPath(plan.narration.referenceAudioPath);
  const segmentPaths: string[] = [];
  const measuredSegments: Array<{
    segmentId: string;
    outputPath: string;
    startSeconds: number;
    endSeconds: number;
    durationSeconds: number;
  }> = [];
  let cursor = 0;
  for (const segment of plan.narration.segments) {
    const outputPath = resolveProjectPath(segment.outputPath);
    const result = await runtime.synthesize({
      referenceAudioPath,
      referenceText: plan.narration.referenceText,
      text: segment.text,
      outputPath,
      overwrite: true,
    });
    const durationSeconds = Number(result.wav.durationSeconds.toFixed(6));
    const startSeconds = Number(cursor.toFixed(6));
    const endSeconds = Number((startSeconds + durationSeconds).toFixed(6));
    measuredSegments.push({
      segmentId: segment.segmentId,
      outputPath: segment.outputPath,
      startSeconds,
      endSeconds,
      durationSeconds,
    });
    segmentPaths.push(outputPath);
    cursor = endSeconds;
  }

  const mergedAudioPath = resolveProjectPath(plan.narration.mergedAudioPath);
  await fs.mkdir(path.dirname(mergedAudioPath), {recursive: true});
  const speechStage = path.join(path.dirname(mergedAudioPath), `.speech.${randomUUID()}.wav`);
  const paddedStage = path.join(path.dirname(mergedAudioPath), `.padded.${randomUUID()}.wav`);
  const joined = await concatenatePcmWavFiles(segmentPaths, speechStage);
  const deliveryDuration = plan.delivery.timeline.durationFrames / plan.delivery.timeline.fps;
  if (joined.durationSeconds > deliveryDuration + 0.02) {
    throw new Error(
      `LOCAL_TTS_DURATION_EXCEEDS_TIMELINE:${joined.durationSeconds.toFixed(3)}>${deliveryDuration.toFixed(3)}`,
    );
  }
  const padded = await padPcmWavFileToDuration(speechStage, paddedStage, deliveryDuration);
  await fs.rm(speechStage, {force: true});
  await replaceFileAtomic(paddedStage, mergedAudioPath);
  const mergedProbe = await probeWav(mergedAudioPath);

  const subtitlePath = resolveProjectPath(plan.delivery.subtitles.path);
  const subtitleText = measuredSegments.map((segment, index) => {
    const source = plan.narration.segments[index];
    if (!source || source.segmentId !== segment.segmentId) {
      throw new Error(`LOCAL_TTS_SEGMENT_PLAN_MISMATCH:${segment.segmentId}`);
    }
    return `${index + 1}\n${srtTimestamp(segment.startSeconds)} --> ${srtTimestamp(segment.endSeconds)}\n${source.text}`;
  }).join('\n\n') + '\n';
  await fs.mkdir(path.dirname(subtitlePath), {recursive: true});
  const subtitleStage = path.join(path.dirname(subtitlePath), `.${path.basename(subtitlePath)}.${randomUUID()}.tmp`);
  await fs.writeFile(subtitleStage, subtitleText, {encoding: 'utf8', flag: 'wx'});
  await replaceFileAtomic(subtitleStage, subtitlePath);

  state = completeProductionNarration(state, {
    mergedAudioPath: plan.narration.mergedAudioPath,
    sha256: await sha256File(mergedAudioPath),
    durationSeconds: Number(mergedProbe.durationSeconds.toFixed(6)),
    speechDurationSeconds: Number(measuredSegments.at(-1)!.endSeconds.toFixed(6)),
    tailPaddingSeconds: Number(padded.tailPaddingSeconds.toFixed(6)),
    segments: measuredSegments,
  });
  await writeProductionState(projectRoot, state);
  process.stdout.write(`${JSON.stringify({
    status: 'complete',
    projectId: plan.projectId,
    audioPath: mergedAudioPath,
    subtitlePath,
    durationSeconds: mergedProbe.durationSeconds,
    speechDurationSeconds: measuredSegments.at(-1)!.endSeconds,
    tailPaddingSeconds: padded.tailPaddingSeconds,
  }, null, 2)}\n`);
} catch (error) {
  state = failProductionNarration(state, error instanceof Error ? error.message : String(error));
  await writeProductionState(projectRoot, state);
  throw error;
}
} finally {
  await runLock.release();
}

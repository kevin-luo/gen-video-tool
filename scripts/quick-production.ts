import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {promisify} from 'node:util';

import {
  createLocalF5TtsRuntime,
  prepareLocalF5TtsEnvironment,
  probeWav,
  type LocalF5TtsSegmentResult,
} from '@gen-video-tool/local-tts';
import {
  FileVideoGenerationJobStore,
  WanGPProvider,
  type VideoGenerationJob,
  type VideoGenerationPreset,
} from '@gen-video-tool/video-generation';
import {z} from 'zod';

import {createLocalWanGPRuntime} from './local-wangp-runtime.js';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, '..');

const creationSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1).max(128),
  title: z.string().min(1).max(80),
  script: z.string().min(1).max(300),
  platform: z.enum(['douyin', 'xiaohongshu', 'wechat-channels']),
  durationSeconds: z.number().int().min(20).max(60),
  voice: z.boolean(),
  subtitles: z.literal('sidecar-srt'),
  bgm: z.literal(false),
});

type Creation = z.infer<typeof creationSchema>;

const progress = (value: number, stage: string, detail?: string): void => {
  process.stdout.write(`${JSON.stringify({event: 'quick-progress', progress: value, stage, ...(detail ? {detail} : {})})}\n`);
};

export const splitQuickProductionThoughts = (script: string): string[] => {
  const normalized = script.replace(/\s+/gu, ' ').trim();
  const parts = normalized.match(/[^。！？!?；;，,]+[。！？!?；;，,]?/gu)
    ?.map((part) => part.trim())
    .filter(Boolean) ?? [];
  return parts.length > 0 ? parts : [normalized];
};

export const stableQuickProductionSeed = (creationId: string, shotIndex: number): number => {
  const digest = createHash('sha256').update(`${creationId}:${shotIndex}`).digest();
  return digest.readUInt32BE(0);
};

const platformDirection = (platform: Creation['platform']): string => {
  if (platform === 'douyin') {
    return 'Douyin pacing, immediate visual hook, bold readable subject, energetic but physically plausible camera move';
  }
  if (platform === 'xiaohongshu') {
    return 'Xiaohongshu lifestyle cinematography, refined natural light, tactile details, warm authentic handheld movement';
  }
  return 'WeChat Channels documentary tone, natural observation, restrained camera movement, emotionally credible everyday detail';
};

const subjectAgencyConstraint = (script: string): string => {
  if (/(猫|小猫|cat|kitten)/iu.test(script)) {
    return 'The cat is the visible primary agent. For human-like work, portray one coherent anthropomorphic cat with exactly two forelimbs; its own paws grip and move the tool. Do not substitute an offscreen human hand or add a human assistant unless the script explicitly asks for one.';
  }
  if (/(狗|小狗|dog|puppy)/iu.test(script)) {
    return 'The dog is the visible primary agent. For human-like work, portray one coherent anthropomorphic dog with exactly two forelimbs; its own paws operate the object. Do not substitute an offscreen human hand unless the script explicitly asks for one.';
  }
  return 'Keep the named subject as the visible agent of the described action; do not replace its action with an unexplained offscreen hand or an unmentioned helper.';
};

export const buildQuickProductionShotPrompt = (creation: Creation, thought: string, index: number): string => {
  const framing = [
    'establishing wide shot with clear spatial relationships',
    'medium tracking shot following the main action',
    'close-up of the decisive action and real object contact',
    'over-the-shoulder angle revealing cause and consequence',
    'low-angle detail shot with foreground depth',
    'calm payoff shot that resolves the action',
  ][index % 6];
  return [
    'Vertical cinematic B-roll, 9:16 composition, no text in image.',
    `Full story context: ${creation.script}`,
    `This shot: ${thought}`,
    `${platformDirection(creation.platform)}; ${framing}.`,
    subjectAgencyConstraint(creation.script),
    'Real-world continuity: actions have a clear target and direction; hands and tools maintain contact; gravity, balance, momentum, scale, occlusion and object support remain correct; the next movement follows from the previous movement.',
    'Natural subject motion, coherent camera parallax, stable identity and wardrobe, polished commercial lighting, high detail.',
  ].join(' ');
};

const NEGATIVE_PROMPT = [
  'text, subtitles, captions, letters, logos, watermark, interface, border',
  'extra limbs, missing limbs, fused hands, duplicated body, phantom arm, deformed anatomy',
  'backward action, wrong facing direction, impossible contact, floating objects, object penetration, broken gravity',
  'teleporting, identity drift, wardrobe change, flicker, frame tearing, frozen still image, slideshow',
].join(', ');

const isTerminal = (job: VideoGenerationJob): boolean =>
  job.status === 'complete' || job.status === 'failed' || job.status === 'cancelled';

const isReusableVideo = async (filePath: string): Promise<boolean> => {
  try {
    const info = await fs.stat(filePath);
    return info.isFile() && info.size > 100_000;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
};

const waitForJob = async (
  provider: WanGPProvider,
  initial: VideoGenerationJob,
  onProgress: (job: VideoGenerationJob) => void,
): Promise<VideoGenerationJob> => {
  const timeoutMs = Number(process.env.QUICK_PRODUCTION_TIMEOUT_MS ?? 6 * 60 * 60_000);
  const deadline = Date.now() + timeoutMs;
  let current = initial;
  let lastReported = '';
  const report = (job: VideoGenerationJob): void => {
    const key = `${job.status}:${Math.floor(job.progress * 100)}`;
    if (key === lastReported) return;
    lastReported = key;
    onProgress(job);
  };
  report(current);
  while (!isTerminal(current)) {
    if (Date.now() > deadline) {
      await provider.cancel(current.id).catch(() => undefined);
      throw new Error(`QUICK_PRODUCTION_GENERATION_TIMEOUT:${current.id}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    current = await provider.status(current.id);
    report(current);
  }
  return current;
};

const choosePreset = (presets: VideoGenerationPreset[]): VideoGenerationPreset => {
  const balanced = presets.find((preset) => preset.id.includes('balanced-local'))
    ?? presets.find((preset) => preset.width === 480 && preset.height === 832)
    ?? presets.find((preset) => preset.qualityTier === 'preview');
  if (!balanced) throw new Error('QUICK_PRODUCTION_PRESET_UNAVAILABLE');
  return balanced;
};

const srtTimestamp = (seconds: number): string => {
  const milliseconds = Math.max(0, Math.round(seconds * 1_000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const wholeSeconds = Math.floor((milliseconds % 60_000) / 1_000);
  const millis = milliseconds % 1_000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
};

export const allocateQuickProductionNarrationTimings = (
  thoughts: readonly string[],
  durationSeconds: number,
): LocalF5TtsSegmentResult[] => {
  const weights = thoughts.map((thought) => Math.max(1, Array.from(thought.replace(/\s+/gu, '')).length));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  let cursor = 0;
  return thoughts.map((text, index) => {
    const startSeconds = Number(cursor.toFixed(6));
    cursor = index === thoughts.length - 1
      ? durationSeconds
      : cursor + durationSeconds * (weights[index]! / totalWeight);
    const endSeconds = Number(cursor.toFixed(6));
    return {
      id: `beat-${index + 1}`,
      text,
      startSeconds,
      endSeconds,
      durationSeconds: Number((endSeconds - startSeconds).toFixed(6)),
    };
  });
};

const writeSrt = async (
  outputPath: string,
  thoughts: readonly string[],
  measured: readonly LocalF5TtsSegmentResult[] | null,
  durationSeconds: number,
): Promise<void> => {
  const fallbackLength = durationSeconds / thoughts.length;
  const blocks = thoughts.map((text, index) => {
    const segment = measured?.[index];
    const start = segment?.startSeconds ?? index * fallbackLength;
    const end = segment?.endSeconds ?? Math.min(durationSeconds, (index + 1) * fallbackLength);
    return `${index + 1}\n${srtTimestamp(start)} --> ${srtTimestamp(end)}\n${text}`;
  });
  await fs.writeFile(outputPath, `${blocks.join('\n\n')}\n`, 'utf8');
};

const runFfmpeg = async (args: string[]): Promise<void> => {
  const ffmpeg = path.join(repositoryRoot, 'node_modules', '@remotion', 'compositor-win32-x64-msvc', 'ffmpeg.exe');
  try {
    await execFileAsync(ffmpeg, args, {
      cwd: repositoryRoot,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30 * 60_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    const stderr = (error as {stderr?: string}).stderr?.slice(-4_000) ?? '';
    throw new Error(`QUICK_PRODUCTION_FFMPEG_FAILED:${stderr || String(error)}`);
  }
};

const ffconcatPath = (filePath: string): string => filePath.replace(/\\/gu, '/').replace(/'/gu, "'\\''");

export const runQuickProduction = async (creationRootValue: string, outputRootValue: string) => {
  const creationRoot = path.resolve(creationRootValue);
  const outputRoot = path.resolve(outputRootValue);
  const creation = creationSchema.parse(JSON.parse(await fs.readFile(path.join(creationRoot, 'creation.json'), 'utf8')));
  await fs.mkdir(outputRoot, {recursive: true});
  const thoughts = splitQuickProductionThoughts(creation.script);
  progress(0.03, 'understand-script', `已拆成 ${thoughts.length} 个叙事节拍`);

  let narrationPath: string | null = null;
  let measuredSegments: readonly LocalF5TtsSegmentResult[] | null = null;
  let deliveryDuration = creation.durationSeconds;
  if (creation.voice) {
    progress(0.06, 'synthesize-voice', '正在生成本地旁白');
    narrationPath = path.join(outputRoot, 'narration.wav');
    let narrationDuration: number;
    try {
      narrationDuration = (await probeWav(narrationPath)).durationSeconds;
      progress(0.1, 'synthesize-voice', '已复用本地旁白');
    } catch {
      const cacheRoot = path.join(outputRoot, 'cache', 'f5-tts');
      const environment = await prepareLocalF5TtsEnvironment({
        cacheRoot,
        ffmpegDirectory: path.join(repositoryRoot, 'node_modules', '@remotion', 'compositor-win32-x64-msvc'),
        offline: true,
      });
      const runtime = await createLocalF5TtsRuntime({
        compatibility: {mode: 'compat-wrapper'},
        speed: creation.platform === 'douyin' ? 1.12 : 1.04,
        device: process.env.F5_TTS_DEVICE ?? 'cuda',
        environment,
        ...(process.env.F5_TTS_MODEL ? {model: process.env.F5_TTS_MODEL} : {}),
      });
      const narration = await runtime.synthesize({
        referenceAudioPath: path.join(repositoryRoot, 'examples', 'morning-light-v3', 'assets', 'voice-reference.wav'),
        referenceText: '先说答案：车头撞得越“会坏”，人反而越有机会少受伤，因为溃缩区拿自己的变形，替乘员争取减速时间。',
        text: creation.script,
        outputPath: narrationPath,
        overwrite: true,
      });
      narrationDuration = narration.wav.durationSeconds;
    }
    measuredSegments = allocateQuickProductionNarrationTimings(thoughts, narrationDuration);
    deliveryDuration = Math.max(creation.durationSeconds, Math.ceil(narrationDuration + 0.5));
    if (deliveryDuration > 60) throw new Error('CREATION_SCRIPT_TOO_LONG_FOR_60_SECONDS');
  }

  const shotPaths: string[] = [];
  const shotsDirectory = path.join(outputRoot, 'shots');
  await fs.mkdir(shotsDirectory, {recursive: true});
  const fastWanShotCount = Math.max(1, Math.ceil(deliveryDuration / (81 / 24)));
  const expectedShotPaths = Array.from({length: fastWanShotCount}, (_, index) =>
    path.join(shotsDirectory, `shot-${String(index + 1).padStart(2, '0')}.mp4`));
  const allShotsReusable = (await Promise.all(expectedShotPaths.map(isReusableVideo))).every(Boolean);
  if (allShotsReusable) {
    shotPaths.push(...expectedShotPaths);
    progress(0.82, 'generate-visuals', `已复用 ${fastWanShotCount} 个本地镜头`);
  } else {
    const providerRoot = path.join(outputRoot, 'provider');
    const runtime = createLocalWanGPRuntime(path.join(providerRoot, 'wangp-raw'));
    const jobStore = new FileVideoGenerationJobStore(path.join(providerRoot, 'jobs.json'));
    await jobStore.initialize();
    const provider = new WanGPProvider({
      transport: runtime.transport,
      outputDirectory: path.join(providerRoot, 'provider-jobs'),
      callbacks: {
        persistJob: async (job) => { await jobStore.upsert({...job}); },
        log: (level, message, details) => process.stderr.write(`[wangp:${level}] ${message} ${details ? JSON.stringify(details) : ''}\n`),
      },
    });
    try {
      progress(0.12, 'prepare-local-model', '正在连接 FastWan 本地模型');
      const detection = await provider.detect();
      if (!detection.available) throw new Error(`WANGP_UNAVAILABLE:${detection.reason ?? 'unknown'}`);
      const preset = choosePreset(await provider.listPresets());
      const shotDuration = preset.frameCount / preset.fps;
      const shotCount = Math.max(1, Math.ceil(deliveryDuration / shotDuration));
      for (let index = 0; index < shotCount; index += 1) {
        const thought = thoughts[index % thoughts.length]!;
        const phaseStart = 0.15 + (index / shotCount) * 0.67;
        const shotPath = path.join(shotsDirectory, `shot-${String(index + 1).padStart(2, '0')}.mp4`);
        if (await isReusableVideo(shotPath)) {
          shotPaths.push(shotPath);
          progress(phaseStart + (0.67 / shotCount), 'generate-visuals', `已复用镜头 ${index + 1}/${shotCount}`);
          continue;
        }
        progress(phaseStart, 'generate-visuals', `正在生成镜头 ${index + 1}/${shotCount}`);
        const initial = await provider.submit({
          projectId: creation.id,
          shotId: `shot-${String(index + 1).padStart(2, '0')}`,
          prompt: buildQuickProductionShotPrompt(creation, thought, index),
          negativePrompt: NEGATIVE_PROMPT,
          width: preset.width,
          height: preset.height,
          fps: preset.fps,
          frameCount: preset.frameCount,
          seed: stableQuickProductionSeed(creation.id, index),
          motionStrength: 0.72,
          presetId: preset.id,
        }, {modelRuntimeId: 'ti2v_2_2_fastwan'});
        const completed = await waitForJob(provider, initial, (job) => {
          const withinShot = Math.min(0.98, Math.max(0, job.progress));
          const overall = 0.15 + ((index + withinShot) / shotCount) * 0.67;
          progress(overall, 'generate-visuals', `镜头 ${index + 1}/${shotCount} · ${Math.round(withinShot * 100)}%`);
        });
        if (completed.status !== 'complete' || !completed.outputPath) {
          throw new Error(`WANGP_GENERATION_FAILED:${completed.error?.message ?? completed.status}`);
        }
        await fs.copyFile(completed.outputPath, shotPath);
        shotPaths.push(shotPath);
      }
    } finally {
      await runtime.transport.close().catch(() => undefined);
    }
  }

  progress(0.85, 'compose-video', '正在合成画面与旁白');
  const concatPath = path.join(outputRoot, 'shots.ffconcat');
  await fs.writeFile(concatPath, shotPaths.map((shotPath) => `file '${ffconcatPath(shotPath)}'`).join('\n') + '\n', 'utf8');
  const finalVideoPath = path.join(outputRoot, 'final.mp4');
  const filter = narrationPath
    ? `[0:v]scale=720:1280[v];[1:a]apad=pad_dur=${deliveryDuration}[a]`
    : '[0:v]scale=720:1280[v]';
  await runFfmpeg([
    '-y', '-fflags', '+genpts', '-f', 'concat', '-safe', '0', '-i', concatPath,
    ...(narrationPath ? ['-i', narrationPath] : []),
    '-filter_complex', filter, '-map', '[v]', ...(narrationPath ? ['-map', '[a]'] : []),
    '-t', String(deliveryDuration), '-r', '24', '-pix_fmt', 'yuv420p',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
    ...(narrationPath ? ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000'] : ['-an']),
    '-movflags', '+faststart', finalVideoPath,
  ]);

  const subtitlePath = path.join(outputRoot, 'final.srt');
  await writeSrt(subtitlePath, thoughts, measuredSegments, deliveryDuration);
  const thumbnailPath = path.join(outputRoot, 'thumbnail.jpg');
  await runFfmpeg(['-y', '-ss', '1', '-i', finalVideoPath, '-frames:v', '1', '-q:v', '2', thumbnailPath]);
  progress(1, 'complete', '视频已完成');
  return {
    event: 'quick-complete',
    creationId: creation.id,
    title: creation.title,
    durationSeconds: deliveryDuration,
    videoPath: 'final.mp4',
    subtitlePath: 'final.srt',
    thumbnailPath: 'thumbnail.jpg',
    narrationPath: narrationPath ? 'narration.wav' : null,
    shotCount: shotPaths.length,
    subtitlesBurnedIn: false,
    bgm: false,
    model: 'ti2v_2_2_fastwan',
  };
};

const main = async (): Promise<void> => {
  const creationRoot = process.argv[2];
  const outputRoot = process.argv[3];
  if (!creationRoot || !outputRoot) {
    throw new Error('Usage: tsx scripts/quick-production.ts <creation-root> <output-root>');
  }
  process.stdout.write(`${JSON.stringify(await runQuickProduction(creationRoot, outputRoot))}\n`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

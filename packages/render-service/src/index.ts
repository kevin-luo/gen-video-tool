import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {bundle} from '@remotion/bundler';
import {getCompositions, renderMedia, type CancelSignal} from '@remotion/renderer';
import {probeVideo} from '@gen-video-tool/video-generation';
import {
  buildProjectQaFrameSamples,
  loadProductionRenderContext,
} from './production-render';

export * from './production-render';

export type RenderPhase = 'preparing' | 'rendering' | 'checking' | 'done';

export interface RenderProjectOptions {
  projectRoot: string;
  outputRoot: string;
  workspaceRoot: string;
  onProgress?: (phase: RenderPhase, progress: number) => void;
  cancelSignal?: CancelSignal;
}

export interface RenderProjectResult {
  videoPath: string;
  subtitlesPath: string | null;
  qaFramePaths: string[];
  durationSeconds: number;
}

const executableName = (name: 'ffmpeg' | 'ffprobe') => process.platform === 'win32' ? `${name}.exe` : name;

const findRemotionTool = (root: string, name: 'ffmpeg' | 'ffprobe'): string => {
  const environment = process.env[`${name.toUpperCase()}_PATH`];
  if (environment && path.isAbsolute(environment) && fsSync.existsSync(environment)) return environment;
  const remotionRoot = path.join(root, 'node_modules', '@remotion');
  if (fsSync.existsSync(remotionRoot)) {
    for (const directory of fsSync.readdirSync(remotionRoot)) {
      if (!directory.startsWith('compositor-')) continue;
      const candidate = path.join(remotionRoot, directory, executableName(name));
      if (fsSync.existsSync(candidate)) return candidate;
    }
  }
  return executableName(name);
};

const findBrowserExecutable = (): string | null => {
  const candidates = [
    process.env.REMOTION_BROWSER_EXECUTABLE,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find((candidate) => fsSync.existsSync(candidate)) ?? null;
};

const run = async (executable: string, args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, args, {shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe']});
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`PROCESS_FAILED:${code ?? 'unknown'}:${stderr.slice(-1200)}`)));
  });

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

const isInside = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

export const renderProjectDirectory = async (options: RenderProjectOptions): Promise<RenderProjectResult> => {
  const projectRoot = path.resolve(options.projectRoot);
  const productionContext = await loadProductionRenderContext(projectRoot);
  const durationSeconds = productionContext.plan.delivery.timeline.durationFrames
    / productionContext.plan.delivery.timeline.fps;
  const runtimeId = `${productionContext.plan.projectId}-${process.pid}-${Date.now()}`;
  const runtimeRoot = path.join(options.workspaceRoot, 'public', 'runtime', runtimeId);
  const outputRoot = path.resolve(options.outputRoot);
  if (
    outputRoot === path.parse(outputRoot).root
    || isInside(projectRoot, outputRoot)
    || isInside(outputRoot, projectRoot)
    || outputRoot === path.resolve(options.workspaceRoot)
  ) {
    throw new Error('RENDER_OUTPUT_ROOT_UNSAFE');
  }
  const picturePath = path.join(outputRoot, 'picture.mp4');
  const videoPath = path.join(outputRoot, path.basename(productionContext.plan.delivery.video.path));
  const qaRoot = path.join(outputRoot, 'qa-frames');
  const narrationSourcePath = productionContext.narrationPath;
  const subtitleSourcePath = productionContext.subtitlePath;
  const subtitlesPath = path.join(outputRoot, path.basename(productionContext.plan.delivery.subtitles.path));
  options.onProgress?.('preparing', 0.04);
  await fs.mkdir(outputRoot, {recursive: true});
  await Promise.all([
    fs.rm(picturePath, {force: true}),
    fs.rm(videoPath, {force: true}),
    fs.rm(subtitlesPath, {force: true}),
    fs.rm(qaRoot, {recursive: true, force: true}),
  ]);
  await fs.mkdir(path.dirname(runtimeRoot), {recursive: true});
  await fs.cp(projectRoot, runtimeRoot, {recursive: true});
  try {
    const serveUrl = await bundle({
      entryPoint: path.join(options.workspaceRoot, 'packages', 'remotion-engine', 'src', 'entry.ts'),
      publicDir: path.join(options.workspaceRoot, 'public'),
    });
    const inputProps = {
      assetBase: `runtime/${runtimeId}`,
      productionRenderData: productionContext.renderData,
    };
    const browserExecutable = findBrowserExecutable();
    const compositions = await getCompositions(serveUrl, {inputProps, browserExecutable});
    const composition = compositions.find((item) => item.id === 'GenVideoProject');
    if (!composition) throw new Error('REMOTION_COMPOSITION_MISSING');
    options.onProgress?.('rendering', 0.12);
    await renderMedia({
      serveUrl,
      composition,
      codec: 'h264',
      outputLocation: picturePath,
      inputProps,
      browserExecutable,
      muted: true,
      enforceAudioTrack: false,
      pixelFormat: 'yuv420p',
      colorSpace: 'bt709',
      crf: 19,
      concurrency: 2,
      ...(options.cancelSignal ? {cancelSignal: options.cancelSignal} : {}),
      onProgress: ({progress}) => options.onProgress?.('rendering', 0.12 + progress * 0.72),
    });
    options.onProgress?.('checking', 0.86);
    const ffmpeg = findRemotionTool(options.workspaceRoot, 'ffmpeg');
    const narration = path.join(projectRoot, ...narrationSourcePath.split('/'));
    await run(ffmpeg, [
      '-y', '-i', picturePath, '-i', narration,
      '-map', '0:v:0', '-map', '1:a:0',
      '-c:v', 'copy', '-c:a', productionContext.plan.delivery.audio.muxCodec, '-b:a', '192k',
      '-ar', String(productionContext.plan.delivery.audio.muxSampleRate),
      '-t', durationSeconds.toFixed(3), '-movflags', '+faststart', videoPath,
    ]);
    await fs.rm(picturePath, {force: true});
    await fs.copyFile(path.join(projectRoot, ...subtitleSourcePath.split('/')), subtitlesPath);
    const finalProbe = await probeVideo(videoPath, {
      ffmpegPath: ffmpeg,
      ffprobePath: findRemotionTool(options.workspaceRoot, 'ffprobe'),
    });
    const delivery = productionContext.plan.delivery;
    const probeIssues = [
      finalProbe.width === delivery.raster.width && finalProbe.height === delivery.raster.height
        ? null
        : `raster:${finalProbe.width}x${finalProbe.height}`,
      finalProbe.fps !== null && Math.abs(finalProbe.fps - delivery.timeline.fps) <= 0.01
        ? null
        : `fps:${String(finalProbe.fps)}`,
      finalProbe.frameCount !== null && Math.abs(finalProbe.frameCount - delivery.timeline.durationFrames) <= 1
        ? null
        : `frames:${String(finalProbe.frameCount)}`,
      finalProbe.codecName === delivery.video.codec ? null : `codec:${String(finalProbe.codecName)}`,
      finalProbe.pixelFormat === delivery.video.pixelFormat ? null : `pixel-format:${String(finalProbe.pixelFormat)}`,
      finalProbe.hasAudio ? null : 'audio:missing',
    ].filter((issue): issue is string => issue !== null);
    if (probeIssues.length > 0) {
      throw new Error(`FINAL_DELIVERY_QA_FAILED:${probeIssues.join(',')}`);
    }
    await fs.mkdir(qaRoot, {recursive: true});
    const qaSamples = buildProjectQaFrameSamples(productionContext.plan);
    const qaFramePaths: string[] = [];
    for (const [index, sample] of qaSamples.entries()) {
      const seconds = Math.min(
        Math.max(0, durationSeconds - 1 / productionContext.plan.delivery.timeline.fps),
        sample.frame / productionContext.plan.delivery.timeline.fps,
      );
      const target = path.join(
        qaRoot,
        `frame-${String(index + 1).padStart(2, '0')}-f${String(sample.frame).padStart(6, '0')}.jpg`,
      );
      await run(ffmpeg, ['-y', '-ss', seconds.toFixed(3), '-i', videoPath, '-frames:v', '1', '-q:v', '2', target]);
      const stat = await fs.stat(target);
      if (stat.size < 10_000) throw new Error(`QA_FRAME_TOO_SMALL:${target}`);
      qaFramePaths.push(target);
      options.onProgress?.('checking', 0.86 + ((index + 1) / qaSamples.length) * 0.13);
    }
    // Commit the verified export to the canonical project-relative delivery
    // path only after every QA sample was extracted successfully.
    await copyFileAtomic(
      videoPath,
      path.join(projectRoot, ...productionContext.plan.delivery.video.path.split('/')),
    );
    options.onProgress?.('done', 1);
    return {videoPath, subtitlesPath, qaFramePaths, durationSeconds};
  } finally {
    await fs.rm(runtimeRoot, {recursive: true, force: true});
  }
};

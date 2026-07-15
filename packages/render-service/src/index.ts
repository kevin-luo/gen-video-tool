import {spawn} from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {bundle} from '@remotion/bundler';
import {getCompositions, renderMedia, type CancelSignal} from '@remotion/renderer';
import {loadProjectDirectory, projectDurationSeconds} from '@gen-video-tool/asset-pack';

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

export const renderProjectDirectory = async (options: RenderProjectOptions): Promise<RenderProjectResult> => {
  const project = await loadProjectDirectory(options.projectRoot);
  const durationSeconds = projectDurationSeconds(project);
  const runtimeId = `${project.manifest.projectId}-${process.pid}-${Date.now()}`;
  const runtimeRoot = path.join(options.workspaceRoot, 'public', 'runtime', runtimeId);
  const outputRoot = path.resolve(options.outputRoot);
  const picturePath = path.join(outputRoot, 'picture.mp4');
  const videoPath = path.join(outputRoot, 'final.mp4');
  const qaRoot = path.join(outputRoot, 'qa-frames');
  const subtitlesPath = project.manifest.subtitlesPath ? path.join(outputRoot, 'subtitles.srt') : null;
  options.onProgress?.('preparing', 0.04);
  await fs.rm(outputRoot, {recursive: true, force: true});
  await fs.mkdir(outputRoot, {recursive: true});
  await fs.mkdir(path.dirname(runtimeRoot), {recursive: true});
  await fs.cp(options.projectRoot, runtimeRoot, {recursive: true});
  try {
    const serveUrl = await bundle({
      entryPoint: path.join(options.workspaceRoot, 'packages', 'remotion-engine', 'src', 'entry.ts'),
      publicDir: path.join(options.workspaceRoot, 'public'),
    });
    const inputProps = {project, assetBase: `runtime/${runtimeId}`};
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
      crf: 19,
      concurrency: 2,
      ...(options.cancelSignal ? {cancelSignal: options.cancelSignal} : {}),
      onProgress: ({progress}) => options.onProgress?.('rendering', 0.12 + progress * 0.72),
    });
    options.onProgress?.('checking', 0.86);
    const ffmpeg = findRemotionTool(options.workspaceRoot, 'ffmpeg');
    if (project.manifest.audio) {
      const narration = path.join(options.projectRoot, ...project.manifest.audio.narrationPath.split('/'));
      await run(ffmpeg, [
        '-y', '-i', picturePath, '-i', narration,
        '-map', '0:v:0', '-map', '1:a:0',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
        '-t', durationSeconds.toFixed(3), '-movflags', '+faststart', videoPath,
      ]);
      await fs.rm(picturePath, {force: true});
    } else {
      await fs.rename(picturePath, videoPath);
    }
    if (project.manifest.subtitlesPath && subtitlesPath) {
      await fs.copyFile(path.join(options.projectRoot, ...project.manifest.subtitlesPath.split('/')), subtitlesPath);
    }
    await fs.mkdir(qaRoot, {recursive: true});
    const sampleTimes = [0.1, durationSeconds / 2, Math.max(0.1, durationSeconds - 0.15)];
    const qaFramePaths = await Promise.all(sampleTimes.map(async (seconds, index) => {
      const target = path.join(qaRoot, `frame-${index + 1}.jpg`);
      await run(ffmpeg, ['-y', '-ss', seconds.toFixed(3), '-i', videoPath, '-frames:v', '1', '-q:v', '2', target]);
      const stat = await fs.stat(target);
      if (stat.size < 10_000) throw new Error(`QA_FRAME_TOO_SMALL:${target}`);
      return target;
    }));
    options.onProgress?.('done', 1);
    return {videoPath, subtitlesPath, qaFramePaths, durationSeconds};
  } finally {
    await fs.rm(runtimeRoot, {recursive: true, force: true});
  }
};

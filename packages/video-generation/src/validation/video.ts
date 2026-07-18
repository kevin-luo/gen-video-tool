import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdir, rename, rm, stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const DEFAULT_MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024 * 1024;
const DEFAULT_PROCESS_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const FPS_TOLERANCE = 0.01;

export type VideoValidationErrorCode =
  | 'VIDEO_PATH_INVALID'
  | 'VIDEO_PATH_NOT_ABSOLUTE'
  | 'VIDEO_SOURCE_MISSING'
  | 'VIDEO_SOURCE_NOT_FILE'
  | 'VIDEO_SOURCE_TOO_LARGE'
  | 'VIDEO_OUTPUT_OUTSIDE_ROOT'
  | 'VIDEO_OUTPUT_EXISTS'
  | 'VIDEO_TOOL_CONFIGURATION_INVALID'
  | 'VIDEO_TOOL_NOT_FOUND'
  | 'VIDEO_PROBE_FAILED'
  | 'VIDEO_UNDECODABLE'
  | 'VIDEO_STREAM_MISSING'
  | 'VIDEO_METADATA_INVALID'
  | 'VIDEO_TRANSCODE_FAILED'
  | 'VIDEO_OUTPUT_MISSING'
  | 'VIDEO_OUTPUT_INVALID';

export class VideoValidationError extends Error {
  readonly code: VideoValidationErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: VideoValidationErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'VideoValidationError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export interface VideoToolPaths {
  ffmpegPath: string;
  ffprobePath: string;
}

export interface VideoToolPathOptions {
  ffmpegPath?: string;
  ffprobePath?: string;
}

export interface VideoProcessRequest {
  command: string;
  args: readonly string[];
  cwd?: string;
  timeoutMs?: number;
}

export interface VideoProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type VideoProcessRunner = (request: VideoProcessRequest) => Promise<VideoProcessResult>;

const appendBounded = (current: string, chunk: string): string => {
  const combined = current + chunk;
  if (Buffer.byteLength(combined, 'utf8') <= MAX_CAPTURE_BYTES) return combined;
  return combined.slice(-MAX_CAPTURE_BYTES);
};

/**
 * Execute FFmpeg-family tools without a shell. Paths and arguments are passed
 * separately so spaces, Chinese characters, and shell metacharacters remain
 * data rather than executable syntax.
 */
export const spawnVideoTool: VideoProcessRunner = async (request) =>
  await new Promise<VideoProcessResult>((resolve, reject) => {
    const child = spawn(request.command, [...request.args], {
      ...(request.cwd === undefined ? {} : {cwd: request.cwd}),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, request.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on('data', (chunk: string) => {
      stderr = appendBounded(stderr, chunk);
    });

    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({code, signal, stdout, stderr, timedOut});
    });
  });

const isFile = async (candidate: string): Promise<boolean> => {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
};

const resolveInjectedTools = async (options: VideoToolPathOptions): Promise<VideoToolPaths | null> => {
  if (options.ffmpegPath === undefined && options.ffprobePath === undefined) return null;

  const anchor = options.ffmpegPath ?? options.ffprobePath;
  if (anchor === undefined || anchor.includes('\0')) {
    throw new VideoValidationError(
      'VIDEO_TOOL_CONFIGURATION_INVALID',
      'FFmpeg/ffprobe executable paths are invalid.',
    );
  }
  const directory = path.dirname(path.resolve(anchor));
  const ffmpegPath = path.resolve(options.ffmpegPath ?? path.join(directory, 'ffmpeg.exe'));
  const ffprobePath = path.resolve(options.ffprobePath ?? path.join(directory, 'ffprobe.exe'));
  if (!(await isFile(ffmpegPath)) || !(await isFile(ffprobePath))) {
    throw new VideoValidationError(
      'VIDEO_TOOL_NOT_FOUND',
      'The configured FFmpeg and ffprobe executables must both exist.',
      {ffmpegPath, ffprobePath},
    );
  }
  return {ffmpegPath, ffprobePath};
};

/** Locate the FFmpeg binaries shipped with Remotion, unless explicitly injected. */
export const discoverVideoTools = async (
  options: VideoToolPathOptions = {},
): Promise<VideoToolPaths> => {
  const injected = await resolveInjectedTools(options);
  if (injected !== null) return injected;

  const require = createRequire(import.meta.url);
  const directories = new Set<string>();
  try {
    directories.add(path.dirname(require.resolve('@remotion/compositor-win32-x64-msvc')));
  } catch {
    // Source checkouts can still locate the hoisted dependency below.
  }
  directories.add(path.resolve(process.cwd(), 'node_modules', '@remotion', 'compositor-win32-x64-msvc'));
  directories.add(path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../../node_modules/@remotion/compositor-win32-x64-msvc',
  ));

  for (const directory of directories) {
    const ffmpegPath = path.join(directory, 'ffmpeg.exe');
    const ffprobePath = path.join(directory, 'ffprobe.exe');
    if ((await isFile(ffmpegPath)) && (await isFile(ffprobePath))) {
      return {ffmpegPath, ffprobePath};
    }
  }
  throw new VideoValidationError(
    'VIDEO_TOOL_NOT_FOUND',
    'Remotion-bundled FFmpeg/ffprobe were not found. Install dependencies or inject executable paths.',
  );
};

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  nb_frames?: string;
  duration?: string;
}

interface FfprobeDocument {
  streams?: FfprobeStream[];
  format?: {
    duration?: string;
    format_name?: string;
  };
}

export interface VideoProbe {
  sourcePath: string;
  width: number;
  height: number;
  fps: number | null;
  frameCount: number | null;
  durationSeconds: number | null;
  codecName: string | null;
  pixelFormat: string | null;
  formatName: string | null;
  hasAudio: boolean;
  fileSizeBytes: number;
}

export interface ProbeVideoOptions extends VideoToolPathOptions {
  tools?: VideoToolPaths;
  processRunner?: VideoProcessRunner;
  timeoutMs?: number;
  maxFileSizeBytes?: number;
}

const parsePositiveNumber = (value: string | number | undefined): number | null => {
  if (value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const parseFps = (value: string | undefined): number | null => {
  if (value === undefined) return null;
  const [numeratorRaw, denominatorRaw] = value.split('/');
  if (denominatorRaw === undefined) return parsePositiveNumber(numeratorRaw);
  const numerator = Number.parseFloat(numeratorRaw ?? '');
  const denominator = Number.parseFloat(denominatorRaw);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  const fps = numerator / denominator;
  return Number.isFinite(fps) && fps > 0 ? fps : null;
};

const assertAbsoluteSafePath = (candidate: string, label: string): string => {
  if (candidate.length === 0 || candidate.includes('\0')) {
    throw new VideoValidationError('VIDEO_PATH_INVALID', `${label} path is empty or contains NUL.`);
  }
  if (!path.isAbsolute(candidate)) {
    throw new VideoValidationError(
      'VIDEO_PATH_NOT_ABSOLUTE',
      `${label} must be an absolute local path.`,
      {path: candidate},
    );
  }
  return path.resolve(candidate);
};

const inspectSourceFile = async (sourcePath: string, maxFileSizeBytes: number): Promise<number> => {
  let metadata;
  try {
    metadata = await stat(sourcePath);
  } catch {
    throw new VideoValidationError('VIDEO_SOURCE_MISSING', 'The source video does not exist.', {sourcePath});
  }
  if (!metadata.isFile()) {
    throw new VideoValidationError('VIDEO_SOURCE_NOT_FILE', 'The source video path is not a file.', {sourcePath});
  }
  if (metadata.size > maxFileSizeBytes) {
    throw new VideoValidationError(
      'VIDEO_SOURCE_TOO_LARGE',
      'The source video exceeds the configured import size limit.',
      {sourcePath, fileSizeBytes: metadata.size, maxFileSizeBytes},
    );
  }
  return metadata.size;
};

const tail = (value: string, length = 4_000): string => value.slice(-length);

export const probeVideo = async (
  candidatePath: string,
  options: ProbeVideoOptions = {},
): Promise<VideoProbe> => {
  const sourcePath = assertAbsoluteSafePath(candidatePath, 'Source video');
  const fileSizeBytes = await inspectSourceFile(
    sourcePath,
    options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES,
  );
  const tools = options.tools ?? await discoverVideoTools(options);
  const processRunner = options.processRunner ?? spawnVideoTool;

  let result: VideoProcessResult;
  try {
    result = await processRunner({
      command: tools.ffprobePath,
      args: [
        '-v', 'error',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        sourcePath,
      ],
      timeoutMs: options.timeoutMs ?? 60_000,
    });
  } catch (error) {
    throw new VideoValidationError('VIDEO_PROBE_FAILED', 'ffprobe could not be started.', {
      sourcePath,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (result.code !== 0 || result.timedOut) {
    throw new VideoValidationError('VIDEO_UNDECODABLE', 'The source video cannot be decoded.', {
      sourcePath,
      exitCode: result.code,
      timedOut: result.timedOut,
      stderr: tail(result.stderr),
    });
  }

  let document: FfprobeDocument;
  try {
    document = JSON.parse(result.stdout) as FfprobeDocument;
  } catch {
    throw new VideoValidationError('VIDEO_PROBE_FAILED', 'ffprobe returned invalid metadata.', {
      sourcePath,
      stdout: tail(result.stdout),
    });
  }
  const streams = Array.isArray(document.streams) ? document.streams : [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  if (video === undefined) {
    throw new VideoValidationError('VIDEO_STREAM_MISSING', 'The selected file has no video stream.', {sourcePath});
  }
  const width = parsePositiveNumber(video.width);
  const height = parsePositiveNumber(video.height);
  if (width === null || height === null) {
    throw new VideoValidationError('VIDEO_METADATA_INVALID', 'The video has invalid dimensions.', {sourcePath});
  }
  const fps = parseFps(video.avg_frame_rate) ?? parseFps(video.r_frame_rate);
  const durationSeconds = parsePositiveNumber(video.duration) ?? parsePositiveNumber(document.format?.duration);
  const explicitFrameCount = parsePositiveNumber(video.nb_frames);
  const frameCount = explicitFrameCount === null
    ? durationSeconds !== null && fps !== null ? Math.round(durationSeconds * fps) : null
    : Math.round(explicitFrameCount);

  return {
    sourcePath,
    width: Math.round(width),
    height: Math.round(height),
    fps,
    frameCount,
    durationSeconds,
    codecName: video.codec_name ?? null,
    pixelFormat: video.pix_fmt ?? null,
    formatName: document.format?.format_name ?? null,
    hasAudio: streams.some((stream) => stream.codec_type === 'audio'),
    fileSizeBytes,
  };
};

export interface NormalizeVideoOptions extends VideoToolPathOptions {
  sourcePath: string;
  outputPath: string;
  outputRoot?: string;
  targetFps: number;
  durationSeconds?: number;
  /** Stretch/compress the full source to the requested duration instead of only trimming it. */
  temporalFit?: 'trim' | 'stretch';
  maxFileSizeBytes?: number;
  timeoutMs?: number;
  overwrite?: boolean;
  tools?: VideoToolPaths;
  processRunner?: VideoProcessRunner;
}

export interface NormalizeVideoResult {
  outputPath: string;
  source: VideoProbe;
  output: VideoProbe;
}

export interface VideoTemporalStretch {
  targetFrameCount: number;
  timestampScale: number;
}

/**
 * Calculate an endpoint-preserving timestamp scale. Using frame-count spans
 * avoids the extra-frame drift caused by scaling container duration directly.
 */
export const calculateVideoTemporalStretch = (
  source: Pick<VideoProbe, 'durationSeconds' | 'fps' | 'frameCount'>,
  targetDurationSeconds: number,
  targetFps: number,
): VideoTemporalStretch => {
  const targetFrameCount = Math.max(1, Math.round(targetDurationSeconds * targetFps));
  const sourceTimelineSpan = source.frameCount !== null && source.fps !== null && source.frameCount > 1
    ? (source.frameCount - 1) / source.fps
    : source.durationSeconds;
  if (sourceTimelineSpan === null || !Number.isFinite(sourceTimelineSpan) || sourceTimelineSpan <= 0) {
    throw new VideoValidationError(
      'VIDEO_METADATA_INVALID',
      'Temporal stretching requires a positive source timeline span.',
      {source},
    );
  }
  const targetTimelineSpan = targetFrameCount > 1
    ? (targetFrameCount - 1) / targetFps
    : targetDurationSeconds;
  const timestampScale = targetTimelineSpan / sourceTimelineSpan;
  if (!Number.isFinite(timestampScale) || timestampScale <= 0) {
    throw new VideoValidationError(
      'VIDEO_METADATA_INVALID',
      'Temporal stretching produced an invalid timestamp scale.',
      {source, targetDurationSeconds, targetFps},
    );
  }
  return {targetFrameCount, timestampScale};
};

const isPathInside = (root: string, candidate: string): boolean => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
};

export const normalizeVideo = async (
  options: NormalizeVideoOptions,
): Promise<NormalizeVideoResult> => {
  if (!Number.isFinite(options.targetFps) || options.targetFps <= 0 || options.targetFps > 240) {
    throw new VideoValidationError('VIDEO_METADATA_INVALID', 'Target FPS must be between 0 and 240.');
  }
  if (
    options.durationSeconds !== undefined &&
    (!Number.isFinite(options.durationSeconds) || options.durationSeconds <= 0)
  ) {
    throw new VideoValidationError('VIDEO_METADATA_INVALID', 'Target duration must be positive.');
  }

  const sourcePath = assertAbsoluteSafePath(options.sourcePath, 'Source video');
  const outputPath = assertAbsoluteSafePath(options.outputPath, 'Output video');
  const outputRoot = options.outputRoot === undefined
    ? path.dirname(outputPath)
    : path.resolve(options.outputRoot);
  if (!isPathInside(outputRoot, outputPath)) {
    throw new VideoValidationError(
      'VIDEO_OUTPUT_OUTSIDE_ROOT',
      'The normalized video output must stay inside the configured import directory.',
      {outputPath, outputRoot},
    );
  }
  if (path.normalize(sourcePath).toLowerCase() === path.normalize(outputPath).toLowerCase()) {
    throw new VideoValidationError('VIDEO_PATH_INVALID', 'Source and output video paths must differ.');
  }
  if (!options.overwrite && await isFile(outputPath)) {
    throw new VideoValidationError('VIDEO_OUTPUT_EXISTS', 'The normalized output already exists.', {outputPath});
  }

  await mkdir(path.dirname(outputPath), {recursive: true});
  const temporaryPath = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath, path.extname(outputPath))}.${randomUUID()}.partial.mp4`,
  );
  const tools = options.tools ?? await discoverVideoTools(options);
  const processRunner = options.processRunner ?? spawnVideoTool;
  const sharedProbeOptions: ProbeVideoOptions = {
    tools,
    processRunner,
    ...(options.maxFileSizeBytes === undefined ? {} : {maxFileSizeBytes: options.maxFileSizeBytes}),
  };
  const source = await probeVideo(sourcePath, sharedProbeOptions);

  const stretchToDuration = options.temporalFit === 'stretch' && options.durationSeconds !== undefined;
  const temporalStretch = stretchToDuration
    ? calculateVideoTemporalStretch(source, options.durationSeconds!, options.targetFps)
    : undefined;
  const targetFrameCount = temporalStretch?.targetFrameCount;

  const args = [
    '-hide_banner',
    '-nostdin',
    '-y',
    ...(stretchToDuration
      ? ['-itsscale', temporalStretch!.timestampScale.toFixed(12)]
      : []),
    '-i', sourcePath,
    '-map', '0:v:0',
    '-map_metadata', '-1',
    '-sn',
    '-dn',
    '-an',
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-r', String(options.targetFps),
    '-fps_mode', 'cfr',
    '-movflags', '+faststart',
  ];
  if (options.durationSeconds !== undefined && !stretchToDuration) {
    args.push('-t', String(options.durationSeconds));
  }
  if (targetFrameCount !== undefined) args.push('-frames:v', String(targetFrameCount));
  args.push(temporaryPath);

  try {
    let result: VideoProcessResult;
    try {
      result = await processRunner({
        command: tools.ffmpegPath,
        args,
        timeoutMs: options.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS,
      });
    } catch (error) {
      throw new VideoValidationError('VIDEO_TRANSCODE_FAILED', 'FFmpeg could not be started.', {
        sourcePath,
        outputPath,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    if (result.code !== 0 || result.timedOut) {
      throw new VideoValidationError('VIDEO_TRANSCODE_FAILED', 'FFmpeg failed to normalize the video.', {
        sourcePath,
        outputPath,
        exitCode: result.code,
        timedOut: result.timedOut,
        stderr: tail(result.stderr),
      });
    }
    if (!(await isFile(temporaryPath))) {
      throw new VideoValidationError(
        'VIDEO_OUTPUT_MISSING',
        'FFmpeg reported success but did not create an output video.',
        {sourcePath, outputPath},
      );
    }

    const output = await probeVideo(temporaryPath, sharedProbeOptions);
    const outputIsValid =
      output.codecName === 'h264' &&
      output.pixelFormat === 'yuv420p' &&
      output.fps !== null &&
      Math.abs(output.fps - options.targetFps) <= FPS_TOLERANCE &&
      (targetFrameCount === undefined || output.frameCount === targetFrameCount) &&
      !output.hasAudio;
    if (!outputIsValid) {
      throw new VideoValidationError(
        'VIDEO_OUTPUT_INVALID',
        'The normalized output is not H.264/yuv420p, constant target FPS, and silent.',
        {output, targetFps: options.targetFps, targetFrameCount},
      );
    }

    await rename(temporaryPath, outputPath);
    return {
      outputPath,
      source,
      output: {...output, sourcePath: outputPath},
    };
  } catch (error) {
    await rm(temporaryPath, {force: true}).catch(() => undefined);
    throw error;
  }
};

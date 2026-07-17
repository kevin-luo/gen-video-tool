import {randomUUID} from 'node:crypto';
import path from 'node:path';
import type {
  VideoGenerationInput,
  VideoGenerationJob,
  VideoGenerationPreset,
  VideoGenerationProvider,
  VideoProviderDetection,
  VideoProviderErrorCode,
} from './provider';
import {VideoProviderError} from './provider';
import {
  discoverVideoTools,
  normalizeVideo,
  spawnVideoTool,
  VideoValidationError,
  type VideoProcessRunner,
  type VideoToolPathOptions,
} from '../validation/video';

export interface LocalVideoImportProviderOptions extends VideoToolPathOptions {
  outputDirectory?: string;
  targetFps?: number;
  targetDurationSeconds?: number;
  maxFileSizeBytes?: number;
  timeoutMs?: number;
  processRunner?: VideoProcessRunner;
}

const sanitizeStem = (sourcePath: string): string => {
  const stem = path.basename(sourcePath, path.extname(sourcePath))
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_')
    .replace(/[. ]+$/u, '')
    .trim();
  const safeStem = stem.length === 0 ? 'imported-video' : stem;
  return [...safeStem].slice(0, 80).join('');
};

const validationErrorCode = (error: VideoValidationError): VideoProviderErrorCode => {
  switch (error.code) {
    case 'VIDEO_PATH_INVALID':
    case 'VIDEO_PATH_NOT_ABSOLUTE':
    case 'VIDEO_SOURCE_MISSING':
    case 'VIDEO_SOURCE_NOT_FILE':
    case 'VIDEO_OUTPUT_OUTSIDE_ROOT':
    case 'VIDEO_OUTPUT_EXISTS':
      return 'INVALID_PATH';
    case 'VIDEO_SOURCE_TOO_LARGE':
    case 'VIDEO_UNDECODABLE':
    case 'VIDEO_STREAM_MISSING':
    case 'VIDEO_METADATA_INVALID':
      return 'INVALID_REQUEST';
    case 'VIDEO_TOOL_CONFIGURATION_INVALID':
    case 'VIDEO_TOOL_NOT_FOUND':
    case 'VIDEO_PROBE_FAILED':
      return 'SERVICE_UNAVAILABLE';
    case 'VIDEO_TRANSCODE_FAILED':
      return 'JOB_FAILED';
    case 'VIDEO_OUTPUT_MISSING':
      return 'OUTPUT_MISSING';
    case 'VIDEO_OUTPUT_INVALID':
      return 'PROTOCOL_ERROR';
  }
};

/**
 * Imports a user-generated local video and atomically normalizes it for the
 * Remotion timeline. This provider never fabricates a generation job.
 */
export class LocalVideoImportProvider implements VideoGenerationProvider {
  readonly id = 'local-video-import' as const;

  readonly #outputDirectory: string;
  readonly #targetFps: number;
  readonly #targetDurationSeconds?: number;
  readonly #maxFileSizeBytes?: number;
  readonly #timeoutMs?: number;
  readonly #processRunner: VideoProcessRunner;
  readonly #toolOptions: VideoToolPathOptions;

  constructor(options: LocalVideoImportProviderOptions = {}) {
    this.#outputDirectory = path.resolve(
      options.outputDirectory ?? path.join(process.cwd(), 'output', 'local-video-import'),
    );
    this.#targetFps = options.targetFps ?? 24;
    if (options.targetDurationSeconds !== undefined) {
      this.#targetDurationSeconds = options.targetDurationSeconds;
    }
    if (options.maxFileSizeBytes !== undefined) this.#maxFileSizeBytes = options.maxFileSizeBytes;
    if (options.timeoutMs !== undefined) this.#timeoutMs = options.timeoutMs;
    this.#processRunner = options.processRunner ?? spawnVideoTool;
    this.#toolOptions = {
      ...(options.ffmpegPath === undefined ? {} : {ffmpegPath: options.ffmpegPath}),
      ...(options.ffprobePath === undefined ? {} : {ffprobePath: options.ffprobePath}),
    };
  }

  async detect(): Promise<VideoProviderDetection> {
    try {
      const tools = await discoverVideoTools(this.#toolOptions);
      const result = await this.#processRunner({
        command: tools.ffmpegPath,
        args: ['-version'],
        timeoutMs: 10_000,
      });
      if (result.code !== 0 || result.timedOut) {
        return {
          available: false,
          reason: result.timedOut
            ? 'FFmpeg detection timed out.'
            : `FFmpeg detection exited with code ${String(result.code)}.`,
        };
      }
      const version = result.stdout.split(/\r?\n/u)[0]?.trim();
      return {
        available: true,
        ...(version ? {version} : {}),
        endpoint: 'local-file-import',
      };
    } catch (error) {
      return {
        available: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async listPresets(): Promise<VideoGenerationPreset[]> {
    return [];
  }

  async submit(_input: VideoGenerationInput): Promise<VideoGenerationJob> {
    throw new VideoProviderError(
      'INVALID_REQUEST',
      'Local video import does not submit generation jobs. Call importResult() with a real local video.',
      {providerId: this.id},
    );
  }

  async status(_jobId: string): Promise<VideoGenerationJob> {
    throw new VideoProviderError(
      'JOB_NOT_FOUND',
      'Local video imports do not have generation job status.',
      {providerId: this.id},
    );
  }

  async cancel(_jobId: string): Promise<void> {
    throw new VideoProviderError(
      'JOB_NOT_FOUND',
      'Local video imports do not have cancellable generation jobs.',
      {providerId: this.id},
    );
  }

  async importResult(sourcePath: string): Promise<string> {
    const outputPath = path.join(
      this.#outputDirectory,
      `${sanitizeStem(sourcePath)}-${randomUUID()}.mp4`,
    );
    try {
      const result = await normalizeVideo({
        sourcePath,
        outputPath,
        outputRoot: this.#outputDirectory,
        targetFps: this.#targetFps,
        processRunner: this.#processRunner,
        ...this.#toolOptions,
        ...(this.#targetDurationSeconds === undefined
          ? {}
          : {durationSeconds: this.#targetDurationSeconds}),
        ...(this.#maxFileSizeBytes === undefined
          ? {}
          : {maxFileSizeBytes: this.#maxFileSizeBytes}),
        ...(this.#timeoutMs === undefined ? {} : {timeoutMs: this.#timeoutMs}),
      });
      return result.outputPath;
    } catch (error) {
      if (!(error instanceof VideoValidationError)) throw error;
      throw new VideoProviderError(validationErrorCode(error), error.message, {
        validationCode: error.code,
        ...(error.details === undefined ? {} : {details: error.details}),
      });
    }
  }
}

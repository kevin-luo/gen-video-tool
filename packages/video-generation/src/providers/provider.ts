/**
 * Public, backend-neutral video generation contracts.
 *
 * Provider-specific model names, settings and remote job identifiers must not be
 * added to these types.  They are deliberately safe to persist in project data.
 */
export type VideoProviderId = 'wangp' | 'local-video-import';

export type VideoGenerationStatus =
  | 'queued'
  | 'preparing'
  | 'running'
  | 'downloading'
  | 'complete'
  | 'failed'
  | 'cancelled';

export type VideoGenerationInput = {
  projectId: string;
  shotId: string;
  /** Complete, text-free performance plate at frame 0. Causal props may be composited later. */
  keyframePath: string;
  /** Optional complete performance plate for the last frame, when the selected model supports it. */
  endKeyframePath?: string;
  prompt: string;
  negativePrompt?: string;
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  seed?: number;
  steps?: number;
  guidance?: number;
  /** Backend-neutral requested motion intensity: 0 is restrained, 1 is strongest. */
  motionStrength?: number;
  presetId: string;
};

export type VideoGenerationError = {
  code: string;
  message: string;
  details?: unknown;
};

export type VideoGenerationJob = {
  id: string;
  providerId: VideoProviderId;
  status: VideoGenerationStatus;
  progress: number;
  createdAt: string;
  updatedAt: string;
  outputPath?: string;
  previewPath?: string;
  seed?: number;
  error?: VideoGenerationError;
};

export type VideoGenerationPreset = {
  id: string;
  label: string;
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  candidateCount: number;
  qualityTier: 'preview' | 'quality';
  allowUpscale: boolean;
  allowInterpolation: boolean;
};

export type VideoProviderDetection = {
  available: boolean;
  version?: string;
  endpoint?: string;
  reason?: string;
};

export interface VideoGenerationProvider {
  readonly id: VideoProviderId;

  detect(): Promise<VideoProviderDetection>;
  listPresets(): Promise<VideoGenerationPreset[]>;
  submit(input: VideoGenerationInput): Promise<VideoGenerationJob>;
  status(jobId: string): Promise<VideoGenerationJob>;
  cancel(jobId: string): Promise<void>;
  importResult?(sourcePath: string): Promise<string>;
}

/** External-facing lifecycle hooks.  Only the public job shape crosses this API. */
export type VideoGenerationProviderCallbacks = {
  onJobUpdated?: (job: Readonly<VideoGenerationJob>) => void | Promise<void>;
  persistJob?: (job: Readonly<VideoGenerationJob>) => void | Promise<void>;
  log?: (
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    details?: unknown,
  ) => void;
};

export type VideoProviderErrorCode =
  | 'SERVICE_UNAVAILABLE'
  | 'SERVICE_DISCONNECTED'
  | 'PROVIDER_BUSY'
  | 'MODEL_MISSING'
  | 'VRAM_INSUFFICIENT'
  | 'RAM_INSUFFICIENT'
  | 'REQUEST_TIMEOUT'
  | 'INVALID_REQUEST'
  | 'INVALID_PATH'
  | 'JOB_NOT_FOUND'
  | 'JOB_FAILED'
  | 'JOB_CANCELLED'
  | 'OUTPUT_MISSING'
  | 'OUTPUT_COPY_FAILED'
  | 'PROTOCOL_ERROR';

export class VideoProviderError extends Error {
  readonly code: VideoProviderErrorCode;
  readonly details?: unknown;

  constructor(code: VideoProviderErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'VideoProviderError';
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

export function cloneVideoGenerationJob(job: Readonly<VideoGenerationJob>): VideoGenerationJob {
  return {
    ...job,
    ...(job.error === undefined ? {} : { error: { ...job.error } }),
  };
}

export type LocalTtsErrorCode =
  | 'LOCAL_TTS_ABORTED'
  | 'LOCAL_TTS_COMPAT_WRAPPER_NOT_FOUND'
  | 'LOCAL_TTS_F5_CLI_NOT_FOUND'
  | 'LOCAL_TTS_INVALID_REQUEST'
  | 'LOCAL_TTS_LOCAL_PATH_REQUIRED'
  | 'LOCAL_TTS_OUTPUT_EXISTS'
  | 'LOCAL_TTS_OUTPUT_INVALID'
  | 'LOCAL_TTS_OUTPUT_MISSING'
  | 'LOCAL_TTS_PROCESS_FAILED'
  | 'LOCAL_TTS_PYTHON_NOT_FOUND'
  | 'LOCAL_TTS_REFERENCE_AUDIO_NOT_FOUND'
  | 'LOCAL_TTS_REMOTE_PATH_FORBIDDEN'
  | 'LOCAL_TTS_WAV_INCOMPATIBLE';

export class LocalTtsError extends Error {
  public readonly code: LocalTtsErrorCode;
  public readonly details?: Readonly<Record<string, unknown>>;
  public readonly cause?: unknown;

  public constructor(
    code: LocalTtsErrorCode,
    message: string,
    options: {details?: Readonly<Record<string, unknown>>; cause?: unknown} = {},
  ) {
    super(message);
    this.name = 'LocalTtsError';
    this.code = code;
    if (options.details !== undefined) this.details = {...options.details};
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

export type LocalF5TtsInstallationSource = 'explicit' | 'environment' | 'auto-discovery';

export type LocalF5TtsInstallation = {
  readonly cliPath: string;
  readonly pythonPath: string;
  readonly source: LocalF5TtsInstallationSource;
  readonly pythonWasDerived: boolean;
};

export type LocalF5TtsSegment = {
  readonly id: string;
  /** Text is passed byte-for-byte through the UTF-8 generation file. */
  readonly text: string;
};

type LocalF5TtsCommonRequest = {
  readonly referenceAudioPath: string;
  /** Exact transcript for referenceAudioPath. It is never inferred or replaced. */
  readonly referenceText: string;
  readonly outputPath: string;
  readonly overwrite?: boolean;
  readonly signal?: AbortSignal;
};

export type LocalF5TtsRequest = LocalF5TtsCommonRequest & (
  | {readonly text: string; readonly segments?: never}
  | {readonly text?: never; readonly segments: readonly LocalF5TtsSegment[]}
);

export type LocalF5TtsSegmentResult = {
  readonly id: string;
  readonly text: string;
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly durationSeconds: number;
};

export type SerializableWavInfo = {
  readonly path: string;
  readonly byteLength: number;
  readonly durationSeconds: number;
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  readonly bitsPerSample?: number;
  readonly bitrate?: number;
  readonly codec?: string;
  readonly container?: string;
};

export type LocalF5TtsResult = {
  readonly outputPath: string;
  readonly wav: SerializableWavInfo;
  readonly segments: readonly LocalF5TtsSegmentResult[];
  readonly engine: {
    readonly kind: 'f5-tts-local';
    readonly cliPath: string;
    readonly pythonPath: string;
    readonly invocationMode: 'direct-cli' | 'compat-wrapper';
    readonly model: string;
    readonly device: string;
  };
};

export type LocalProcessRequest = {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
};

export type LocalProcessResult = {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
};

/** Injectable boundary: tests never need a model, GPU, or real executable. */
export interface LocalProcessAdapter {
  run(request: LocalProcessRequest): Promise<LocalProcessResult>;
}

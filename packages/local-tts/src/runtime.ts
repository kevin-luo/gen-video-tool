import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {discoverLocalF5Tts, resolveBundledF5CompatWrapperPath, type LocalF5TtsDiscoveryOptions} from './discovery';
import {assertAbsoluteLocalPath, assertNonEmptyExactText} from './local-path';
import {NodeLocalProcessAdapter} from './process-adapter';
import {
  LocalTtsError,
  type LocalF5TtsInstallation,
  type LocalF5TtsRequest,
  type LocalF5TtsResult,
  type LocalF5TtsSegment,
  type LocalF5TtsSegmentResult,
  type LocalProcessAdapter,
} from './types';
import {concatenatePcmWavFiles, probeWav} from './wav';

export type LocalF5TtsRuntimeOptions = {
  readonly installation: LocalF5TtsInstallation;
  readonly processAdapter?: LocalProcessAdapter;
  readonly compatibility?: {
    readonly mode: 'direct-cli' | 'compat-wrapper';
    readonly wrapperPath?: string;
  };
  readonly model?: string;
  readonly device?: string;
  readonly nfeSteps?: number;
  readonly speed?: number;
  readonly timeoutMs?: number;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
};

export type CreateLocalF5TtsRuntimeOptions = Omit<LocalF5TtsRuntimeOptions, 'installation'> & {
  readonly discovery?: LocalF5TtsDiscoveryOptions;
};

type NormalizedRequest = {
  readonly referenceAudioPath: string;
  readonly referenceText: string;
  readonly outputPath: string;
  readonly overwrite: boolean;
  readonly segments: readonly LocalF5TtsSegment[];
  readonly signal?: AbortSignal;
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

const throwIfAborted = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted === true) {
    throw new LocalTtsError('LOCAL_TTS_ABORTED', 'Local F5-TTS generation was cancelled');
  }
};

const roundSeconds = (value: number): number => Number(value.toFixed(6));

function normalizeRequest(request: LocalF5TtsRequest): NormalizedRequest {
  const referenceAudioPath = assertAbsoluteLocalPath(request.referenceAudioPath, 'referenceAudioPath');
  const outputPath = assertAbsoluteLocalPath(request.outputPath, 'outputPath');
  if (path.extname(outputPath).toLowerCase() !== '.wav') {
    throw new LocalTtsError('LOCAL_TTS_INVALID_REQUEST', 'outputPath must end with .wav');
  }
  const referenceText = assertNonEmptyExactText(request.referenceText, 'referenceText');
  const segments: readonly LocalF5TtsSegment[] = request.text !== undefined
    ? [{id: 'narration', text: assertNonEmptyExactText(request.text, 'text')}]
    : request.segments.map((segment, index) => ({
        id: assertNonEmptyExactText(segment.id, `segments[${index}].id`),
        text: assertNonEmptyExactText(segment.text, `segments[${index}].text`),
      }));
  if (segments.length === 0) {
    throw new LocalTtsError('LOCAL_TTS_INVALID_REQUEST', 'segments must contain at least one item');
  }
  if (new Set(segments.map((segment) => segment.id)).size !== segments.length) {
    throw new LocalTtsError('LOCAL_TTS_INVALID_REQUEST', 'segment ids must be unique');
  }
  return {
    referenceAudioPath,
    referenceText,
    outputPath,
    overwrite: request.overwrite ?? false,
    segments,
    ...(request.signal === undefined ? {} : {signal: request.signal}),
  };
}

async function atomicInstall(stagedPath: string, outputPath: string, overwrite: boolean): Promise<void> {
  const outputExists = await exists(outputPath);
  if (outputExists && !overwrite) {
    throw new LocalTtsError('LOCAL_TTS_OUTPUT_EXISTS', `Refusing to overwrite existing narration: ${outputPath}`);
  }
  if (!outputExists) {
    await fs.rename(stagedPath, outputPath);
    return;
  }

  const backupPath = path.join(path.dirname(outputPath), `.${path.basename(outputPath)}.${randomUUID()}.bak`);
  await fs.rename(outputPath, backupPath);
  try {
    await fs.rename(stagedPath, outputPath);
    await fs.rm(backupPath, {force: true});
  } catch (cause) {
    if (!(await exists(outputPath)) && await exists(backupPath)) await fs.rename(backupPath, outputPath);
    throw cause;
  } finally {
    await fs.rm(backupPath, {force: true});
  }
}

export class LocalF5TtsRuntime {
  readonly #installation: LocalF5TtsInstallation;
  readonly #processAdapter: LocalProcessAdapter;
  readonly #invocationMode: 'direct-cli' | 'compat-wrapper';
  readonly #wrapperPath: string | undefined;
  readonly #model: string;
  readonly #device: string;
  readonly #nfeSteps: number;
  readonly #speed: number;
  readonly #timeoutMs: number;
  readonly #environment: Readonly<NodeJS.ProcessEnv> | undefined;

  public constructor(options: LocalF5TtsRuntimeOptions) {
    this.#installation = {
      ...options.installation,
      cliPath: assertAbsoluteLocalPath(options.installation.cliPath, 'installation.cliPath'),
      pythonPath: assertAbsoluteLocalPath(options.installation.pythonPath, 'installation.pythonPath'),
    };
    this.#processAdapter = options.processAdapter ?? new NodeLocalProcessAdapter();
    this.#invocationMode = options.compatibility?.mode ?? 'direct-cli';
    this.#wrapperPath = this.#invocationMode === 'compat-wrapper'
      ? assertAbsoluteLocalPath(options.compatibility?.wrapperPath ?? resolveBundledF5CompatWrapperPath(), 'compatibility.wrapperPath')
      : undefined;
    this.#model = assertNonEmptyExactText(options.model ?? 'F5TTS_v1_Base', 'model');
    this.#device = assertNonEmptyExactText(options.device ?? 'cuda', 'device');
    this.#nfeSteps = options.nfeSteps ?? 32;
    this.#speed = options.speed ?? 1;
    this.#timeoutMs = options.timeoutMs ?? 15 * 60_000;
    this.#environment = options.environment;
    if (!Number.isInteger(this.#nfeSteps) || this.#nfeSteps < 1 || this.#nfeSteps > 256) {
      throw new LocalTtsError('LOCAL_TTS_INVALID_REQUEST', 'nfeSteps must be an integer from 1 to 256');
    }
    if (!Number.isFinite(this.#speed) || this.#speed < 0.25 || this.#speed > 4) {
      throw new LocalTtsError('LOCAL_TTS_INVALID_REQUEST', 'speed must be between 0.25 and 4');
    }
    if (!Number.isFinite(this.#timeoutMs) || this.#timeoutMs < 1_000) {
      throw new LocalTtsError('LOCAL_TTS_INVALID_REQUEST', 'timeoutMs must be at least 1000');
    }
  }

  public async synthesize(request: LocalF5TtsRequest): Promise<LocalF5TtsResult> {
    const normalized = normalizeRequest(request);
    throwIfAborted(normalized.signal);
    if (!(await exists(normalized.referenceAudioPath))) {
      throw new LocalTtsError(
        'LOCAL_TTS_REFERENCE_AUDIO_NOT_FOUND',
        `Reference voice does not exist: ${normalized.referenceAudioPath}`,
      );
    }
    if (!(await exists(this.#installation.cliPath))) {
      throw new LocalTtsError(
        'LOCAL_TTS_F5_CLI_NOT_FOUND',
        `F5-TTS CLI does not exist: ${this.#installation.cliPath}`,
      );
    }
    if (!(await exists(this.#installation.pythonPath))) {
      throw new LocalTtsError(
        'LOCAL_TTS_PYTHON_NOT_FOUND',
        `F5-TTS Python does not exist: ${this.#installation.pythonPath}`,
      );
    }
    if (this.#invocationMode === 'compat-wrapper' && (this.#wrapperPath === undefined || !(await exists(this.#wrapperPath)))) {
      throw new LocalTtsError(
        'LOCAL_TTS_COMPAT_WRAPPER_NOT_FOUND',
        `F5-TTS compatibility wrapper does not exist: ${String(this.#wrapperPath)}`,
      );
    }
    await fs.mkdir(path.dirname(normalized.outputPath), {recursive: true});
    if (!normalized.overwrite && await exists(normalized.outputPath)) {
      throw new LocalTtsError('LOCAL_TTS_OUTPUT_EXISTS', `Refusing to overwrite existing narration: ${normalized.outputPath}`);
    }

    const stageDirectory = await fs.mkdtemp(path.join(path.dirname(normalized.outputPath), '.f5tts-'));
    try {
      const wavPaths: string[] = [];
      for (const [index, segment] of normalized.segments.entries()) {
        throwIfAborted(normalized.signal);
        const textPath = path.join(stageDirectory, `segment-${String(index).padStart(3, '0')}.txt`);
        const wavPath = path.join(stageDirectory, `segment-${String(index).padStart(3, '0')}.wav`);
        await fs.writeFile(textPath, segment.text, {encoding: 'utf8', flag: 'wx'});
        await this.#generateOne({
          textPath,
          wavPath,
          referenceAudioPath: normalized.referenceAudioPath,
          referenceText: normalized.referenceText,
          ...(normalized.signal === undefined ? {} : {signal: normalized.signal}),
        });
        if (!(await exists(wavPath))) {
          throw new LocalTtsError(
            'LOCAL_TTS_OUTPUT_MISSING',
            `F5-TTS completed without writing the requested WAV: ${wavPath}`,
          );
        }
        await probeWav(wavPath);
        wavPaths.push(wavPath);
      }

      const stagedOutput = path.join(stageDirectory, 'narration-final.wav');
      const joined = await concatenatePcmWavFiles(wavPaths, stagedOutput);
      const stagedProbe = await probeWav(stagedOutput);
      throwIfAborted(normalized.signal);
      await atomicInstall(stagedOutput, normalized.outputPath, normalized.overwrite);
      const finalProbe = {...stagedProbe, path: normalized.outputPath};
      const segmentResults: LocalF5TtsSegmentResult[] = [];
      let cursor = 0;
      for (const [index, segment] of normalized.segments.entries()) {
        const durationSeconds = roundSeconds(joined.segmentDurations[index]!);
        const startSeconds = roundSeconds(cursor);
        const endSeconds = roundSeconds(startSeconds + durationSeconds);
        segmentResults.push({
          id: segment.id,
          text: segment.text,
          startSeconds,
          endSeconds,
          durationSeconds,
        });
        cursor = endSeconds;
      }
      return {
        outputPath: normalized.outputPath,
        wav: finalProbe,
        segments: segmentResults,
        engine: {
          kind: 'f5-tts-local',
          cliPath: this.#installation.cliPath,
          pythonPath: this.#installation.pythonPath,
          invocationMode: this.#invocationMode,
          model: this.#model,
          device: this.#device,
        },
      };
    } finally {
      await fs.rm(stageDirectory, {recursive: true, force: true});
    }
  }

  async #generateOne(input: {
    readonly textPath: string;
    readonly wavPath: string;
    readonly referenceAudioPath: string;
    readonly referenceText: string;
    readonly signal?: AbortSignal;
  }): Promise<void> {
    const cliArguments = [
      '--model', this.#model,
      '--ref_audio', input.referenceAudioPath,
      '--ref_text', input.referenceText,
      '--gen_file', input.textPath,
      '--output_dir', path.dirname(input.wavPath),
      '--output_file', path.basename(input.wavPath),
      '--nfe_step', String(this.#nfeSteps),
      '--speed', String(this.#speed),
      '--device', this.#device,
    ];
    const command = this.#invocationMode === 'compat-wrapper'
      ? this.#installation.pythonPath
      : this.#installation.cliPath;
    const args = this.#invocationMode === 'compat-wrapper'
      ? [this.#wrapperPath!, ...cliArguments]
      : cliArguments;
    let processResult;
    try {
      processResult = await this.#processAdapter.run({
        command,
        args,
        cwd: path.dirname(input.wavPath),
        timeoutMs: this.#timeoutMs,
        ...(this.#environment === undefined ? {} : {environment: this.#environment}),
        ...(input.signal === undefined ? {} : {signal: input.signal}),
      });
    } catch (cause) {
      if (cause instanceof LocalTtsError) throw cause;
      throw new LocalTtsError('LOCAL_TTS_PROCESS_FAILED', 'Local F5-TTS process failed', {cause});
    }
    if (processResult.exitCode !== 0) {
      throw new LocalTtsError(
        'LOCAL_TTS_PROCESS_FAILED',
        `Local F5-TTS exited with code ${String(processResult.exitCode)}`,
        {
          details: {
            exitCode: processResult.exitCode,
            signal: processResult.signal,
            stdout: processResult.stdout,
            stderr: processResult.stderr,
          },
        },
      );
    }
  }
}

export async function createLocalF5TtsRuntime(
  options: CreateLocalF5TtsRuntimeOptions = {},
): Promise<LocalF5TtsRuntime> {
  const installation = await discoverLocalF5Tts(options.discovery);
  return new LocalF5TtsRuntime({
    installation,
    ...(options.processAdapter === undefined ? {} : {processAdapter: options.processAdapter}),
    ...(options.compatibility === undefined ? {} : {compatibility: options.compatibility}),
    ...(options.model === undefined ? {} : {model: options.model}),
    ...(options.device === undefined ? {} : {device: options.device}),
    ...(options.nfeSteps === undefined ? {} : {nfeSteps: options.nfeSteps}),
    ...(options.speed === undefined ? {} : {speed: options.speed}),
    ...(options.timeoutMs === undefined ? {} : {timeoutMs: options.timeoutMs}),
    ...(options.environment === undefined ? {} : {environment: options.environment}),
  });
}

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';

import {
  LocalF5TtsRuntime,
  LocalTtsError,
  discoverLocalF5Tts,
  padPcmWavFileToDuration,
  probeWav,
  type LocalF5TtsInstallation,
  type LocalProcessAdapter,
  type LocalProcessRequest,
  type LocalProcessResult,
} from '../src/index';

const roots: string[] = [];

const temporaryRoot = async (): Promise<string> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-f5-tts-'));
  roots.push(root);
  return root;
};

const writePcm16Wav = async (
  filePath: string,
  durationSeconds: number,
  sampleRate = 8_000,
): Promise<void> => {
  const frameCount = Math.max(1, Math.round(durationSeconds * sampleRate));
  const dataSize = frameCount * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0, 4, 'ascii');
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write('WAVE', 8, 4, 'ascii');
  buffer.write('fmt ', 12, 4, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 4, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);
  for (let offset = 44; offset < buffer.length; offset += 2) buffer.writeInt16LE(120, offset);
  await fs.mkdir(path.dirname(filePath), {recursive: true});
  await fs.writeFile(filePath, buffer);
};

const argumentValue = (request: LocalProcessRequest, flag: string): string => {
  const index = request.args.indexOf(flag);
  const value = request.args[index + 1];
  if (index < 0 || value === undefined) throw new Error(`Missing fake CLI argument: ${flag}`);
  return value;
};

class FakeF5Process implements LocalProcessAdapter {
  public readonly calls: LocalProcessRequest[] = [];
  public readonly generatedTexts: string[] = [];
  public fail: Error | undefined;
  public writeWrongFile = false;

  public async run(request: LocalProcessRequest): Promise<LocalProcessResult> {
    this.calls.push(request);
    if (this.fail !== undefined) throw this.fail;
    this.generatedTexts.push(await fs.readFile(argumentValue(request, '--gen_file'), 'utf8'));
    const outputDirectory = argumentValue(request, '--output_dir');
    const outputFile = argumentValue(request, '--output_file');
    const requestedPath = path.join(outputDirectory, outputFile);
    const outputPath = this.writeWrongFile ? path.join(outputDirectory, `wrong-${outputFile}`) : requestedPath;
    await writePcm16Wav(outputPath, 0.1 * this.calls.length);
    return {exitCode: 0, signal: null, stdout: outputPath, stderr: ''};
  }
}

const fixture = async (): Promise<{
  root: string;
  installation: LocalF5TtsInstallation;
  referenceAudioPath: string;
  wrapperPath: string;
}> => {
  const root = await temporaryRoot();
  const cliPath = path.join(root, 'f5 env', 'Scripts', 'f5-tts_infer-cli.exe');
  const pythonPath = path.join(root, 'f5 env', 'python.exe');
  const referenceAudioPath = path.join(root, 'voice', 'reference.wav');
  const wrapperPath = path.join(root, 'compat', 'f5_tts_cli_compat.py');
  await Promise.all([
    fs.mkdir(path.dirname(cliPath), {recursive: true}),
    fs.mkdir(path.dirname(referenceAudioPath), {recursive: true}),
    fs.mkdir(path.dirname(wrapperPath), {recursive: true}),
  ]);
  await Promise.all([
    fs.writeFile(cliPath, 'fake-cli'),
    fs.writeFile(pythonPath, 'fake-python'),
    writePcm16Wav(referenceAudioPath, 0.25),
    fs.writeFile(wrapperPath, '# fake wrapper'),
  ]);
  return {
    root,
    installation: {cliPath, pythonPath, source: 'explicit', pythonWasDerived: false},
    referenceAudioPath,
    wrapperPath,
  };
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, {recursive: true, force: true})));
});

describe('local F5-TTS runtime', () => {
  it('generates exact-text segments, concatenates WAV locally, and returns serializable timing', async () => {
    const {root, installation, referenceAudioPath} = await fixture();
    const processAdapter = new FakeF5Process();
    const runtime = new LocalF5TtsRuntime({installation, processAdapter, device: 'cpu'});
    const referenceText = '原样保留：空格  和标点！';
    const outputPath = path.join(root, 'generated', 'narration.wav');

    const result = await runtime.synthesize({
      referenceAudioPath,
      referenceText,
      segments: [
        {id: 'opening', text: '第一句，先别急。'},
        {id: 'turn', text: '第二句：答案反过来。'},
      ],
      outputPath,
    });

    expect(processAdapter.calls).toHaveLength(2);
    expect(processAdapter.calls[0]).toMatchObject({command: installation.cliPath});
    expect(argumentValue(processAdapter.calls[0]!, '--ref_text')).toBe(referenceText);
    expect(processAdapter.generatedTexts[0]).toBe('第一句，先别急。');
    expect(result).toMatchObject({
      outputPath,
      wav: {path: outputPath, sampleRate: 8_000, numberOfChannels: 1},
      engine: {kind: 'f5-tts-local', invocationMode: 'direct-cli', device: 'cpu'},
      segments: [
        {id: 'opening', startSeconds: 0, durationSeconds: 0.1, endSeconds: 0.1},
        {id: 'turn', startSeconds: 0.1, durationSeconds: 0.2, endSeconds: 0.3},
      ],
    });
    expect(result.wav.durationSeconds).toBeCloseTo(0.3, 5);
    expect(() => JSON.stringify(result)).not.toThrow();
    expect((await fs.readdir(path.dirname(outputPath))).filter((name) => name.startsWith('.f5tts-'))).toEqual([]);
  });

  it('uses the selected compatibility wrapper explicitly, never as a hidden retry', async () => {
    const {root, installation, referenceAudioPath, wrapperPath} = await fixture();
    const processAdapter = new FakeF5Process();
    const runtime = new LocalF5TtsRuntime({
      installation,
      processAdapter,
      compatibility: {mode: 'compat-wrapper', wrapperPath},
    });

    const result = await runtime.synthesize({
      referenceAudioPath,
      referenceText: '参考文本。',
      text: '生成文本。',
      outputPath: path.join(root, 'narration.wav'),
    });

    expect(processAdapter.calls).toHaveLength(1);
    expect(processAdapter.calls[0]?.command).toBe(installation.pythonPath);
    expect(processAdapter.calls[0]?.args[0]).toBe(wrapperPath);
    expect(result.engine.invocationMode).toBe('compat-wrapper');
  });

  it('pads short narration with PCM silence without stretching the speech', async () => {
    const root = await temporaryRoot();
    const inputPath = path.join(root, 'speech.wav');
    const outputPath = path.join(root, 'padded.wav');
    await writePcm16Wav(inputPath, 0.25);

    const padded = await padPcmWavFileToDuration(inputPath, outputPath, 1);
    const probe = await probeWav(outputPath);

    expect(padded.speechDurationSeconds).toBeCloseTo(0.25, 5);
    expect(padded.tailPaddingSeconds).toBeCloseTo(0.75, 5);
    expect(padded.durationSeconds).toBeCloseTo(1, 5);
    expect(probe.durationSeconds).toBeCloseTo(1, 5);
  });

  it.each([
    {field: 'referenceAudioPath', value: 'https://voice.example/reference.wav'},
    {field: 'outputPath', value: '\\\\media-server\\exports\\narration.wav'},
  ])('rejects remote $field before starting a process', async ({field, value}) => {
    const {root, installation, referenceAudioPath} = await fixture();
    const processAdapter = new FakeF5Process();
    const runtime = new LocalF5TtsRuntime({installation, processAdapter});
    const request = {
      referenceAudioPath,
      referenceText: '精确参考文本。',
      text: '本地生成文本。',
      outputPath: path.join(root, 'narration.wav'),
      [field]: value,
    };

    await expect(runtime.synthesize(request)).rejects.toMatchObject({
      code: 'LOCAL_TTS_REMOTE_PATH_FORBIDDEN',
    });
    expect(processAdapter.calls).toHaveLength(0);
  });

  it('does not fall through to defaults when an environment path is configured but missing', async () => {
    const missingCli = 'C:\\configured\\missing\\f5-tts_infer-cli.exe';
    await expect(discoverLocalF5Tts({
      platform: 'win32',
      environment: {F5_TTS_CLI: missingCli},
      fileExists: async () => false,
    })).rejects.toMatchObject({
      code: 'LOCAL_TTS_F5_CLI_NOT_FOUND',
      details: {cliPath: missingCli, source: 'environment'},
    });
  });

  it('auto-discovers a named F5-TTS Conda environment without a machine-specific drive', async () => {
    const condaRoot = 'D:\\portable-conda';
    const pythonPath = 'D:\\portable-conda\\envs\\voice-runtime\\python.exe';
    const cliPath = 'D:\\portable-conda\\envs\\voice-runtime\\Scripts\\f5-tts_infer-cli.exe';
    const installation = await discoverLocalF5Tts({
      platform: 'win32',
      environment: {
        CONDA_PREFIX: condaRoot,
        F5_TTS_ENV_NAME: 'voice-runtime',
      },
      fileExists: async (filePath) => filePath === cliPath || filePath === pythonPath,
    });

    expect(installation).toEqual({
      cliPath,
      pythonPath,
      source: 'auto-discovery',
      pythonWasDerived: true,
    });
  });

  it('discovers the configured CLI and deterministically derives its environment Python', async () => {
    const cliPath = 'D:\\voices\\f5\\Scripts\\f5-tts_infer-cli.exe';
    const pythonPath = 'D:\\voices\\f5\\python.exe';
    const installation = await discoverLocalF5Tts({
      platform: 'win32',
      environment: {F5_TTS_CLI: cliPath},
      fileExists: async (filePath) => filePath === cliPath || filePath === pythonPath,
    });

    expect(installation).toEqual({
      cliPath,
      pythonPath,
      source: 'environment',
      pythonWasDerived: true,
    });
  });

  it('derives the paired CLI when only the environment Python is configured', async () => {
    const pythonPath = 'D:\\voices\\f5\\python.exe';
    const cliPath = 'D:\\voices\\f5\\Scripts\\f5-tts_infer-cli.exe';
    const installation = await discoverLocalF5Tts({
      platform: 'win32',
      environment: {F5_TTS_PYTHON: pythonPath},
      fileExists: async (filePath) => filePath === cliPath || filePath === pythonPath,
    });

    expect(installation).toEqual({
      cliPath,
      pythonPath,
      source: 'environment',
      pythonWasDerived: false,
    });
  });

  it('rejects a remote executable even when installation is injected directly', async () => {
    const {installation} = await fixture();
    expect(() => new LocalF5TtsRuntime({
      installation: {...installation, cliPath: 'https://example.invalid/f5.exe'},
      processAdapter: new FakeF5Process(),
    })).toThrow(expect.objectContaining({code: 'LOCAL_TTS_REMOTE_PATH_FORBIDDEN'}));
  });

  it('preserves an existing output and removes staging files when generation fails', async () => {
    const {root, installation, referenceAudioPath} = await fixture();
    const outputPath = path.join(root, 'generated', 'narration.wav');
    await writePcm16Wav(outputPath, 0.4);
    const original = await fs.readFile(outputPath);
    const processAdapter = new FakeF5Process();
    processAdapter.fail = new Error('synthetic process failure');
    const runtime = new LocalF5TtsRuntime({installation, processAdapter});

    await expect(runtime.synthesize({
      referenceAudioPath,
      referenceText: '参考文本。',
      text: '生成文本。',
      outputPath,
      overwrite: true,
    })).rejects.toMatchObject({code: 'LOCAL_TTS_PROCESS_FAILED'});

    expect(await fs.readFile(outputPath)).toEqual(original);
    expect((await fs.readdir(path.dirname(outputPath))).filter((name) => name.startsWith('.f5tts-'))).toEqual([]);
  });

  it('rejects a differently named WAV instead of silently substituting it', async () => {
    const {root, installation, referenceAudioPath} = await fixture();
    const processAdapter = new FakeF5Process();
    processAdapter.writeWrongFile = true;
    const runtime = new LocalF5TtsRuntime({installation, processAdapter});

    await expect(runtime.synthesize({
      referenceAudioPath,
      referenceText: '参考文本。',
      text: '生成文本。',
      outputPath: path.join(root, 'narration.wav'),
    })).rejects.toMatchObject({code: 'LOCAL_TTS_OUTPUT_MISSING'});
  });

  it('honors a pre-aborted signal without starting the model process', async () => {
    const {root, installation, referenceAudioPath} = await fixture();
    const processAdapter = new FakeF5Process();
    const runtime = new LocalF5TtsRuntime({installation, processAdapter});
    const controller = new AbortController();
    controller.abort();

    await expect(runtime.synthesize({
      referenceAudioPath,
      referenceText: '参考文本。',
      text: '生成文本。',
      outputPath: path.join(root, 'narration.wav'),
      signal: controller.signal,
    })).rejects.toMatchObject({code: 'LOCAL_TTS_ABORTED'});
    expect(processAdapter.calls).toHaveLength(0);
  });
});

describe('LocalTtsError', () => {
  it('keeps code and details serializable without requiring its cause', () => {
    const error = new LocalTtsError('LOCAL_TTS_INVALID_REQUEST', 'bad request', {details: {field: 'text'}});
    expect({code: error.code, message: error.message, details: error.details}).toEqual({
      code: 'LOCAL_TTS_INVALID_REQUEST',
      message: 'bad request',
      details: {field: 'text'},
    });
  });
});

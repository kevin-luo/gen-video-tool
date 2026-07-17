import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {afterEach, beforeAll, describe, expect, it} from 'vitest';
import {LocalVideoImportProvider} from '../../../packages/video-generation/src/providers/external-import-provider';
import {
  discoverVideoTools,
  normalizeVideo,
  probeVideo,
  spawnVideoTool,
  type VideoProcessRunner,
  type VideoToolPaths,
} from '../../../packages/video-generation/src/validation/video';

const created: string[] = [];
let tools: VideoToolPaths;

const temporaryDirectory = async (): Promise<string> => {
  const result = await mkdtemp(path.join(tmpdir(), 'gen-video-tool-video-'));
  created.push(result);
  return result;
};

const createSilentWav = (durationSeconds: number, sampleRate = 8_000): Buffer => {
  const sampleCount = Math.max(1, Math.floor(durationSeconds * sampleRate));
  const dataBytes = sampleCount * 2;
  const output = Buffer.alloc(44 + dataBytes);
  output.write('RIFF', 0, 'ascii');
  output.writeUInt32LE(36 + dataBytes, 4);
  output.write('WAVEfmt ', 8, 'ascii');
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22);
  output.writeUInt32LE(sampleRate, 24);
  output.writeUInt32LE(sampleRate * 2, 28);
  output.writeUInt16LE(2, 32);
  output.writeUInt16LE(16, 34);
  output.write('data', 36, 'ascii');
  output.writeUInt32LE(dataBytes, 40);
  return output;
};

const makeDecodableVideo = async (root: string, fileName: string): Promise<string> => {
  const framePath = path.join(root, '首帧 图片.png');
  const audioPath = path.join(root, '输入 音频.wav');
  const sourcePath = path.join(root, fileName);
  await sharp({
    create: {width: 32, height: 32, channels: 3, background: {r: 31, g: 73, b: 125}},
  }).png().toFile(framePath);
  await writeFile(audioPath, createSilentWav(0.6));

  const result = await spawnVideoTool({
    command: tools.ffmpegPath,
    args: [
      '-hide_banner',
      '-nostdin',
      '-y',
      '-loop', '1',
      '-framerate', '12',
      '-i', framePath,
      '-i', audioPath,
      '-t', '0.5',
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv444p',
      '-c:a', 'aac',
      '-shortest',
      sourcePath,
    ],
    timeoutMs: 30_000,
  });
  if (result.code !== 0) {
    throw new Error(`Unable to create video fixture: ${result.stderr}`);
  }
  return sourcePath;
};

beforeAll(async () => {
  tools = await discoverVideoTools();
});

afterEach(async () => {
  await Promise.all(created.splice(0).map((entry) => rm(entry, {recursive: true, force: true})));
});

describe('local video import', () => {
  it('normalizes a real video from a Chinese, spaced, shell-metacharacter path', async () => {
    const root = await temporaryDirectory();
    const inputDirectory = path.join(root, '中文 输入');
    const outputDirectory = path.join(root, '规范化 输出');
    await mkdir(inputDirectory, {recursive: true});
    const sourcePath = await makeDecodableVideo(inputDirectory, '来源 & 视频.mp4');
    const source = await probeVideo(sourcePath, {tools});
    expect(source.hasAudio).toBe(true);
    expect(source.pixelFormat).toBe('yuv444p');

    const provider = new LocalVideoImportProvider({
      outputDirectory,
      targetFps: 24,
      ffmpegPath: tools.ffmpegPath,
      ffprobePath: tools.ffprobePath,
    });
    await expect(provider.detect()).resolves.toMatchObject({available: true});
    const outputPath = await provider.importResult(sourcePath);

    expect(path.dirname(outputPath)).toBe(path.resolve(outputDirectory));
    const output = await probeVideo(outputPath, {tools});
    expect(output).toMatchObject({
      codecName: 'h264',
      pixelFormat: 'yuv420p',
      hasAudio: false,
    });
    expect(output.fps).toBeCloseTo(24, 4);
  });

  it('rejects missing and undecodable input with stable provider errors', async () => {
    const root = await temporaryDirectory();
    const provider = new LocalVideoImportProvider({
      outputDirectory: path.join(root, 'output'),
      ffmpegPath: tools.ffmpegPath,
      ffprobePath: tools.ffprobePath,
    });

    const missing = provider.importResult(path.join(root, '不存在 视频.mp4'));
    await expect(missing).rejects.toMatchObject({
      code: 'INVALID_PATH',
      details: {validationCode: 'VIDEO_SOURCE_MISSING'},
    });

    const corruptPath = path.join(root, '损坏 视频.mp4');
    await writeFile(corruptPath, 'not a video');
    const corrupt = provider.importResult(corruptPath);
    await expect(corrupt).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      details: {validationCode: 'VIDEO_UNDECODABLE'},
    });
  });

  it('rejects a successful process response when the output file is missing', async () => {
    const root = await temporaryDirectory();
    const sourcePath = await makeDecodableVideo(root, 'valid.mp4');
    const noOutputRunner: VideoProcessRunner = async (request) => {
      if (path.resolve(request.command) === path.resolve(tools.ffmpegPath)) {
        return {code: 0, signal: null, stdout: '', stderr: '', timedOut: false};
      }
      return await spawnVideoTool(request);
    };
    const provider = new LocalVideoImportProvider({
      outputDirectory: path.join(root, 'output'),
      ffmpegPath: tools.ffmpegPath,
      ffprobePath: tools.ffprobePath,
      processRunner: noOutputRunner,
    });

    await expect(provider.importResult(sourcePath)).rejects.toMatchObject({
      code: 'OUTPUT_MISSING',
      details: {validationCode: 'VIDEO_OUTPUT_MISSING'},
    });
  });

  it('rejects output traversal before launching FFmpeg', async () => {
    const root = await temporaryDirectory();
    const sourcePath = await makeDecodableVideo(root, 'valid.mp4');
    const outputRoot = path.join(root, 'allowed');
    await expect(normalizeVideo({
      sourcePath,
      outputPath: path.join(root, 'outside.mp4'),
      outputRoot,
      targetFps: 24,
      tools,
    })).rejects.toMatchObject({
      code: 'VIDEO_OUTPUT_OUTSIDE_ROOT',
    });
  });
});

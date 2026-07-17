import fs from 'node:fs/promises';
import {parseFile} from 'music-metadata';

import {assertAbsoluteLocalPath} from './local-path';
import {LocalTtsError, type SerializableWavInfo} from './types';

type ParsedPcmWav = {
  readonly formatChunk: Buffer;
  readonly data: Buffer;
  readonly audioFormat: number;
  readonly sampleRate: number;
  readonly byteRate: number;
  readonly blockAlign: number;
  readonly bitsPerSample: number;
  readonly numberOfChannels: number;
  readonly durationSeconds: number;
};

function parsePcmWavBuffer(buffer: Buffer, filePath: string): ParsedPcmWav {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new LocalTtsError('LOCAL_TTS_OUTPUT_INVALID', `Not a RIFF/WAVE file: ${filePath}`);
  }
  let offset = 12;
  let formatChunk: Buffer | undefined;
  const dataChunks: Buffer[] = [];
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > buffer.length) {
      throw new LocalTtsError('LOCAL_TTS_OUTPUT_INVALID', `Truncated WAV chunk in ${filePath}`);
    }
    if (id === 'fmt ' && formatChunk === undefined) formatChunk = buffer.subarray(start, end);
    if (id === 'data') dataChunks.push(buffer.subarray(start, end));
    offset = end + (size % 2);
  }
  if (formatChunk === undefined || formatChunk.length < 16 || dataChunks.length === 0) {
    throw new LocalTtsError('LOCAL_TTS_OUTPUT_INVALID', `WAV is missing fmt or data chunks: ${filePath}`);
  }
  const audioFormat = formatChunk.readUInt16LE(0);
  const numberOfChannels = formatChunk.readUInt16LE(2);
  const sampleRate = formatChunk.readUInt32LE(4);
  const byteRate = formatChunk.readUInt32LE(8);
  const blockAlign = formatChunk.readUInt16LE(12);
  const bitsPerSample = formatChunk.readUInt16LE(14);
  const data = Buffer.concat(dataChunks);
  if (numberOfChannels < 1 || sampleRate < 1 || byteRate < 1 || blockAlign < 1 || data.length === 0 || data.length % blockAlign !== 0) {
    throw new LocalTtsError('LOCAL_TTS_OUTPUT_INVALID', `WAV has invalid PCM geometry: ${filePath}`);
  }
  return {
    formatChunk,
    data,
    audioFormat,
    sampleRate,
    byteRate,
    blockAlign,
    bitsPerSample,
    numberOfChannels,
    durationSeconds: data.length / byteRate,
  };
}

function makeChunk(id: string, payload: Buffer): Buffer {
  const padding = payload.length % 2;
  const result = Buffer.alloc(8 + payload.length + padding);
  result.write(id, 0, 4, 'ascii');
  result.writeUInt32LE(payload.length, 4);
  payload.copy(result, 8);
  return result;
}

export type ConcatenatedWav = {
  readonly durationSeconds: number;
  readonly segmentDurations: readonly number[];
};

export type PaddedWav = {
  readonly speechDurationSeconds: number;
  readonly durationSeconds: number;
  readonly tailPaddingSeconds: number;
};

export async function concatenatePcmWavFiles(
  inputPaths: readonly string[],
  outputPath: string,
): Promise<ConcatenatedWav> {
  if (inputPaths.length === 0) {
    throw new LocalTtsError('LOCAL_TTS_INVALID_REQUEST', 'At least one WAV is required for concatenation');
  }
  const localInputs = inputPaths.map((inputPath, index) =>
    assertAbsoluteLocalPath(inputPath, `inputPaths[${index}]`));
  const localOutput = assertAbsoluteLocalPath(outputPath, 'outputPath');
  const parsed = await Promise.all(localInputs.map(async (inputPath) =>
    parsePcmWavBuffer(await fs.readFile(inputPath), inputPath)));
  const first = parsed[0]!;
  for (const [index, wav] of parsed.entries()) {
    if (!wav.formatChunk.equals(first.formatChunk)) {
      throw new LocalTtsError(
        'LOCAL_TTS_WAV_INCOMPATIBLE',
        'F5-TTS segments do not share one WAV format and cannot be joined losslessly',
        {details: {index, inputPath: localInputs[index]}},
      );
    }
  }
  const format = makeChunk('fmt ', first.formatChunk);
  const data = makeChunk('data', Buffer.concat(parsed.map((wav) => wav.data)));
  const output = Buffer.alloc(12 + format.length + data.length);
  output.write('RIFF', 0, 4, 'ascii');
  output.writeUInt32LE(output.length - 8, 4);
  output.write('WAVE', 8, 4, 'ascii');
  format.copy(output, 12);
  data.copy(output, 12 + format.length);
  await fs.writeFile(localOutput, output, {flag: 'wx'});
  const segmentDurations = parsed.map((wav) => wav.durationSeconds);
  return {
    durationSeconds: segmentDurations.reduce((sum, duration) => sum + duration, 0),
    segmentDurations,
  };
}

/** Append PCM silence without stretching or truncating synthesized speech. */
export async function padPcmWavFileToDuration(
  inputPath: string,
  outputPath: string,
  targetDurationSeconds: number,
): Promise<PaddedWav> {
  const localInput = assertAbsoluteLocalPath(inputPath, 'inputPath');
  const localOutput = assertAbsoluteLocalPath(outputPath, 'outputPath');
  if (!Number.isFinite(targetDurationSeconds) || targetDurationSeconds <= 0) {
    throw new LocalTtsError('LOCAL_TTS_INVALID_REQUEST', 'targetDurationSeconds must be positive');
  }
  const parsed = parsePcmWavBuffer(await fs.readFile(localInput), localInput);
  if (parsed.durationSeconds > targetDurationSeconds + (parsed.blockAlign / parsed.byteRate)) {
    throw new LocalTtsError(
      'LOCAL_TTS_INVALID_REQUEST',
      `Speech duration ${parsed.durationSeconds.toFixed(6)} exceeds target ${targetDurationSeconds.toFixed(6)}`,
    );
  }
  const targetFrames = Math.max(
    parsed.data.length / parsed.blockAlign,
    Math.round(targetDurationSeconds * parsed.sampleRate),
  );
  const targetDataBytes = targetFrames * parsed.blockAlign;
  const paddingBytes = targetDataBytes - parsed.data.length;
  const format = makeChunk('fmt ', parsed.formatChunk);
  const data = makeChunk('data', Buffer.concat([parsed.data, Buffer.alloc(paddingBytes)]));
  const output = Buffer.alloc(12 + format.length + data.length);
  output.write('RIFF', 0, 4, 'ascii');
  output.writeUInt32LE(output.length - 8, 4);
  output.write('WAVE', 8, 4, 'ascii');
  format.copy(output, 12);
  data.copy(output, 12 + format.length);
  await fs.writeFile(localOutput, output, {flag: 'wx'});
  const durationSeconds = targetDataBytes / parsed.byteRate;
  return {
    speechDurationSeconds: parsed.durationSeconds,
    durationSeconds,
    tailPaddingSeconds: Math.max(0, durationSeconds - parsed.durationSeconds),
  };
}

export async function probeWav(filePath: string): Promise<SerializableWavInfo> {
  const localPath = assertAbsoluteLocalPath(filePath, 'filePath');
  let metadata: Awaited<ReturnType<typeof parseFile>>;
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    [metadata, stat] = await Promise.all([parseFile(localPath, {duration: true}), fs.stat(localPath)]);
  } catch (cause) {
    throw new LocalTtsError('LOCAL_TTS_OUTPUT_INVALID', `Unable to inspect generated WAV: ${localPath}`, {cause});
  }
  const {duration, sampleRate, numberOfChannels} = metadata.format;
  if (!stat.isFile() || stat.size < 44 || duration === undefined || !Number.isFinite(duration) || duration <= 0 ||
      sampleRate === undefined || sampleRate <= 0 || numberOfChannels === undefined || numberOfChannels <= 0) {
    throw new LocalTtsError('LOCAL_TTS_OUTPUT_INVALID', `Generated WAV has incomplete audio metadata: ${localPath}`);
  }
  return {
    path: localPath,
    byteLength: stat.size,
    durationSeconds: duration,
    sampleRate,
    numberOfChannels,
    ...(metadata.format.bitsPerSample === undefined ? {} : {bitsPerSample: metadata.format.bitsPerSample}),
    ...(metadata.format.bitrate === undefined ? {} : {bitrate: metadata.format.bitrate}),
    ...(metadata.format.codec === undefined ? {} : {codec: metadata.format.codec}),
    ...(metadata.format.container === undefined ? {} : {container: metadata.format.container}),
  };
}

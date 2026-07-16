import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface RifeInterpolationRequest {
  inputDirectory: string;
  outputDirectory: string;
  multiplier?: 2 | 4;
  timeoutMs?: number;
}

export interface RifeInterpolationResult {
  inputFrameCount: number;
  outputFrameCount: number;
  multiplier: 2 | 4;
  outputDirectory: string;
}

const pngFrameCount = async (directory: string): Promise<number> =>
  (await fs.readdir(directory, {withFileTypes: true})).filter((entry) => entry.isFile() && /^frame_\d{6}\.png$/i.test(entry.name)).length;

/** Runs the portable rife-ncnn-vulkan command line worker against a deterministic PNG sequence. */
export const runRifeInterpolation = async (executable: string, request: RifeInterpolationRequest): Promise<RifeInterpolationResult> => {
  if (!path.isAbsolute(executable)) throw new Error('RIFE_EXECUTABLE_NOT_ABSOLUTE');
  const inputDirectory = path.resolve(request.inputDirectory);
  const outputDirectory = path.resolve(request.outputDirectory);
  if (inputDirectory === outputDirectory) throw new Error('RIFE_OUTPUT_MUST_DIFFER');
  const inputFrameCount = await pngFrameCount(inputDirectory);
  if (inputFrameCount < 2) throw new Error('RIFE_REQUIRES_AT_LEAST_TWO_FRAMES');
  const multiplier = request.multiplier ?? 2;
  const outputFrameCount = (inputFrameCount - 1) * multiplier + 1;
  await fs.rm(outputDirectory, {recursive: true, force: true});
  await fs.mkdir(outputDirectory, {recursive: true});
  const args = [
    '-i', inputDirectory,
    '-o', outputDirectory,
    '-n', String(outputFrameCount),
    '-f', 'frame_%06d.png',
  ];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, {shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe']});
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-4_000); });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('RIFE_TIMEOUT'));
    }, request.timeoutMs ?? 600_000);
    child.once('error', reject);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`RIFE_EXIT_${code ?? 'UNKNOWN'}:${stderr.trim()}`));
    });
  });
  const actualFrameCount = await pngFrameCount(outputDirectory);
  if (actualFrameCount !== outputFrameCount) throw new Error(`RIFE_FRAME_COUNT_MISMATCH:${actualFrameCount}:${outputFrameCount}`);
  return {inputFrameCount, outputFrameCount, multiplier, outputDirectory};
};

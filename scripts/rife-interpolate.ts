import path from 'node:path';
import process from 'node:process';
import {detectRife, runRifeInterpolation} from '@gen-video-tool/frame-interpolation';

const inputDirectory = process.argv[2] ? path.resolve(process.argv[2]) : null;
const outputDirectory = process.argv[3] ? path.resolve(process.argv[3]) : null;
const multiplier = Number(process.argv[4] ?? 2) as 2 | 4;
if (!inputDirectory || !outputDirectory || ![2, 4].includes(multiplier)) {
  throw new Error('USAGE:npm run rife:frames -- <input-frame-directory> <output-frame-directory> [2|4]');
}
const rife = detectRife({bundledCandidates: process.platform === 'win32' ? [
  path.resolve('tools', 'rife', 'rife.exe'),
  path.resolve('tools', 'rife', 'rife-ncnn-vulkan.exe'),
] : [path.resolve('tools', 'rife', 'rife')]});
if (!rife.executable) throw new Error('RIFE_UNAVAILABLE:set RIFE_PATH or place the portable worker under tools/rife');
console.log(await runRifeInterpolation(rife.executable, {inputDirectory, outputDirectory, multiplier}));

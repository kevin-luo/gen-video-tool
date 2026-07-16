import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {rigSchema} from '@gen-video-tool/schema';
import {runMotionWorker, type MeshActionTemplate} from '@gen-video-tool/worker-client';
import {findRemotionTool} from './local-tools';

const root = path.resolve(import.meta.dirname, '..');
const action = (process.argv[2] ?? 'celebrate') as MeshActionTemplate;
const format = (process.argv[3] ?? 'png-sequence') as 'png-sequence' | 'transparent-webm' | 'alpha-mov';
const candidates = [
  process.env.GODOT_PATH,
  path.resolve(root, '..', '.tools', 'godot-4.7.1', 'Godot_v4.7.1-stable_win64_console.exe'),
  path.resolve(root, '..', '.tools', 'godot-4.7.1', 'Godot_v4.7.1-stable_win64.exe'),
].filter((candidate): candidate is string => Boolean(candidate));
const godot = candidates.find((candidate) => fsSync.existsSync(candidate));
if (!godot) throw new Error('GODOT_NOT_FOUND: set GODOT_PATH to the absolute Godot executable.');

const characterRoot = path.join(root, 'examples', 'football-history', 'assets', 'characters', 'keeper');
const texturePath = path.join(characterRoot, 'character.png');
const rigPath = path.join(characterRoot, 'rig.json');
rigSchema.parse(JSON.parse(await fs.readFile(rigPath, 'utf8')));

const outputDirectory = path.join(root, 'output', 'motion-preview', `keeper-${action}-${format}`);
await fs.rm(outputDirectory, {recursive: true, force: true});
await fs.mkdir(outputDirectory, {recursive: true});
const result = await runMotionWorker(godot, {
  protocolVersion: 1,
  requestId: `keeper-${action}-${Date.now()}`,
  projectId: 'football-history',
  actorId: 'keeper',
  texturePath,
  rigPath,
  ...(format === 'png-sequence' ? {} : {ffmpegPath: findRemotionTool(root, 'ffmpeg')}),
  action: {template: action, durationInFrames: 24, startFrame: 0, fps: 12, amplitude: 0.72},
  output: {directory: outputDirectory, format, width: 420, height: 575, cleanupFrames: format !== 'png-sequence'},
}, {projectPath: path.join(root, 'motion-worker', 'godot'), timeoutMs: 120_000});

if (result.status !== 'complete' || !result.outputPath || !result.hasAlpha) {
  throw new Error(`MESH_PREVIEW_FAILED:${JSON.stringify(result)}`);
}
console.log(JSON.stringify(result, null, 2));

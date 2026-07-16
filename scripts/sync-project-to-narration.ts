import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {parseFile} from 'music-metadata';

const root = path.resolve(import.meta.dirname, '..');
const projectId = process.argv[2];
if (!projectId) throw new Error('Usage: tsx scripts/sync-project-to-narration.ts <project-id>');
const projectRoot = path.join(root, 'examples', projectId);
const manifestPath = path.join(projectRoot, 'manifest.json');
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as {
  fps: number;
  narrationTextPath?: string;
  subtitlesPath?: string;
  audio?: {narrationPath: string};
  shots: Array<{id: string; path: string}>;
};
if (!manifest.audio || !manifest.narrationTextPath || !manifest.subtitlesPath) {
  throw new Error('Project must declare narration text, narration audio, and external SRT paths.');
}
const narration = (await fs.readFile(path.join(projectRoot, manifest.narrationTextPath), 'utf8'))
  .split(/\r?\n\s*\r?\n/)
  .map((paragraph) => paragraph.trim())
  .filter(Boolean);
if (narration.length !== manifest.shots.length) {
  throw new Error(`Narration paragraph count ${narration.length} does not match ${manifest.shots.length} shots.`);
}
const metadata = await parseFile(path.join(projectRoot, manifest.audio.narrationPath));
const audioDuration = metadata.format.duration;
if (!audioDuration) throw new Error('Cannot read narration duration.');
const targetFrames = Math.ceil(audioDuration * manifest.fps);
const shots = await Promise.all(manifest.shots.map(async (reference) => ({
  reference,
  document: JSON.parse(await fs.readFile(path.join(projectRoot, reference.path), 'utf8')) as {durationFrames: number},
})));
const sourceTotal = shots.reduce((sum, shot) => sum + shot.document.durationFrames, 0);
const allocations = shots.map((shot, index) => {
  const exact = shot.document.durationFrames / sourceTotal * targetFrames;
  return {index, frames: Math.max(1, Math.floor(exact)), fraction: exact - Math.floor(exact)};
});
let remaining = targetFrames - allocations.reduce((sum, item) => sum + item.frames, 0);
for (const item of [...allocations].sort((left, right) => right.fraction - left.fraction || right.index - left.index)) {
  if (remaining <= 0) break;
  item.frames += 1;
  remaining -= 1;
}
if (remaining !== 0) throw new Error('Could not allocate narration frames.');

for (const allocation of allocations) {
  const shot = shots[allocation.index]!;
  shot.document.durationFrames = allocation.frames;
  await fs.writeFile(path.join(projectRoot, shot.reference.path), `${JSON.stringify(shot.document, null, 2)}\n`, 'utf8');
}

const srtTime = (frame: number) => {
  const milliseconds = Math.round(frame / manifest.fps * 1000);
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor(milliseconds % 3_600_000 / 60_000);
  const seconds = Math.floor(milliseconds % 60_000 / 1000);
  const millis = milliseconds % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
};
let cursor = 0;
const cues = allocations.map((allocation, index) => {
  const start = cursor;
  cursor += allocation.frames;
  return `${index + 1}\n${srtTime(start)} --> ${srtTime(cursor)}\n${narration[index]}`;
});
await fs.writeFile(path.join(projectRoot, manifest.subtitlesPath), `${cues.join('\n\n')}\n`, 'utf8');
console.log(JSON.stringify({audioDurationSeconds: audioDuration, fps: manifest.fps, targetFrames, pictureDurationSeconds: targetFrames / manifest.fps, shotFrames: allocations.map((item) => item.frames)}, null, 2));

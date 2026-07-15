import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {findRemotionTool} from './local-tools';
import {loadProjectDirectory} from './project-files';

const root = path.resolve(import.meta.dirname, '..');
const ffmpeg = findRemotionTool(root, 'ffmpeg');

const run = (args: string[]) => new Promise<void>((resolve, reject) => {
  const child = spawn(ffmpeg, args, {shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe']});
  let error = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { error = `${error}${chunk}`.slice(-8_000); });
  child.once('error', reject);
  child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`FFmpeg frame extraction failed (${code}): ${error}`)));
});

for (const [id, outputName] of [['football-history', 'football'], ['quiet-story', 'story']] as const) {
  const project = await loadProjectDirectory(path.join(root, 'examples', id));
  const video = path.join(root, 'output', outputName, 'final.mp4');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), `gen-video-${outputName}-frames-`));
  try {
    let cursor = 0;
    const times: Array<{label: string; seconds: number}> = [];
    const poseTimes: Array<{label: string; seconds: number}> = [];
    for (const shot of project.shots) {
      const duration = shot.durationFrames / project.manifest.fps;
      times.push(
        {label: `${shot.id}-start`, seconds: cursor + Math.min(0.12, duration * 0.1)},
        {label: `${shot.id}-middle`, seconds: cursor + duration * 0.5},
        {label: `${shot.id}-end`, seconds: cursor + Math.max(0.12, duration - 0.12)},
      );
      for (const actor of shot.actors) {
        if (actor.mode !== 'pose-cut') continue;
        for (const change of actor.changes) {
          const at = cursor + change.frame / project.manifest.fps;
          poseTimes.push(
            {label: `${shot.id}-${actor.id}-before`, seconds: Math.max(cursor, at - 0.1)},
            {label: `${shot.id}-${actor.id}-switch`, seconds: at},
            {label: `${shot.id}-${actor.id}-after`, seconds: Math.min(cursor + duration - 0.03, at + 0.1)},
          );
        }
      }
      cursor += duration;
    }
    const extract = async (items: Array<{label: string; seconds: number}>, prefix: string) => {
      const frames: string[] = [];
      for (const [index, item] of items.entries()) {
        const file = path.join(temp, `${prefix}-${String(index).padStart(3, '0')}.png`);
        await run(['-y', '-ss', item.seconds.toFixed(3), '-i', video, '-frames:v', '1', file]);
        frames.push(file);
      }
      return frames;
    };
    const compose = async (frames: string[], destination: string, columns: number) => {
      const width = 270;
      const height = 480;
      const rows = Math.ceil(frames.length / columns);
      const composites = await Promise.all(frames.map(async (file, index) => ({
        input: await sharp(file).resize(width, height, {fit: 'cover'}).png().toBuffer(),
        left: (index % columns) * width,
        top: Math.floor(index / columns) * height,
      })));
      await sharp({create: {width: columns * width, height: rows * height, channels: 3, background: '#151719'}})
        .composite(composites)
        .jpeg({quality: 88})
        .toFile(destination);
    };
    const outputRoot = path.join(root, 'output', outputName);
    const frames = await extract(times, 'shot');
    await compose(frames, path.join(outputRoot, 'contact-sheet.jpg'), 3);
    if (poseTimes.length) {
      const poses = await extract(poseTimes, 'pose');
      await compose(poses, path.join(outputRoot, 'pose-cut-contact-sheet.jpg'), 3);
    }
  } finally {
    await fs.rm(temp, {recursive: true, force: true});
  }
}

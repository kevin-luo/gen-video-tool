import {mkdir, readdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import sharp from 'sharp';

export interface FixtureOptions {
  actor?: 'none' | 'rigid';
  actorHasAlpha?: boolean;
  subtitles?: string;
  audioDurationSeconds?: number;
  shotDurationFrames?: number;
}

const createWav = (durationSeconds: number, sampleRate = 8_000): Buffer => {
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

export const writeValidAssetPack = async (
  root: string,
  options: FixtureOptions = {},
): Promise<void> => {
  const shotDurationFrames = options.shotDurationFrames ?? 30;
  await mkdir(path.join(root, 'shots', 'shot-01'), {recursive: true});
  await sharp({
    create: {width: 16, height: 16, channels: 3, background: {r: 30, g: 40, b: 50}},
  }).png().toFile(path.join(root, 'shots', 'shot-01', 'background.png'));

  const actors: unknown[] = [];
  if (options.actor === 'rigid') {
    await mkdir(path.join(root, 'characters'), {recursive: true});
    const channels = options.actorHasAlpha === false ? 3 : 4;
    await sharp({
      create: {
        width: 12,
        height: 20,
        channels,
        background: channels === 4 ? {r: 200, g: 80, b: 30, alpha: 0.8} : {r: 200, g: 80, b: 30},
      },
    }).png().toFile(path.join(root, 'characters', 'hero.png'));
    actors.push({id: 'hero', mode: 'rigid', sourcePath: 'characters/hero.png'});
  }

  const shot = {
    schemaVersion: 2,
    id: 'shot-01',
    durationFrames: shotDurationFrames,
    recipeId: 'editorial-pan',
    layers: [{id: 'background', role: 'background', assetPath: 'shots/shot-01/background.png'}],
    actors,
  };
  await writeFile(path.join(root, 'shots', 'shot-01', 'shot.json'), JSON.stringify(shot, null, 2));

  const manifest: Record<string, unknown> = {
    schemaVersion: 2,
    projectId: 'fixture-project',
    title: 'Fixture project',
    canvas: {width: 1080, height: 1920, aspectRatio: '9:16'},
    fps: 30,
    shots: [{id: 'shot-01', path: 'shots/shot-01/shot.json'}],
  };
  if (options.subtitles !== undefined) {
    manifest.subtitlesPath = 'subtitles.srt';
    await writeFile(path.join(root, 'subtitles.srt'), options.subtitles, 'utf8');
  }
  if (options.audioDurationSeconds !== undefined) {
    await mkdir(path.join(root, 'audio'), {recursive: true});
    await writeFile(path.join(root, 'audio', 'narration.wav'), createWav(options.audioDurationSeconds));
    manifest.audio = {narrationPath: 'audio/narration.wav'};
  }
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2));
};

const addDirectory = async (zip: JSZip, root: string, directory = ''): Promise<void> => {
  const entries = await readdir(path.join(root, directory), {withFileTypes: true});
  for (const entry of entries) {
    const relative = directory ? `${directory}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await addDirectory(zip, root, relative);
    else zip.file(relative, await readFile(path.join(root, directory, entry.name)));
  }
};

export const zipAssetPack = async (sourceRoot: string, outputPath: string): Promise<void> => {
  const zip = new JSZip();
  await addDirectory(zip, sourceRoot);
  await writeFile(outputPath, await zip.generateAsync({type: 'nodebuffer', compression: 'DEFLATE'}));
};

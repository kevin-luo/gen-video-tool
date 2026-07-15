import {access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {importAssetPack, inspectAssetPack} from '@gen-video-tool/asset-pack';
import {writeValidAssetPack, zipAssetPack} from '../../fixtures/asset-pack';

const created: string[] = [];
const temporaryDirectory = async (): Promise<string> => {
  const result = await mkdtemp(path.join(tmpdir(), 'gen-video-tool-test-'));
  created.push(result);
  return result;
};

afterEach(async () => {
  await Promise.all(created.splice(0).map((entry) => rm(entry, {recursive: true, force: true})));
});

describe('asset pack importer', () => {
  it('atomically commits a valid directory pack', async () => {
    const source = await temporaryDirectory();
    const projects = await temporaryDirectory();
    await writeValidAssetPack(source, {actor: 'rigid'});
    const result = await importAssetPack({source: {kind: 'directory', path: source}, projectsRoot: projects});
    expect(result.status).toBe('committed');
    expect(result.projectPath).not.toBeNull();
    expect(await realpath(result.projectPath ?? '')).toBe(await realpath(path.join(projects, 'fixture-project')));
    expect(JSON.parse(await readFile(path.join(projects, 'fixture-project', 'manifest.json'), 'utf8'))).toMatchObject({projectId: 'fixture-project'});
    expect((await readdir(projects)).some((entry) => entry.endsWith('.staging'))).toBe(false);
  });

  it('leaves no destination when any blocking diagnostic exists', async () => {
    const source = await temporaryDirectory();
    const projects = await temporaryDirectory();
    await writeFile(path.join(source, 'not-a-pack.txt'), 'no manifest');
    const result = await importAssetPack({
      source: {kind: 'directory', path: source},
      projectsRoot: projects,
      destinationName: 'must-not-exist',
    });
    expect(result.status).toBe('rejected');
    expect(result.diagnostics.map((item) => item.code)).toContain('MANIFEST_MISSING');
    await expect(access(path.join(projects, 'must-not-exist'))).rejects.toThrow();
    expect((await readdir(projects)).some((entry) => entry.endsWith('.staging'))).toBe(false);
  });

  it('never overwrites an existing project', async () => {
    const source = await temporaryDirectory();
    const projects = await temporaryDirectory();
    await writeValidAssetPack(source);
    const destination = path.join(projects, 'fixture-project');
    await mkdir(destination);
    await writeFile(path.join(destination, 'sentinel.txt'), 'keep');
    const result = await importAssetPack({source: {kind: 'directory', path: source}, projectsRoot: projects});
    expect(result.status).toBe('rejected');
    expect(result.diagnostics.map((item) => item.code)).toContain('DESTINATION_EXISTS');
    expect(await readFile(path.join(destination, 'sentinel.txt'), 'utf8')).toBe('keep');
  });

  it('validates ZIP packs and rejects actors without alpha', async () => {
    const source = await temporaryDirectory();
    const output = path.join(await temporaryDirectory(), 'pack.zip');
    await writeValidAssetPack(source, {actor: 'rigid', actorHasAlpha: false});
    await zipAssetPack(source, output);
    const result = await inspectAssetPack({source: {kind: 'zip', path: output}});
    expect(result.status).toBe('rejected');
    expect(result.diagnostics.map((item) => item.code)).toContain('IMAGE_ALPHA_REQUIRED');
  });

  it('checks actual narration duration against the video', async () => {
    const source = await temporaryDirectory();
    await writeValidAssetPack(source, {audioDurationSeconds: 0.2, shotDurationFrames: 30});
    const result = await inspectAssetPack({source: {kind: 'directory', path: source}});
    expect(result.diagnostics.map((item) => item.code)).toContain('AUDIO_TOO_SHORT');
  });

  it('reports missing references, duplicate ids and unreferenced files', async () => {
    const source = await temporaryDirectory();
    await writeValidAssetPack(source);
    const manifestPath = path.join(source, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest.styleReferencePath = 'missing/style.png';
    await writeFile(manifestPath, JSON.stringify(manifest));
    const shotPath = path.join(source, 'shots', 'shot-01', 'shot.json');
    const shot = JSON.parse(await readFile(shotPath, 'utf8')) as {layers: unknown[]};
    shot.layers.push({id: 'background', role: 'prop', assetPath: 'shots/shot-01/background.png'});
    await writeFile(shotPath, JSON.stringify(shot));
    await writeFile(path.join(source, 'unused.txt'), 'unused');

    const result = await inspectAssetPack({source: {kind: 'directory', path: source}});
    const codes = result.diagnostics.map((item) => item.code);
    expect(codes).toContain('REFERENCE_MISSING');
    expect(codes).toContain('DUPLICATE_ID');
    expect(codes).toContain('UNREFERENCED_FILE');
  });

  it('rejects corrupt images and invalid actor modes with actionable codes', async () => {
    const source = await temporaryDirectory();
    await writeValidAssetPack(source);
    await writeFile(path.join(source, 'shots', 'shot-01', 'background.png'), 'not an image');
    const shotPath = path.join(source, 'shots', 'shot-01', 'shot.json');
    const shot = JSON.parse(await readFile(shotPath, 'utf8')) as {actors: unknown[]};
    shot.actors.push({id: 'bad', mode: 'split-limbs', sourcePath: 'characters/bad.png'});
    await writeFile(shotPath, JSON.stringify(shot));
    const result = await inspectAssetPack({source: {kind: 'directory', path: source}});
    const codes = result.diagnostics.map((item) => item.code);
    expect(codes).toContain('IMAGE_CORRUPT');
    expect(codes).toContain('ACTOR_MODE_UNSUPPORTED');
  });

  it('checks Pose Cut rules before schema rejection', async () => {
    const source = await temporaryDirectory();
    await writeValidAssetPack(source);
    const shotPath = path.join(source, 'shots', 'shot-01', 'shot.json');
    const shot = JSON.parse(await readFile(shotPath, 'utf8')) as {actors: unknown[]};
    shot.actors.push({
      id: 'hero',
      mode: 'pose-cut',
      poses: [{id: 'only', sourcePath: 'characters/only.png', fullFigure: true}],
      transition: {type: 'crossfade', durationFrames: 8},
    });
    await writeFile(shotPath, JSON.stringify(shot));
    const result = await inspectAssetPack({source: {kind: 'directory', path: source}});
    const codes = result.diagnostics.map((item) => item.code);
    expect(codes).toContain('POSE_CUT_TOO_FEW_POSES');
    expect(codes).toContain('POSE_CUT_CROSSFADE_FORBIDDEN');
  });

  it('validates Mesh Puppet rig presence and declared texture dimensions', async () => {
    const missingRoot = await temporaryDirectory();
    await writeValidAssetPack(missingRoot, {actor: 'rigid'});
    const missingShotPath = path.join(missingRoot, 'shots', 'shot-01', 'shot.json');
    const missingShot = JSON.parse(await readFile(missingShotPath, 'utf8')) as {actors: Array<Record<string, unknown>>};
    missingShot.actors = [{id: 'hero', mode: 'mesh', sourcePath: 'characters/hero.png', rigPath: 'characters/rig.json'}];
    await writeFile(missingShotPath, JSON.stringify(missingShot));
    const missing = await inspectAssetPack({source: {kind: 'directory', path: missingRoot}});
    expect(missing.diagnostics.map((item) => item.code)).toContain('MESH_RIG_MISSING');

    const mismatchRoot = await temporaryDirectory();
    await writeValidAssetPack(mismatchRoot, {actor: 'rigid'});
    const mismatchShotPath = path.join(mismatchRoot, 'shots', 'shot-01', 'shot.json');
    const mismatchShot = JSON.parse(await readFile(mismatchShotPath, 'utf8')) as {actors: Array<Record<string, unknown>>};
    mismatchShot.actors = [{id: 'hero', mode: 'mesh', sourcePath: 'characters/hero.png', rigPath: 'characters/rig.json'}];
    await writeFile(mismatchShotPath, JSON.stringify(mismatchShot));
    await writeFile(path.join(mismatchRoot, 'characters', 'rig.json'), JSON.stringify({
      schemaVersion: 2,
      texturePath: 'characters/hero.png',
      canvas: {width: 99, height: 99},
      bones: [{id: 'root', parentId: null, pivot: {x: 0, y: 0}, tip: {x: 0, y: 10}}],
      mesh: {
        vertices: [{x: 0, y: 0}, {x: 10, y: 0}, {x: 0, y: 10}],
        triangles: [[0, 1, 2]],
        weights: [[{boneId: 'root', weight: 1}], [{boneId: 'root', weight: 1}], [{boneId: 'root', weight: 1}]],
      },
    }));
    const mismatch = await inspectAssetPack({source: {kind: 'directory', path: mismatchRoot}});
    expect(mismatch.diagnostics.map((item) => item.code)).toContain('IMAGE_DIMENSIONS_MISMATCH');
  });

  it('integrates SRT overlap and malformed-time diagnostics', async () => {
    const overlapRoot = await temporaryDirectory();
    await writeValidAssetPack(overlapRoot, {subtitles: '\uFEFF1\r\n00:00:00,000 --> 00:00:00,800\r\nA\r\n\r\n2\r\n00:00:00,700 --> 00:00:00,900\r\nB\r\n'});
    const overlap = await inspectAssetPack({source: {kind: 'directory', path: overlapRoot}});
    expect(overlap.status).toBe('ready');
    expect(overlap.diagnostics.map((item) => item.code)).toContain('SRT_OVERLAP');

    const malformedRoot = await temporaryDirectory();
    await writeValidAssetPack(malformedRoot, {subtitles: '1\n00:61:00,000 --> 00:00:01,000\nBad'});
    const malformed = await inspectAssetPack({source: {kind: 'directory', path: malformedRoot}});
    expect(malformed.status).toBe('rejected');
    expect(malformed.diagnostics.map((item) => item.code)).toContain('SRT_TIME_INVALID');
  });
});

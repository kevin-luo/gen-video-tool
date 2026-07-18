import {access, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {afterEach, describe, expect, it} from 'vitest';
import {
  importAssetPack,
  inspectAssetPack,
  inspectAssetPackWithPlan,
  loadProjectDirectory,
  projectDurationSeconds,
} from '@gen-video-tool/asset-pack';
import {writeValidAssetPack, zipAssetPack} from '../../fixtures/asset-pack';

const created: string[] = [];
const temporaryDirectory = async (): Promise<string> => {
  const result = await mkdtemp(path.join(tmpdir(), 'gen-video-tool-test-'));
  created.push(result);
  return result;
};

const readPlan = async (root: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(path.join(root, 'production.json'), 'utf8')) as Record<string, unknown>;

const writePlan = async (root: string, plan: Record<string, unknown>): Promise<void> => {
  await writeFile(path.join(root, 'production.json'), JSON.stringify(plan, null, 2));
};

const paperGroupNames = ['structure.png', 'hero.png', 'prop.png', 'foreground.png', 'accent.png'];

const addTransparentPaperBoundary = async (root: string): Promise<void> => {
  await Promise.all(paperGroupNames.map(async (name) => {
    const imagePath = path.join(root, 'assets', 'shots', 'shot-01', name);
    const temporary = `${imagePath}.border.png`;
    await sharp(imagePath).extend({
      top: 1,
      bottom: 1,
      left: 1,
      right: 1,
      background: {r: 0, g: 0, b: 0, alpha: 0},
    }).png().toFile(temporary);
    await rename(temporary, imagePath);
  }));
};

afterEach(async () => {
  await Promise.all(created.splice(0).map((entry) => rm(entry, {recursive: true, force: true})));
});

describe('v3 asset pack importer', () => {
  it('atomically commits a valid production.json directory pack', async () => {
    const source = await temporaryDirectory();
    const projects = await temporaryDirectory();
    await writeValidAssetPack(source);

    const result = await importAssetPack({source: {kind: 'directory', path: source}, projectsRoot: projects});

    expect(result.status).toBe('committed');
    expect(result.productionSchemaVersion).toBe(3);
    expect(result.generatedPerformanceShotCount).toBe(1);
    expect(result.projectPath).not.toBeNull();
    expect(await realpath(result.projectPath ?? '')).toBe(await realpath(path.join(projects, 'fixture-project')));
    const committed = await loadProjectDirectory(result.projectPath ?? '');
    expect(committed).toMatchObject({schemaVersion: 3, projectId: 'fixture-project'});
    expect(projectDurationSeconds(committed)).toBeCloseTo(101 / 30);
    expect((await readdir(projects)).some((entry) => entry.endsWith('.staging'))).toBe(false);
  });

  it('requires one unique production.json root marker and leaves no destination on rejection', async () => {
    const missingSource = await temporaryDirectory();
    const projects = await temporaryDirectory();
    await writeFile(path.join(missingSource, 'not-a-pack.txt'), 'no production plan');
    const missing = await importAssetPack({
      source: {kind: 'directory', path: missingSource},
      projectsRoot: projects,
      destinationName: 'must-not-exist',
    });
    expect(missing.status).toBe('rejected');
    expect(missing.productionSchemaVersion).toBeNull();
    expect(missing.diagnostics.map((item) => item.code)).toContain('PRODUCTION_PLAN_MISSING');
    await expect(access(path.join(projects, 'must-not-exist'))).rejects.toThrow();

    const multipleSource = await temporaryDirectory();
    await writeValidAssetPack(path.join(multipleSource, 'first'));
    await writeValidAssetPack(path.join(multipleSource, 'second'));
    const multiple = await inspectAssetPack({source: {kind: 'directory', path: multipleSource}});
    expect(multiple.status).toBe('rejected');
    expect(multiple.diagnostics.map((item) => item.code)).toContain('PRODUCTION_PLAN_MULTIPLE');
  });

  it('accepts one wrapper directory but never overwrites an existing project', async () => {
    const source = await temporaryDirectory();
    const wrapped = path.join(source, 'downloaded-pack');
    const projects = await temporaryDirectory();
    await writeValidAssetPack(wrapped);
    await writeFile(path.join(source, 'download-note.txt'), 'outside wrapper');

    const first = await importAssetPack({source: {kind: 'directory', path: source}, projectsRoot: projects});
    expect(first.status).toBe('committed');
    expect(await readFile(path.join(projects, 'fixture-project', 'production.json'), 'utf8')).toContain('"schemaVersion": 3');
    expect(first.diagnostics.map((item) => item.code)).toContain('UNREFERENCED_FILE');

    const secondSource = await temporaryDirectory();
    await writeValidAssetPack(secondSource);
    await writeFile(path.join(projects, 'fixture-project', 'sentinel.txt'), 'keep');
    const second = await importAssetPack({source: {kind: 'directory', path: secondSource}, projectsRoot: projects});
    expect(second.status).toBe('rejected');
    expect(second.diagnostics.map((item) => item.code)).toContain('DESTINATION_EXISTS');
    expect(await readFile(path.join(projects, 'fixture-project', 'sentinel.txt'), 'utf8')).toBe('keep');
  });

  it('rejects production.json nested below more than one wrapper directory', async () => {
    const source = await temporaryDirectory();
    await writeValidAssetPack(path.join(source, 'outer', 'inner'));

    const result = await inspectAssetPack({source: {kind: 'directory', path: source}});

    expect(result.status).toBe('rejected');
    expect(result.productionSchemaVersion).toBeNull();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'PRODUCTION_PLAN_INVALID',
      assetPath: 'outer/inner/production.json',
    }));
  });

  it('validates ZIP packs and requires alpha for deterministic props', async () => {
    const source = await temporaryDirectory();
    const output = path.join(await temporaryDirectory(), 'pack.zip');
    await writeValidAssetPack(source, {propHasAlpha: false});
    await zipAssetPack(source, output);
    const result = await inspectAssetPack({source: {kind: 'zip', path: output}});
    expect(result.status).toBe('rejected');
    expect(result.diagnostics.map((item) => item.code)).toContain('IMAGE_ALPHA_REQUIRED');
  });

  it('uses native WanGP raster dimensions for every conditioning keyframe', async () => {
    const mismatch = await temporaryDirectory();
    await writeValidAssetPack(mismatch, {keyframeWidth: 512, keyframeHeight: 896});
    const mismatchResult = await inspectAssetPack({source: {kind: 'directory', path: mismatch}});
    expect(mismatchResult.status).toBe('rejected');
    expect(mismatchResult.diagnostics.map((item) => item.code)).toContain('IMAGE_DIMENSIONS_MISMATCH');

    const startOnly = await temporaryDirectory();
    await writeValidAssetPack(startOnly, {mode: 'generated-start-only'});
    const startOnlyResult = await inspectAssetPack({source: {kind: 'directory', path: startOnly}});
    expect(startOnlyResult.status).toBe('ready');
    expect(startOnlyResult.diagnostics.map((item) => item.code)).not.toContain('REFERENCE_MISSING');
  });

  it('validates both branches of the generation conditioning union', async () => {
    const source = await temporaryDirectory();
    await writeValidAssetPack(source);
    await rm(path.join(source, 'assets', 'shots', 'shot-01', 'performance-end.png'));
    const result = await inspectAssetPack({source: {kind: 'directory', path: source}});
    expect(result.status).toBe('rejected');
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'REFERENCE_MISSING',
      path: '/shots/0/generation/conditioning/endKeyframePath',
    }));
  });

  it('validates collage layers and requires alpha for actor/foreground roles', async () => {
    const valid = await temporaryDirectory();
    await writeValidAssetPack(valid, {mode: 'layered-collage'});
    const validResult = await inspectAssetPack({source: {kind: 'directory', path: valid}});
    expect(validResult.status).toBe('ready');
    expect(validResult.generatedPerformanceShotCount).toBe(0);

    const opaque = await temporaryDirectory();
    await writeValidAssetPack(opaque, {mode: 'layered-collage', collageActorHasAlpha: false});
    const opaqueResult = await inspectAssetPack({source: {kind: 'directory', path: opaque}});
    expect(opaqueResult.status).toBe('rejected');
    expect(opaqueResult.diagnostics.map((item) => item.code)).toContain('IMAGE_ALPHA_REQUIRED');
  });

  it('applies real transparent-boundary checks only to the paper plan-aware inspector', async () => {
    const source = await temporaryDirectory();
    await writeValidAssetPack(source, {mode: 'layered-collage'});
    await addTransparentPaperBoundary(source);

    const validPaper = await inspectAssetPackWithPlan(
      {source: {kind: 'directory', path: source}},
      {requireAlphaForNonBackground: true},
    );
    expect(validPaper.inspection.status).toBe('ready');

    const opaqueRgbaPath = path.join(source, 'assets', 'shots', 'shot-01', 'structure.png');
    const temporary = `${opaqueRgbaPath}.opaque.png`;
    await sharp({
      create: {width: 640, height: 720, channels: 4, background: {r: 50, g: 90, b: 80, alpha: 1}},
    }).png().toFile(temporary);
    await rename(temporary, opaqueRgbaPath);

    const generic = await inspectAssetPack({source: {kind: 'directory', path: source}});
    expect(generic.status).toBe('ready');

    const strictPaper = await inspectAssetPackWithPlan(
      {source: {kind: 'directory', path: source}},
      {requireAlphaForNonBackground: true},
    );
    expect(strictPaper.inspection.status).toBe('rejected');
    expect(strictPaper.inspection.diagnostics).toContainEqual(expect.objectContaining({
      code: 'IMAGE_ALPHA_REQUIRED',
      assetPath: 'assets/shots/shot-01/structure.png',
    }));

    const tokenAlpha = Buffer.alloc(640 * 720 * 4, 255);
    tokenAlpha[3] = 0;
    const tokenTemporary = `${opaqueRgbaPath}.token-alpha.png`;
    await sharp(tokenAlpha, {raw: {width: 640, height: 720, channels: 4}})
      .png()
      .toFile(tokenTemporary);
    await rename(tokenTemporary, opaqueRgbaPath);
    const tokenTransparentPaper = await inspectAssetPackWithPlan(
      {source: {kind: 'directory', path: source}},
      {requireAlphaForNonBackground: true},
    );
    expect(tokenTransparentPaper.inspection.status).toBe('rejected');
    expect(tokenTransparentPaper.inspection.diagnostics).toContainEqual(expect.objectContaining({
      code: 'IMAGE_ALPHA_REQUIRED',
      assetPath: 'assets/shots/shot-01/structure.png',
    }));
  });

  it('reports every missing plan input and unreferenced source file', async () => {
    const source = await temporaryDirectory();
    await writeValidAssetPack(source);
    const plan = await readPlan(source);
    const narration = plan.narration as {referenceAudioPath: string};
    narration.referenceAudioPath = 'assets/voices/missing.wav';
    const [shot] = plan.shots as Array<{
      hybridMotion: {deterministicProps: Array<{assetPath: string}>};
      occlusion: unknown;
    }>;
    shot!.hybridMotion.deterministicProps[0]!.assetPath = 'assets/shots/shot-01/missing-ball.png';
    shot!.occlusion = {
      mode: 'local-matte',
      requirement: 'required',
      subjectId: 'kicker',
      engine: 'local-video-matting',
      outputDirectory: 'generated/mattes/shot-01',
      outputFormat: 'webm-alpha',
      foregroundAssetPath: 'assets/shots/shot-01/missing-foreground.png',
      featherPixels: 2,
    };
    (plan.requiredCapabilities as string[]).push('local-video-matting');
    await writePlan(source, plan);
    await writeFile(path.join(source, 'unused.txt'), 'unused');

    const result = await inspectAssetPack({source: {kind: 'directory', path: source}});
    const missing = result.diagnostics.filter((item) => item.code === 'REFERENCE_MISSING');
    expect(result.status).toBe('rejected');
    expect(missing.map((item) => item.path)).toEqual(expect.arrayContaining([
      '/narration/referenceAudioPath',
      '/shots/0/hybridMotion/deterministicProps/0/assetPath',
      '/shots/0/occlusion/foregroundAssetPath',
    ]));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({code: 'UNREFERENCED_FILE', assetPath: 'unused.txt'}));
  });

  it('rejects corrupt keyframes and corrupt F5 reference audio', async () => {
    const corruptImage = await temporaryDirectory();
    await writeValidAssetPack(corruptImage);
    await writeFile(path.join(corruptImage, 'assets', 'shots', 'shot-01', 'performance-start.png'), 'not an image');
    const imageResult = await inspectAssetPack({source: {kind: 'directory', path: corruptImage}});
    expect(imageResult.status).toBe('rejected');
    expect(imageResult.diagnostics.map((item) => item.code)).toContain('IMAGE_CORRUPT');

    const corruptAudio = await temporaryDirectory();
    await writeValidAssetPack(corruptAudio, {referenceAudioValid: false});
    const audioResult = await inspectAssetPack({source: {kind: 'directory', path: corruptAudio}});
    expect(audioResult.status).toBe('rejected');
    expect(audioResult.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^AUDIO_(?:CORRUPT|DURATION_MISSING)$/u),
      ]),
    );
  });

  it('rejects invalid v3 contracts with no schema-v2 fallback', async () => {
    const source = await temporaryDirectory();
    await writeValidAssetPack(source);
    const plan = await readPlan(source);
    plan.schemaVersion = 2;
    await writePlan(source, plan);
    const result = await inspectAssetPack({source: {kind: 'directory', path: source}});
    expect(result.status).toBe('rejected');
    expect(result.productionSchemaVersion).toBeNull();
    expect(result.diagnostics.map((item) => item.code)).toContain('PRODUCTION_PLAN_INVALID');
  });

  it('rejects duplicate production ids and source packs containing generated state', async () => {
    const duplicate = await temporaryDirectory();
    await writeValidAssetPack(duplicate, {mode: 'layered-collage'});
    const duplicatePlan = await readPlan(duplicate);
    const [shot] = duplicatePlan.shots as Array<{layers: Array<{id: string}>}>;
    shot!.layers[1]!.id = shot!.layers[0]!.id;
    await writePlan(duplicate, duplicatePlan);
    const duplicateResult = await inspectAssetPack({source: {kind: 'directory', path: duplicate}});
    expect(duplicateResult.status).toBe('rejected');
    expect(duplicateResult.diagnostics.map((item) => item.code)).toContain('DUPLICATE_ID');

    const generated = await temporaryDirectory();
    await writeValidAssetPack(generated);
    await mkdir(path.join(generated, 'generated'), {recursive: true});
    await writeFile(path.join(generated, 'generated', 'production-state.json'), '{}');
    const generatedResult = await inspectAssetPack({source: {kind: 'directory', path: generated}});
    expect(generatedResult.status).toBe('rejected');
    expect(generatedResult.diagnostics.map((item) => item.code)).toContain('GENERATED_ARTIFACT_FORBIDDEN');
  });
});

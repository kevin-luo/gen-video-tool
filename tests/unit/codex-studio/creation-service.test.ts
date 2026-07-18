import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import sharp from 'sharp';
import {afterEach, describe, expect, it} from 'vitest';

import {CreationService} from '../../../apps/codex-studio/src/creation-service';
import {writeValidAssetPack} from '../../fixtures/asset-pack';

const roots: string[] = [];

const paperGroupNames = ['structure.png', 'hero.png', 'prop.png', 'foreground.png', 'accent.png'];

const writePaperAssetPack = async (root: string): Promise<void> => {
  await writeValidAssetPack(root, {mode: 'layered-collage'});
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
    await fs.rename(temporary, imagePath);
  }));
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, {recursive: true, force: true})));
});

const makeService = async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gen-video-creation-'));
  roots.push(dataRoot);
  return new CreationService({
    repositoryRoot: path.resolve('.'),
    dataRoot,
    projectsRoot: path.join(dataRoot, 'projects'),
    outputRoot: path.join(dataRoot, 'output'),
    jobsFile: path.join(dataRoot, 'jobs.json'),
    host: '127.0.0.1',
    port: 4390,
    baseUrl: 'http://127.0.0.1:4390',
    sessionToken: 'test-session-token-0123456789-abcdefghijklmnopqrstuvwxyz',
  });
};

describe('CreationService', () => {
  it('persists a creator request with no burned subtitles or BGM', async () => {
    const service = await makeService();
    const created = await service.create({
      script: '  可爱小猫摆摊卖炒粉。  香气把整条街都叫醒了。 ',
      platform: 'douyin',
      durationSeconds: 20,
      voice: true,
    });
    expect(created.title).toBe('可爱小猫摆摊卖炒粉');
    expect(created.script).toBe('可爱小猫摆摊卖炒粉。 香气把整条街都叫醒了。');
    expect(created.subtitles).toBe('sidecar-srt');
    expect(created.bgm).toBe(false);
    expect(created.visualMode).toBe('paper-collage');
    expect(created.assetStatus).toBe('awaiting-assets');
    expect(await service.list()).toEqual([created]);
  });

  it('attaches a real asynchronous job without changing the request', async () => {
    const service = await makeService();
    const created = await service.create({
      script: '一条文案变成一条视频。',
      platform: 'xiaohongshu',
      durationSeconds: 20,
      voice: true,
    });
    const attached = await service.attachJob(created.id, '00000000-0000-4000-8000-000000000001');
    expect(attached.jobId).toBe('00000000-0000-4000-8000-000000000001');
    expect(attached.script).toBe(created.script);
    expect((await service.get(created.id)).jobId).toBe(attached.jobId);
  });

  it('validates and atomically attaches a duration-matched paper project', async () => {
    const service = await makeService();
    const created = await service.create({
      script: '一只小猫在夜市认真炒完最后一份炒粉。',
      platform: 'douyin',
      durationSeconds: 20,
      voice: true,
    });
    const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gen-video-paper-pack-'));
    roots.push(sourceRoot);
    await writePaperAssetPack(sourceRoot);
    const planPath = path.join(sourceRoot, 'production.json');
    const plan = JSON.parse(await fs.readFile(planPath, 'utf8')) as {
      delivery: {timeline: {durationFrames: number}};
      narration: {segments: Array<{segmentId: string; shotId: string; text: string; outputPath: string}>};
      shots: Array<{deliveryTimeline: {durationFrames: number}}>;
    };
    plan.delivery.timeline.durationFrames = 600;
    plan.shots[0]!.deliveryTimeline.durationFrames = 600;
    const narration = plan.narration.segments[0]!;
    plan.narration.segments = [
      {...narration, segmentId: 'voice-part-a', text: '一只小猫，在夜市认真', outputPath: 'generated/audio/part-a.wav'},
      {...narration, segmentId: 'voice-part-b', text: '炒完最后一份炒粉！', outputPath: 'generated/audio/part-b.wav'},
    ];
    await fs.writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');

    const inspection = await service.inspectPaperProject(created.id, sourceRoot);
    expect(inspection).toMatchObject({readyForCreation: true, requestedDurationSeconds: 20, generatedPerformanceShotCount: 0});
    const attached = await service.attachPaperProject(created.id, sourceRoot);
    expect(attached.assetStatus).toBe('ready');
    await expect(fs.access(path.join(service.creationRoot(created.id), 'paper-project', 'production.json'))).resolves.toBeUndefined();
    await expect(service.attachPaperProject(created.id, sourceRoot)).rejects.toThrow('PAPER_PROJECT_ALREADY_ATTACHED');
  });

  it('binds normalized narration content to the creation script, not merely its length', async () => {
    const service = await makeService();
    const created = await service.create({
      script: '小猫认真翻炒米粉。',
      platform: 'douyin',
      durationSeconds: 20,
      voice: true,
    });
    const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gen-video-paper-script-bind-'));
    roots.push(sourceRoot);
    await writePaperAssetPack(sourceRoot);
    const planPath = path.join(sourceRoot, 'production.json');
    const plan = JSON.parse(await fs.readFile(planPath, 'utf8')) as {
      delivery: {timeline: {durationFrames: number}};
      narration: {segments: Array<{text: string}>};
      shots: Array<{deliveryTimeline: {durationFrames: number}}>;
    };
    plan.delivery.timeline.durationFrames = 600;
    plan.shots[0]!.deliveryTimeline.durationFrames = 600;
    // Same eight Han characters plus punctuation as the request, but unrelated content.
    plan.narration.segments[0]!.text = '小狗安静追逐皮球！';
    await fs.writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');

    const inspection = await service.inspectPaperProject(created.id, sourceRoot);
    expect(inspection.readyForCreation).toBe(false);
    expect(inspection.blockingReason).toBe('PAPER_COLLAGE_NARRATION_SCRIPT_MISMATCH');
    await expect(service.attachPaperProject(created.id, sourceRoot))
      .rejects.toThrow('PAPER_COLLAGE_NARRATION_SCRIPT_MISMATCH');
    await expect(fs.access(path.join(service.creationRoot(created.id), 'paper-project'))).rejects.toThrow();
  });

  it('rejects generated-performance or wrong-duration packs before attaching files', async () => {
    const service = await makeService();
    const created = await service.create({
      script: '纸片角色依次进入画面。',
      platform: 'xiaohongshu',
      durationSeconds: 20,
      voice: true,
    });
    const generatedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gen-video-generated-pack-'));
    roots.push(generatedRoot);
    await writeValidAssetPack(generatedRoot, {mode: 'generated-start-only'});
    await expect(service.attachPaperProject(created.id, generatedRoot))
      .rejects.toThrow('PAPER_COLLAGE_GENERATED_SHOTS_FORBIDDEN');
    await expect(fs.access(path.join(service.creationRoot(created.id), 'paper-project'))).rejects.toThrow();

    const shortRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gen-video-short-paper-pack-'));
    roots.push(shortRoot);
    await writePaperAssetPack(shortRoot);
    await expect(service.attachPaperProject(created.id, shortRoot))
      .rejects.toThrow('PAPER_COLLAGE_DURATION_MISMATCH');
    await expect(fs.access(path.join(service.creationRoot(created.id), 'paper-project'))).rejects.toThrow();
  });

  it('rejects static, stretched, or unstaggered collage packs at the paper attach gate', async () => {
    const service = await makeService();
    const created = await service.create({
      script: '纸片从空场逐组进入，落位后停住。',
      platform: 'douyin',
      durationSeconds: 20,
      voice: true,
    });
    type PaperLayer = {
      id: string;
      role: string;
      assembly?: {startFrame: number; durationFrames: number};
      transform: {scaleX: number; scaleY: number};
    };
    type PaperPlan = {
      delivery: {timeline: {durationFrames: number}};
      shots: Array<{deliveryTimeline: {durationFrames: number}; layers: PaperLayer[]}>;
    };
    const makePack = async (mutate: (plan: PaperPlan) => void): Promise<string> => {
      const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gen-video-paper-gate-'));
      roots.push(sourceRoot);
      await writePaperAssetPack(sourceRoot);
      const planPath = path.join(sourceRoot, 'production.json');
      const plan = JSON.parse(await fs.readFile(planPath, 'utf8')) as PaperPlan;
      plan.delivery.timeline.durationFrames = 600;
      plan.shots[0]!.deliveryTimeline.durationFrames = 600;
      mutate(plan);
      await fs.writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
      return sourceRoot;
    };

    const staticRoot = await makePack((plan) => {
      for (const layer of plan.shots[0]!.layers) delete layer.assembly;
    });
    await expect(service.attachPaperProject(created.id, staticRoot))
      .rejects.toThrow('PAPER_COLLAGE_ASSEMBLY_REQUIRED');

    const stretchedRoot = await makePack((plan) => {
      plan.shots[0]!.layers.find((layer) => layer.role === 'actor')!.transform.scaleY = 1.2;
    });
    await expect(service.attachPaperProject(created.id, stretchedRoot))
      .rejects.toThrow('PAPER_COLLAGE_UNIFORM_SCALE_REQUIRED');

    const unstaggeredRoot = await makePack((plan) => {
      for (const layer of plan.shots[0]!.layers) {
        if (layer.assembly !== undefined) layer.assembly.startFrame = 12;
      }
    });
    await expect(service.attachPaperProject(created.id, unstaggeredRoot))
      .rejects.toThrow('PAPER_COLLAGE_ASSEMBLY_STAGGER_REQUIRED');

    await expect(fs.access(path.join(service.creationRoot(created.id), 'paper-project'))).rejects.toThrow();
  });

  it('requires real transparent boundary pixels on every non-background group, including midground', async () => {
    const service = await makeService();
    const created = await service.create({
      script: '透明纸片依次组装。',
      platform: 'wechat-channels',
      durationSeconds: 20,
      voice: true,
    });
    const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gen-video-paper-alpha-'));
    roots.push(sourceRoot);
    await writePaperAssetPack(sourceRoot);
    const planPath = path.join(sourceRoot, 'production.json');
    const plan = JSON.parse(await fs.readFile(planPath, 'utf8')) as {
      delivery: {timeline: {durationFrames: number}};
      shots: Array<{deliveryTimeline: {durationFrames: number}}>;
    };
    plan.delivery.timeline.durationFrames = 600;
    plan.shots[0]!.deliveryTimeline.durationFrames = 600;
    await fs.writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
    await sharp({
      create: {width: 640, height: 720, channels: 4, background: {r: 50, g: 90, b: 80, alpha: 1}},
    }).png().toFile(path.join(sourceRoot, 'assets', 'shots', 'shot-01', 'structure.png'));

    const inspection = await service.inspectPaperProject(created.id, sourceRoot);
    expect(inspection.readyForCreation).toBe(false);
    expect(inspection.blockingReason).toBe('PAPER_COLLAGE_NON_BACKGROUND_ALPHA_REQUIRED');
    await expect(service.attachPaperProject(created.id, sourceRoot))
      .rejects.toThrow('PAPER_COLLAGE_NON_BACKGROUND_ALPHA_REQUIRED');
  });
});

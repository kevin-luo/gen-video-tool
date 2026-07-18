import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {
  prepareMutedPaperProject,
  runPaperCollageProduction,
  type PaperCollageCommand,
} from '../../../scripts/paper-collage-production.ts';

const temporaryDirectories: string[] = [];

const makeTemporaryDirectory = async (): Promise<string> => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paper-collage-production-'));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await fs.rm(directory, {recursive: true, force: true});
  }));
});

const writeProject = async (
  creationRoot: string,
  overrides: {bgm?: unknown; burnIn?: unknown; shotKind?: string; durationFrames?: number; voice?: boolean} = {},
): Promise<void> => {
  const projectRoot = path.join(creationRoot, 'paper-project');
  await fs.mkdir(projectRoot, {recursive: true});
  await fs.writeFile(path.join(creationRoot, 'creation.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'creation-paper-test',
    durationSeconds: 5,
    voice: overrides.voice ?? true,
    script: '纸片组装测试',
  }), 'utf8');
  await fs.writeFile(path.join(projectRoot, 'production.json'), JSON.stringify({
    schemaVersion: 3,
    projectId: 'paper-test',
    delivery: {
      timeline: {fps: 24, durationFrames: overrides.durationFrames ?? 120},
      video: {path: 'generated/final/paper-test.mp4'},
      subtitles: {path: 'generated/final/paper-test.srt', burnIn: overrides.burnIn ?? false},
      bgm: overrides.bgm ?? null,
    },
    shots: [{kind: overrides.shotKind ?? 'layered-collage'}],
  }), 'utf8');
};

const fakeRunner = (calls: PaperCollageCommand[]) => async (command: PaperCollageCommand) => {
  calls.push(command);
  if (command.kind === 'render') {
    const renderRoot = command.args.at(-1);
    if (!renderRoot) throw new Error('TEST_RENDER_ROOT_MISSING');
    await fs.writeFile(path.join(renderRoot, 'paper-test.mp4'), 'fake-mp4', 'utf8');
    await fs.writeFile(path.join(renderRoot, 'paper-test.srt'), '1\n00:00:00,000 --> 00:00:01,000\n纸片\n', 'utf8');
  }
  return {stdout: '', stderr: ''};
};

describe('paper-collage-production', () => {
  it('requires the creator paper project and never falls back to FastWan', async () => {
    const root = await makeTemporaryDirectory();
    const creationRoot = path.join(root, 'creation');
    const outputRoot = path.join(root, 'output');
    await fs.mkdir(creationRoot, {recursive: true});
    await fs.writeFile(path.join(creationRoot, 'creation.json'), JSON.stringify({id: 'missing-paper'}), 'utf8');
    const calls: PaperCollageCommand[] = [];

    await expect(runPaperCollageProduction(creationRoot, outputRoot, {
      runCommand: fakeRunner(calls),
      makeThumbnail: async () => undefined,
    })).rejects.toThrow('PAPER_COLLAGE_ASSET_PROJECT_REQUIRED');
    expect(calls).toHaveLength(0);
    await expect(fs.access(outputRoot)).rejects.toThrow();
  });

  it('runs local synthesis then Remotion render, creates thumbnail, and publishes canonical sidecar outputs', async () => {
    const root = await makeTemporaryDirectory();
    const creationRoot = path.join(root, 'creation');
    const outputRoot = path.join(root, 'output');
    await fs.mkdir(creationRoot, {recursive: true});
    await writeProject(creationRoot);
    const calls: PaperCollageCommand[] = [];
    const result = await runPaperCollageProduction(creationRoot, outputRoot, {
      runCommand: fakeRunner(calls),
      makeThumbnail: async (_videoPath, thumbnailPath) => {
        await fs.writeFile(thumbnailPath, 'fake-thumbnail', 'utf8');
      },
    });

    expect(calls.map((call) => call.kind)).toEqual(['synthesize', 'render']);
    expect(calls[0]?.args.at(-1)).toBe(path.join(creationRoot, 'paper-project'));
    expect(calls[1]?.args.at(-2)).toBe(path.join(creationRoot, 'paper-project'));
    expect(result).toMatchObject({
      status: 'paper-collage-complete',
      durationSeconds: 5,
      videoPath: 'final.mp4',
      subtitlePath: 'final.srt',
      thumbnailPath: 'thumbnail.jpg',
      bgm: null,
      subtitlesBurnIn: false,
      voice: true,
      hasAudio: true,
    });
    await expect(fs.readFile(path.join(outputRoot, 'final.mp4'), 'utf8')).resolves.toBe('fake-mp4');
    await expect(fs.readFile(path.join(outputRoot, 'final.srt'), 'utf8')).resolves.toContain('纸片');
    await expect(fs.readFile(path.join(outputRoot, 'thumbnail.jpg'), 'utf8')).resolves.toBe('fake-thumbnail');
  });

  it('skips F5 and publishes an audio-free MP4 when voice is disabled', async () => {
    const root = await makeTemporaryDirectory();
    const creationRoot = path.join(root, 'creation');
    const outputRoot = path.join(root, 'output');
    await fs.mkdir(creationRoot, {recursive: true});
    await writeProject(creationRoot, {voice: false});
    const calls: PaperCollageCommand[] = [];
    let preparedProjectRoot: string | undefined;
    let removedAudio = false;
    const result = await runPaperCollageProduction(creationRoot, outputRoot, {
      runCommand: fakeRunner(calls),
      prepareMutedNarration: async (projectRoot) => { preparedProjectRoot = projectRoot; },
      removeAudio: async (_videoPath, mutedVideoPath) => {
        removedAudio = true;
        await fs.writeFile(mutedVideoPath, 'fake-muted-mp4', 'utf8');
      },
      makeThumbnail: async (_videoPath, thumbnailPath) => {
        await fs.writeFile(thumbnailPath, 'fake-thumbnail', 'utf8');
      },
    });

    expect(calls.map((call) => call.kind)).toEqual(['render']);
    expect(preparedProjectRoot).toBe(path.join(creationRoot, 'paper-project'));
    expect(removedAudio).toBe(true);
    expect(result).toMatchObject({voice: false, hasAudio: false, subtitlePath: 'final.srt'});
    await expect(fs.readFile(path.join(outputRoot, 'final.mp4'), 'utf8')).resolves.toBe('fake-muted-mp4');
    await expect(fs.readFile(path.join(outputRoot, 'final.srt'), 'utf8')).resolves.toContain('纸片');
  });

  it('prepares renderer-compatible silence and the authored sidecar without F5', async () => {
    const root = await makeTemporaryDirectory();
    const projectRoot = path.join(root, 'paper-project');
    await fs.cp(path.join(process.cwd(), 'examples', 'cat-noodle-collage-v1'), projectRoot, {recursive: true});

    await prepareMutedPaperProject(projectRoot);

    const wav = await fs.readFile(path.join(projectRoot, 'generated', 'audio', 'narration.wav'));
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.length).toBe(1_920_044);
    const state = JSON.parse(await fs.readFile(
      path.join(projectRoot, 'generated', 'production-state.json'),
      'utf8',
    )) as {narration: {status: string; durationSeconds: number; speechDurationSeconds: number}};
    expect(state.narration).toMatchObject({
      status: 'complete',
      durationSeconds: 20,
      speechDurationSeconds: 0.004,
    });
    const [authoredSrt, generatedSrt] = await Promise.all([
      fs.readFile(path.join(projectRoot, 'subtitles.srt'), 'utf8'),
      fs.readFile(path.join(projectRoot, 'generated', 'final', 'cat-noodle-collage.srt'), 'utf8'),
    ]);
    expect(generatedSrt).toBe(authoredSrt);
  });

  it('rejects projects that request BGM or burned subtitles before spawning either stage', async () => {
    for (const overrides of [{bgm: 'music.mp3'}, {burnIn: true}]) {
      const root = await makeTemporaryDirectory();
      const creationRoot = path.join(root, 'creation');
      const outputRoot = path.join(root, 'output');
      await fs.mkdir(creationRoot, {recursive: true});
      await writeProject(creationRoot, overrides);
      const calls: PaperCollageCommand[] = [];
      await expect(runPaperCollageProduction(creationRoot, outputRoot, {
        runCommand: fakeRunner(calls),
        makeThumbnail: async () => undefined,
      })).rejects.toThrow('PAPER_COLLAGE_DELIVERY_CONTRACT_INVALID:NO_BGM_OR_BURN_IN_REQUIRED');
      expect(calls).toHaveLength(0);
    }
  });

  it('rejects generated shots and creation-duration mismatches before starting local work', async () => {
    for (const overrides of [{shotKind: 'generated-performance'}, {durationFrames: 96}]) {
      const root = await makeTemporaryDirectory();
      const creationRoot = path.join(root, 'creation');
      const outputRoot = path.join(root, 'output');
      await fs.mkdir(creationRoot, {recursive: true});
      await writeProject(creationRoot, overrides);
      const calls: PaperCollageCommand[] = [];
      await expect(runPaperCollageProduction(creationRoot, outputRoot, {
        runCommand: fakeRunner(calls),
        makeThumbnail: async () => undefined,
      })).rejects.toThrow(/PAPER_COLLAGE_(GENERATED_SHOTS_FORBIDDEN|DURATION_MISMATCH)/u);
      expect(calls).toHaveLength(0);
    }
  });

  it('does not publish partial final files when rendering fails', async () => {
    const root = await makeTemporaryDirectory();
    const creationRoot = path.join(root, 'creation');
    const outputRoot = path.join(root, 'output');
    await fs.mkdir(creationRoot, {recursive: true});
    await writeProject(creationRoot);
    const calls: PaperCollageCommand[] = [];
    await expect(runPaperCollageProduction(creationRoot, outputRoot, {
      runCommand: async (command) => {
        calls.push(command);
        if (command.kind === 'render') throw new Error('render failed');
        return {stdout: '', stderr: ''};
      },
      makeThumbnail: async () => undefined,
    })).rejects.toThrow('render failed');
    expect(calls.map((call) => call.kind)).toEqual(['synthesize', 'render']);
    await expect(fs.access(path.join(outputRoot, 'final.mp4'))).rejects.toThrow();
  });
});

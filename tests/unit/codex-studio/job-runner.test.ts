import path from 'node:path';
import {describe, expect, it} from 'vitest';

import {buildJobCommand, meaningfulJobError, parseJobProgress, tryParseJobResult} from '../../../apps/codex-studio/src/job-runner';

const config = {
  repositoryRoot: path.resolve('F:/video/gen-video-tool'),
  dataRoot: path.resolve('F:/video/gen-video-tool/.desktop-data'),
  projectsRoot: path.resolve('F:/video/gen-video-tool/.desktop-data/projects'),
  outputRoot: path.resolve('F:/video/gen-video-tool/.desktop-data/output'),
};

describe('Codex Studio jobs', () => {
  it('builds shell-free local production commands with arguments kept separate', () => {
    const command = buildJobCommand(config, {action: 'generate-shot', projectId: 'cat-noodle-v3', shotId: 'heat-wok'}, 'node');
    expect(command.executable).toBe('node');
    expect(command.args).toContain('generate');
    expect(command.args).toContain(path.join(config.projectsRoot, 'cat-noodle-v3'));
    expect(command.args.at(-1)).toBe('heat-wok');
    expect(command.args.join(' ')).not.toContain('&&');
  });

  it('keeps render output inside the studio output root', () => {
    const command = buildJobCommand(config, {action: 'render-project', projectId: 'cat-noodle-v3'});
    expect(command.args.at(-1)).toBe(path.join(config.outputRoot, 'cat-noodle-v3'));
  });

  it('builds one recoverable creator-mode production command', () => {
    const command = buildJobCommand(config, {action: 'produce-video', projectId: 'creation-20260718120000-abcd1234'});
    expect(command.args).toContain(path.join(config.repositoryRoot, 'scripts', 'paper-collage-production.ts'));
    expect(command.args.at(-2)).toBe(path.join(config.dataRoot, 'creations', 'creation-20260718120000-abcd1234'));
    expect(command.args.at(-1)).toBe(path.join(config.outputRoot, 'creation-20260718120000-abcd1234'));
  });

  it('requests a bounded runtime summary for MCP and browser consumers', () => {
    const command = buildJobCommand(config, {action: 'detect-runtime', projectId: 'cat-noodle-v3'});
    expect(command.args.at(-1)).toBe('--summary');
  });

  it('reads provider percentages and JSON render progress monotonically', () => {
    expect(parseJobProgress('[candidate-a] running 42%', 0.1)).toBe(0.42);
    expect(parseJobProgress('{"event":"render-progress","progress":0.8}', 0.2)).toBe(0.8);
    expect(parseJobProgress('{"event":"quick-progress","progress":0.55,"stage":"generate-visuals"}', 0.2)).toBe(0.55);
    expect(parseJobProgress('{"event":"paper-collage-progress","progress":0.64,"stage":"render-paper-collage"}', 0.2)).toBe(0.64);
    expect(parseJobProgress('{"event":"quick-progress","progress":0.4,"detail":"镜头 3/6 · 94%"}', 0.2)).toBe(0.4);
    expect(parseJobProgress('running 5%', 0.7)).toBe(0.7);
  });

  it('extracts the terminal JSON object after progress events', () => {
    expect(tryParseJobResult('{"event":"render-progress","progress":0.5}\n{"event":"render-complete","videoPath":"final.mp4"}')).toEqual({
      event: 'render-complete',
      videoPath: 'final.mp4',
    });
  });

  it('shows the actionable process error instead of the final stack frame', () => {
    expect(meaningfulJobError([
      {at: '2026-07-18T00:00:00.000Z', stream: 'stderr', text: 'Error: QUICK_PRODUCTION_FFMPEG_FAILED:No such filter: fps'},
      {at: '2026-07-18T00:00:00.001Z', stream: 'stderr', text: '    at async main (quick-production.ts:306:42)'},
    ], 'fallback')).toBe('Error: QUICK_PRODUCTION_FFMPEG_FAILED:No such filter: fps');
  });
});

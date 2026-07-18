import path from 'node:path';
import {describe, expect, it} from 'vitest';

import {buildJobCommand, parseJobProgress, tryParseJobResult} from '../../../apps/codex-studio/src/job-runner';

const config = {
  repositoryRoot: path.resolve('F:/video/gen-video-tool'),
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

  it('requests a bounded runtime summary for MCP and browser consumers', () => {
    const command = buildJobCommand(config, {action: 'detect-runtime', projectId: 'cat-noodle-v3'});
    expect(command.args.at(-1)).toBe('--summary');
  });

  it('reads provider percentages and JSON render progress monotonically', () => {
    expect(parseJobProgress('[candidate-a] running 42%', 0.1)).toBe(0.42);
    expect(parseJobProgress('{"event":"render-progress","progress":0.8}', 0.2)).toBe(0.8);
    expect(parseJobProgress('running 5%', 0.7)).toBe(0.7);
  });

  it('extracts the terminal JSON object after progress events', () => {
    expect(tryParseJobResult('{"event":"render-progress","progress":0.5}\n{"event":"render-complete","videoPath":"final.mp4"}')).toEqual({
      event: 'render-complete',
      videoPath: 'final.mp4',
    });
  });
});

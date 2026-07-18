import path from 'node:path';
import {describe, expect, it} from 'vitest';

import {assertSafeId, resolveInside} from '../../../apps/codex-studio/src/path-safety';

describe('Codex Studio path safety', () => {
  it('accepts opaque production ids and resolves portable media paths', () => {
    expect(assertSafeId('cat-noodle-v3', 'PROJECT_ID')).toBe('cat-noodle-v3');
    const root = path.resolve('F:/video/projects/cat-noodle-v3');
    expect(resolveInside(root, 'generated/video/shot-01.mp4')).toBe(path.join(root, 'generated', 'video', 'shot-01.mp4'));
  });

  it.each(['../secret', '..\\secret', 'C:\\secret.mp4', '/etc/passwd', ''])('rejects media traversal: %s', (value) => {
    expect(() => resolveInside('F:/video/projects/cat-noodle-v3', value)).toThrow();
  });

  it.each(['../project', 'project/name', 'project name', '.hidden'])('rejects unsafe ids: %s', (value) => {
    expect(() => assertSafeId(value, 'PROJECT_ID')).toThrow('PROJECT_ID_INVALID');
  });
});

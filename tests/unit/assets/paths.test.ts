import {describe, expect, it} from 'vitest';
import {
  DEFAULT_IMPORT_LIMITS,
  normalizeAssetPath,
  PathCollisionTracker,
} from '@gen-video-tool/asset-pack';

describe('asset path normalization', () => {
  it.each([
    ['../outside.png', 'PATH_TRAVERSAL'],
    ['safe/../../outside.png', 'PATH_TRAVERSAL'],
    ['C:\\temp\\asset.png', 'PATH_DRIVE_LETTER'],
    ['\\\\server\\share\\asset.png', 'PATH_UNC'],
    ['/etc/passwd', 'PATH_ABSOLUTE'],
    ['safe/CON.png', 'PATH_RESERVED_NAME'],
    ['safe/file.png:stream', 'PATH_INVALID_CHARACTER'],
  ])('rejects %s', (candidate, code) => {
    const result = normalizeAssetPath(candidate, DEFAULT_IMPORT_LIMITS);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((item) => item.code === code && item.severity === 'error')).toBe(true);
  });

  it('normalizes a benign backslash while preserving a warning', () => {
    const result = normalizeAssetPath('shots\\shot-01\\plate.png', DEFAULT_IMPORT_LIMITS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.normalized).toBe('shots/shot-01/plate.png');
    expect(result.diagnostics.map((item) => item.code)).toContain('PATH_BACKSLASH_NORMALIZED');
  });

  it('detects case and Unicode normalization collisions', () => {
    const tracker = new PathCollisionTracker();
    const first = normalizeAssetPath('Characters/Caf\u00e9.png', DEFAULT_IMPORT_LIMITS);
    const second = normalizeAssetPath('characters/Cafe\u0301.png', DEFAULT_IMPORT_LIMITS);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(tracker.add(first.value)).toBeNull();
    expect(tracker.add(second.value)?.code).toBe('PATH_COLLISION');
  });
});

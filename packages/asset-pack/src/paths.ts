import path from 'node:path';
import {diagnostic} from './diagnostics';
import type {
  AssetPackDiagnostic,
  ImportLimits,
  NormalizedAssetPath,
} from './types';

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const DRIVE_PATH = /^[a-zA-Z]:/;
const URI_SCHEME = /^[a-zA-Z][a-zA-Z\d+.-]*:/;

export type PathNormalizationResult =
  | {ok: true; value: NormalizedAssetPath; diagnostics: AssetPackDiagnostic[]}
  | {ok: false; diagnostics: AssetPackDiagnostic[]};

/**
 * Normalize an untrusted archive/reference path without ever resolving it
 * against a host path. The canonical form mirrors Windows' case-insensitive,
 * trailing-dot/space behavior so a pack cannot hide collisions from another OS.
 */
export const normalizeAssetPath = (
  input: string,
  limits: Pick<ImportLimits, 'maxPathLength' | 'maxSegmentLength'>,
): PathNormalizationResult => {
  const diagnostics: AssetPackDiagnostic[] = [];
  if (!input || input.trim().length === 0) {
    return {ok: false, diagnostics: [diagnostic('PATH_EMPTY', 'error', '资源路径不能为空。')]};
  }
  if (input.includes('\0')) {
    return {
      ok: false,
      diagnostics: [diagnostic('PATH_INVALID_CHARACTER', 'error', '资源路径包含 NUL 字符。', {assetPath: input})],
    };
  }
  if (input.startsWith('\\\\') || input.startsWith('//')) {
    return {
      ok: false,
      diagnostics: [diagnostic('PATH_UNC', 'error', '不允许 UNC 或网络路径。', {
        assetPath: input,
        suggestion: '请把资源放入资产包，并使用相对 POSIX 路径。',
      })],
    };
  }
  if (DRIVE_PATH.test(input)) {
    return {
      ok: false,
      diagnostics: [diagnostic('PATH_DRIVE_LETTER', 'error', '不允许 Windows 盘符路径。', {
        assetPath: input,
        suggestion: '请使用相对于资产包根目录的路径。',
      })],
    };
  }
  if (path.posix.isAbsolute(input) || path.win32.isAbsolute(input)) {
    return {
      ok: false,
      diagnostics: [diagnostic('PATH_ABSOLUTE', 'error', '不允许绝对路径。', {assetPath: input})],
    };
  }
  if (URI_SCHEME.test(input)) {
    return {
      ok: false,
      diagnostics: [diagnostic('PATH_ABSOLUTE', 'error', '资产引用必须是本地相对路径，不能是 URI。', {assetPath: input})],
    };
  }

  const usedBackslashes = input.includes('\\');
  const withSlashes = input.replace(/\\/g, '/');
  if (usedBackslashes) {
    diagnostics.push(diagnostic(
      'PATH_BACKSLASH_NORMALIZED',
      'warning',
      '反斜杠路径已规范化为 POSIX 斜杠。',
      {assetPath: input, suggestion: '生成资产包时请始终使用 `/`。'},
    ));
  }

  const rawSegments = withSlashes.split('/');
  if (rawSegments.some((segment) => segment === '')) {
    return {
      ok: false,
      diagnostics: [...diagnostics, diagnostic('PATH_INVALID_CHARACTER', 'error', '路径包含空片段或重复斜杠。', {assetPath: input})],
    };
  }
  if (rawSegments.some((segment) => segment === '..')) {
    return {
      ok: false,
      diagnostics: [...diagnostics, diagnostic('PATH_TRAVERSAL', 'error', '路径包含 `..`，可能逃逸资产包。', {
        assetPath: input,
      })],
    };
  }
  if (rawSegments.some((segment) => segment === '.')) {
    return {
      ok: false,
      diagnostics: [...diagnostics, diagnostic('PATH_TRAVERSAL', 'error', '路径不能包含 `.` 片段。', {assetPath: input})],
    };
  }
  const segments = rawSegments.filter((segment) => segment !== '' && segment !== '.');
  if (segments.length === 0) {
    return {ok: false, diagnostics: [...diagnostics, diagnostic('PATH_EMPTY', 'error', '资源路径归一化后为空。', {assetPath: input})]};
  }

  for (const segment of segments) {
    if (segment.length > limits.maxSegmentLength) {
      return {ok: false, diagnostics: [...diagnostics, diagnostic('PATH_TOO_LONG', 'error', '资源路径片段过长。', {assetPath: input})]};
    }
    if (/[<>:"|?*\u0000-\u001f]/u.test(segment)) {
      return {ok: false, diagnostics: [...diagnostics, diagnostic('PATH_INVALID_CHARACTER', 'error', '资源路径包含跨平台不安全字符。', {assetPath: input})]};
    }
    if (WINDOWS_RESERVED.test(segment) || segment.endsWith('.') || segment.endsWith(' ')) {
      return {ok: false, diagnostics: [...diagnostics, diagnostic('PATH_RESERVED_NAME', 'error', '资源路径使用了 Windows 保留名或尾随点/空格。', {assetPath: input})]};
    }
  }

  const original = segments.join('/');
  const normalized = original.normalize('NFC');
  if (normalized.length > limits.maxPathLength) {
    return {ok: false, diagnostics: [...diagnostics, diagnostic('PATH_TOO_LONG', 'error', '资源路径过长。', {assetPath: input})]};
  }
  const canonical = normalized
    .split('/')
    .map((segment) => segment.normalize('NFC').replace(/[. ]+$/u, '').toLowerCase())
    .join('/');
  return {ok: true, value: {original, normalized, canonical, usedBackslashes}, diagnostics};
};

export const isPathInside = (root: string, candidate: string): boolean => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

export const resolveAssetPath = (root: string, relativePath: string): string | null => {
  const resolved = path.resolve(root, ...relativePath.split('/'));
  return isPathInside(root, resolved) ? resolved : null;
};

export class PathCollisionTracker {
  readonly #seen = new Map<string, NormalizedAssetPath>();

  add(pathValue: NormalizedAssetPath): AssetPackDiagnostic | null {
    const previous = this.#seen.get(pathValue.canonical);
    if (previous !== undefined && previous.original !== pathValue.original) {
      return diagnostic('PATH_COLLISION', 'error', `资源路径与“${previous.original}”在大小写或 Unicode 规范化后冲突。`, {
        assetPath: pathValue.normalized,
        suggestion: '请为每个文件使用大小写和 Unicode 形式均唯一的路径。',
      });
    }
    if (previous !== undefined) {
      return diagnostic('PATH_COLLISION', 'error', `资产包重复包含“${pathValue.normalized}”。`, {
        assetPath: pathValue.normalized,
        suggestion: '删除重复 ZIP 条目或重复目录项。',
      });
    }
    this.#seen.set(pathValue.canonical, pathValue);
    return null;
  }
}

/** Detect conflicting directory spellings even when the leaf files differ. */
export class PathHierarchyCollisionTracker {
  readonly #seen = new Map<string, string>();

  add(pathValue: NormalizedAssetPath): AssetPackDiagnostic | null {
    const originalSegments = pathValue.original.split('/');
    const normalizedSegments = pathValue.normalized.split('/');
    const canonicalSegments = pathValue.canonical.split('/');
    for (let index = 0; index < canonicalSegments.length; index += 1) {
      const canonical = canonicalSegments.slice(0, index + 1).join('/');
      const original = originalSegments.slice(0, index + 1).join('/');
      const normalized = normalizedSegments.slice(0, index + 1).join('/');
      const previous = this.#seen.get(canonical);
      if (previous !== undefined && previous !== original) {
        return diagnostic('PATH_COLLISION', 'error', `路径层级“${original}”与“${previous}”在大小写或 Unicode 规范化后冲突。`, {
          assetPath: normalized,
          suggestion: '统一目录的大小写和 Unicode 拼写，再重新打包。',
        });
      }
      this.#seen.set(canonical, original);
    }
    return null;
  }
}

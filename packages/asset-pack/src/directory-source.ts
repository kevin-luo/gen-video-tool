import {copyFile, lstat, mkdir, readdir, realpath, stat} from 'node:fs/promises';
import path from 'node:path';
import {diagnostic} from './diagnostics';
import {isPathInside, normalizeAssetPath, PathCollisionTracker, PathHierarchyCollisionTracker, resolveAssetPath} from './paths';
import type {AssetPackDiagnostic, ImportLimits} from './types';
import type {ExtractionSummary} from './zip-source';

export const copyDirectoryToStaging = async (
  sourceRoot: string,
  stagingRoot: string,
  limits: ImportLimits,
): Promise<ExtractionSummary> => {
  const diagnostics: AssetPackDiagnostic[] = [];
  let resolvedRoot: string;
  try {
    resolvedRoot = await realpath(sourceRoot);
    const sourceStats = await stat(resolvedRoot);
    if (!sourceStats.isDirectory()) {
      return {relativeFiles: [], totalBytes: 0, diagnostics: [diagnostic('SOURCE_NOT_DIRECTORY', 'error', '目录导入源不是目录。')]};
    }
  } catch {
    return {relativeFiles: [], totalBytes: 0, diagnostics: [diagnostic('SOURCE_NOT_FOUND', 'error', '找不到资产包目录。')]};
  }

  const tracker = new PathCollisionTracker();
  const hierarchyTracker = new PathHierarchyCollisionTracker();
  const relativeFiles: string[] = [];
  const activeDirectories = new Set<string>();
  let totalBytes = 0;
  let entryCount = 0;

  const walk = async (physicalDirectory: string, logicalDirectory: string): Promise<void> => {
    let resolvedDirectory: string;
    try {
      resolvedDirectory = await realpath(physicalDirectory);
    } catch {
      diagnostics.push(diagnostic('SOURCE_FILE_UNSUPPORTED', 'error', '无法解析目录项。', {assetPath: logicalDirectory || null}));
      return;
    }
    if (!isPathInside(resolvedRoot, resolvedDirectory)) {
      diagnostics.push(diagnostic('SYMLINK_OUTSIDE_SOURCE', 'error', '目录链接指向资产包以外。', {assetPath: logicalDirectory || null}));
      return;
    }
    const canonicalDirectory = process.platform === 'win32' ? resolvedDirectory.toLowerCase() : resolvedDirectory;
    if (activeDirectories.has(canonicalDirectory)) {
      diagnostics.push(diagnostic('SYMLINK_CYCLE', 'error', '目录链接形成循环。', {assetPath: logicalDirectory || null}));
      return;
    }
    activeDirectories.add(canonicalDirectory);
    let entries;
    try {
      entries = await readdir(resolvedDirectory, {withFileTypes: true});
    } catch {
      diagnostics.push(diagnostic('SOURCE_FILE_UNSUPPORTED', 'error', '无法读取资产包目录。', {assetPath: logicalDirectory || null}));
      activeDirectories.delete(canonicalDirectory);
      return;
    }
    for (const entry of entries) {
      entryCount += 1;
      if (entryCount > limits.maxEntries) {
        diagnostics.push(diagnostic('ZIP_TOO_MANY_ENTRIES', 'error', `目录条目数超过安全上限 ${limits.maxEntries}。`));
        break;
      }
      const logicalPath = logicalDirectory ? `${logicalDirectory}/${entry.name}` : entry.name;
      const normalized = normalizeAssetPath(logicalPath, limits);
      diagnostics.push(...normalized.diagnostics);
      if (!normalized.ok) continue;
      const hierarchyCollision = hierarchyTracker.add(normalized.value);
      if (hierarchyCollision) {
        diagnostics.push(hierarchyCollision);
        continue;
      }
      const physicalPath = path.join(resolvedDirectory, entry.name);
      let entryStats;
      try {
        entryStats = await lstat(physicalPath);
      } catch {
        diagnostics.push(diagnostic('SOURCE_FILE_UNSUPPORTED', 'error', '无法读取目录项元数据。', {assetPath: normalized.value.normalized}));
        continue;
      }
      let resolvedEntry = physicalPath;
      if (entryStats.isSymbolicLink()) {
        try {
          resolvedEntry = await realpath(physicalPath);
        } catch {
          diagnostics.push(diagnostic('SOURCE_FILE_UNSUPPORTED', 'error', '符号链接已损坏。', {assetPath: normalized.value.normalized}));
          continue;
        }
        if (!isPathInside(resolvedRoot, resolvedEntry)) {
          diagnostics.push(diagnostic('SYMLINK_OUTSIDE_SOURCE', 'error', '符号链接或 junction 指向资产包以外。', {
            assetPath: normalized.value.normalized,
            suggestion: '请复制真实文件到资产包中，不要引用外部路径。',
          }));
          continue;
        }
        diagnostics.push(diagnostic('SOURCE_SYMLINK', 'warning', '已解析资产包内部符号链接；提交后会保存为普通文件或目录。', {assetPath: normalized.value.normalized}));
      }
      let targetStats;
      try {
        targetStats = await stat(resolvedEntry);
      } catch {
        diagnostics.push(diagnostic('SOURCE_FILE_UNSUPPORTED', 'error', '链接目标不可读。', {assetPath: normalized.value.normalized}));
        continue;
      }
      if (targetStats.isDirectory()) {
        await walk(resolvedEntry, normalized.value.normalized);
        continue;
      }
      if (!targetStats.isFile()) {
        diagnostics.push(diagnostic('SOURCE_FILE_UNSUPPORTED', 'error', '仅允许普通文件和目录。', {assetPath: normalized.value.normalized}));
        continue;
      }
      const collision = tracker.add(normalized.value);
      if (collision) {
        diagnostics.push(collision);
        continue;
      }
      if (targetStats.size > limits.maxEntryBytes) {
        diagnostics.push(diagnostic('ZIP_ENTRY_TOO_LARGE', 'error', '文件超过单文件导入上限。', {assetPath: normalized.value.normalized}));
        continue;
      }
      totalBytes += targetStats.size;
      if (totalBytes > limits.maxTotalBytes) {
        diagnostics.push(diagnostic('ZIP_TOTAL_TOO_LARGE', 'error', '目录总大小超过导入上限。'));
        break;
      }
      const outputPath = resolveAssetPath(stagingRoot, normalized.value.normalized);
      if (!outputPath) {
        diagnostics.push(diagnostic('PATH_TRAVERSAL', 'error', '目录项解析后逃逸 staging 目录。', {assetPath: normalized.value.normalized}));
        continue;
      }
      await mkdir(path.dirname(outputPath), {recursive: true});
      await copyFile(resolvedEntry, outputPath);
      relativeFiles.push(normalized.value.normalized);
    }
    activeDirectories.delete(canonicalDirectory);
  };

  await walk(resolvedRoot, '');
  return {relativeFiles, totalBytes, diagnostics};
};

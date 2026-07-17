import {lstat, realpath, rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {copyDirectoryToStaging} from './directory-source';
import {diagnostic, hasBlockingDiagnostics, sortDiagnostics} from './diagnostics';
import {isPathInside, normalizeAssetPath} from './paths';
import {cleanupStagingDirectory, createStagingDirectory} from './staging';
import type {
  AssetPackDiagnostic,
  AssetPackImportResult,
  AssetPackInspection,
  AssetPackSource,
  ImportAssetPackRequest,
  ImportLimits,
  InspectAssetPackRequest,
} from './types';
import {DEFAULT_IMPORT_LIMITS} from './types';
import {validateStagedAssetPack, type ValidationSummary} from './validate';
import {extractZipToStaging, type ExtractionSummary} from './zip-source';

const mergeLimits = (overrides?: Partial<ImportLimits>): ImportLimits => ({
  ...DEFAULT_IMPORT_LIMITS,
  ...overrides,
});

interface PipelineResult {
  extraction: ExtractionSummary;
  validation: ValidationSummary | null;
}

const extractAndValidate = async (
  source: AssetPackSource,
  stagingRoot: string,
  limits: ImportLimits,
): Promise<PipelineResult> => {
  const extraction = source.kind === 'zip'
    ? await extractZipToStaging(source.path, stagingRoot, limits)
    : await copyDirectoryToStaging(source.path, stagingRoot, limits);
  if (hasBlockingDiagnostics(extraction.diagnostics)) return {extraction, validation: null};
  const validation = await validateStagedAssetPack(stagingRoot, extraction.relativeFiles, limits);
  return {extraction, validation};
};

const asInspection = (
  source: AssetPackSource,
  pipeline: PipelineResult,
  extraDiagnostics: AssetPackDiagnostic[] = [],
): AssetPackInspection => {
  const diagnostics = sortDiagnostics([
    ...pipeline.extraction.diagnostics,
    ...(pipeline.validation?.diagnostics ?? []),
    ...extraDiagnostics,
  ]);
  return {
    status: hasBlockingDiagnostics(diagnostics) ? 'rejected' : 'ready',
    diagnostics,
    projectId: pipeline.validation?.projectId ?? null,
    title: pipeline.validation?.title ?? null,
    shotCount: pipeline.validation?.shotCount ?? 0,
    sourceKind: source.kind,
    fileCount: pipeline.extraction.relativeFiles.length,
    totalBytes: pipeline.extraction.totalBytes,
    videoDurationSeconds: pipeline.validation?.videoDurationSeconds ?? null,
    audioDurationSeconds: pipeline.validation?.audioDurationSeconds ?? null,
    productionSchemaVersion: pipeline.validation?.productionSchemaVersion ?? null,
    generatedPerformanceShotCount: pipeline.validation?.generatedPerformanceShotCount ?? 0,
  };
};

const cleanupWithDiagnostic = async (stagingRoot: string): Promise<AssetPackDiagnostic[]> => {
  try {
    await cleanupStagingDirectory(stagingRoot);
    return [];
  } catch {
    return [diagnostic('STAGING_CLEANUP_FAILED', 'warning', '临时 staging 目录清理失败。', {
      suggestion: '关闭占用资源文件的程序后，清理项目目录中的 `.import-*.staging`。',
    })];
  }
};

/** Validate an asset pack without leaving files behind or changing project state. */
export const inspectAssetPack = async (
  request: InspectAssetPackRequest,
): Promise<AssetPackInspection> => {
  const limits = mergeLimits(request.limits);
  let stagingRoot: string | null = null;
  let pipeline: PipelineResult = {
    extraction: {relativeFiles: [], totalBytes: 0, diagnostics: []},
    validation: null,
  };
  const extraDiagnostics: AssetPackDiagnostic[] = [];
  try {
    stagingRoot = await createStagingDirectory(path.join(tmpdir(), 'gen-video-tool-inspection'));
    pipeline = await extractAndValidate(request.source, stagingRoot, limits);
  } catch (error) {
    void error;
    extraDiagnostics.push(diagnostic('IMPORT_FAILED', 'error', '资产包检查失败。', {
      suggestion: '确认源文件可读后重试；若仍失败，请保留资产包用于诊断。',
    }));
  } finally {
    if (stagingRoot) extraDiagnostics.push(...await cleanupWithDiagnostic(stagingRoot));
  }
  return asInspection(request.source, pipeline, extraDiagnostics);
};

const destinationExists = async (destination: string): Promise<boolean> => {
  try {
    await lstat(destination);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
};

/**
 * Extract, validate and atomically rename a fully valid pack into projectsRoot.
 * A rejected import never creates or modifies the destination project.
 */
export const importAssetPack = async (
  request: ImportAssetPackRequest,
): Promise<AssetPackImportResult> => {
  const limits = mergeLimits(request.limits);
  let stagingRoot: string | null = null;
  let committedPath: string | null = null;
  let pipeline: PipelineResult = {
    extraction: {relativeFiles: [], totalBytes: 0, diagnostics: []},
    validation: null,
  };
  const extraDiagnostics: AssetPackDiagnostic[] = [];
  try {
    if (request.source.kind === 'directory') {
      try {
        const sourceRoot = await realpath(request.source.path);
        let projectsRoot = path.resolve(request.projectsRoot);
        try {
          projectsRoot = await realpath(request.projectsRoot);
        } catch {
          // A not-yet-created destination is compared lexically below.
        }
        const overlaps = isPathInside(sourceRoot, projectsRoot) ||
          isPathInside(path.resolve(request.source.path), path.resolve(request.projectsRoot));
        if (overlaps) {
          extraDiagnostics.push(diagnostic('SOURCE_DESTINATION_OVERLAP', 'error', '项目存储目录位于导入源目录内部，会导致递归导入。', {
            suggestion: '请选择资产包目录之外的项目存储位置。',
          }));
        }
      } catch {
        // The source reader below produces the stable SOURCE_NOT_FOUND diagnostic.
      }
    }
    if (!hasBlockingDiagnostics(extraDiagnostics)) {
      stagingRoot = await createStagingDirectory(request.projectsRoot);
      pipeline = await extractAndValidate(request.source, stagingRoot, limits);
    }
    const preliminary = asInspection(request.source, pipeline);
    if (preliminary.status !== 'rejected' && pipeline.validation?.projectId && stagingRoot) {
      const destinationName = request.destinationName ?? pipeline.validation.projectId;
      const normalizedDestination = normalizeAssetPath(destinationName, limits);
      if (!normalizedDestination.ok || normalizedDestination.value.normalized.includes('/')) {
        extraDiagnostics.push(diagnostic('PATH_INVALID_CHARACTER', 'error', '项目目录名必须是安全的单个相对路径片段。', {
          assetPath: destinationName,
          suggestion: '使用项目 id 作为目录名，仅包含字母、数字、下划线或连字符。',
        }));
      } else {
        const destination = path.join(path.dirname(stagingRoot), normalizedDestination.value.normalized);
        if (await destinationExists(destination)) {
          extraDiagnostics.push(diagnostic('DESTINATION_EXISTS', 'error', '目标项目目录已存在，导入未覆盖任何内容。', {
            assetPath: normalizedDestination.value.normalized,
            suggestion: '选择新的项目名，或先在项目首页明确删除旧项目。',
          }));
        } else {
          try {
            await rename(pipeline.validation.contentRoot, destination);
            committedPath = destination;
          } catch (error) {
            void error;
            extraDiagnostics.push(diagnostic('ATOMIC_COMMIT_FAILED', 'error', '项目原子提交失败。', {
              suggestion: '确认项目目录可写、目标名称未被其他进程占用后重试。',
            }));
          }
        }
      }
    }
  } catch (error) {
    void error;
    extraDiagnostics.push(diagnostic('IMPORT_FAILED', 'error', '资产包导入失败。', {
      suggestion: '确认源文件与项目目录可读写后重试。',
    }));
  } finally {
    if (stagingRoot && stagingRoot !== committedPath) {
      extraDiagnostics.push(...await cleanupWithDiagnostic(stagingRoot));
    }
  }

  const inspection = asInspection(request.source, pipeline, extraDiagnostics);
  if (!committedPath || inspection.status === 'rejected') {
    return {...inspection, status: 'rejected', projectPath: null};
  }
  return {...inspection, status: 'committed', projectPath: committedPath};
};

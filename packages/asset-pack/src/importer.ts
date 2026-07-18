import {lstat, realpath, rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {ProductionPlan} from '@gen-video-tool/video-generation';
import sharp from 'sharp';
import {copyDirectoryToStaging} from './directory-source';
import {diagnostic, hasBlockingDiagnostics, sortDiagnostics} from './diagnostics';
import {validateImage} from './media';
import {isPathInside, normalizeAssetPath, resolveAssetPath} from './paths';
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

export type AssetPackPlanInspection = {
  inspection: AssetPackInspection;
  /** Parsed authoritative plan, returned only by the explicit plan-aware inspector. */
  productionPlan: ProductionPlan | null;
};

export type InspectAssetPackWithPlanOptions = {
  /**
   * Paper-creation-only cutout gate. Besides requiring an Alpha channel, every
   * non-background layer must have transparent corners and meaningful clear
   * boundary space so an opaque RGBA rectangle (or a token transparent pixel)
   * cannot masquerade as a prepared cutout.
   * Ordinary project inspection/import keeps its prior alpha policy.
   */
  requireAlphaForNonBackground?: boolean;
};

const TRANSPARENT_ALPHA_MAX = 4;

const hasTransparentCutoutBoundary = async (absolutePath: string): Promise<boolean> => {
  const metadata = await sharp(absolutePath, {failOn: 'error'}).metadata();
  if (!metadata.hasAlpha || metadata.width === undefined || metadata.height === undefined) return false;
  const {width, height} = metadata;
  const {data, info} = await sharp(absolutePath, {failOn: 'error'})
    .toColourspace('srgb')
    .ensureAlpha()
    .raw()
    .toBuffer({resolveWithObject: true});
  const alphaAt = (x: number, y: number): number => (
    data[(y * width + x) * info.channels + info.channels - 1] ?? 255
  );
  const corners = [
    alphaAt(0, 0),
    alphaAt(width - 1, 0),
    alphaAt(0, height - 1),
    alphaAt(width - 1, height - 1),
  ];
  if (!corners.every((alpha) => alpha <= TRANSPARENT_ALPHA_MAX)) return false;

  let transparent = 0;
  let boundaryPixels = 0;
  for (let x = 0; x < width; x += 1) {
    boundaryPixels += 2;
    if (alphaAt(x, 0) <= TRANSPARENT_ALPHA_MAX) transparent += 1;
    if (alphaAt(x, height - 1) <= TRANSPARENT_ALPHA_MAX) transparent += 1;
  }
  for (let y = 1; y < height - 1; y += 1) {
    boundaryPixels += 2;
    if (alphaAt(0, y) <= TRANSPARENT_ALPHA_MAX) transparent += 1;
    if (alphaAt(width - 1, y) <= TRANSPARENT_ALPHA_MAX) transparent += 1;
  }
  return transparent >= Math.max(4, Math.ceil(boundaryPixels * 0.05));
};

const validateCutoutTransparency = async (
  absolutePath: string,
  assetPath: string,
  jsonPath: string,
): Promise<AssetPackDiagnostic[]> => {
  try {
    if (await hasTransparentCutoutBoundary(absolutePath)) return [];
    return [diagnostic('IMAGE_ALPHA_REQUIRED', 'error', '纸片资源必须在外边缘包含真实透明像素。', {
      path: jsonPath,
      assetPath,
      suggestion: '请抠除背景并在画布外缘保留透明留白；不能用全不透明 RGBA 图片或半透明矩形冒充纸片抠图。',
    })];
  } catch {
    return [diagnostic('IMAGE_ALPHA_REQUIRED', 'error', '无法确认纸片资源具有真实透明边缘。', {
      path: jsonPath,
      assetPath,
      suggestion: '请重新导出带透明留白的 PNG 后重试。',
    })];
  }
};

/**
 * Plan-aware inspection for callers that apply a stricter product-mode gate.
 * It still cleans staging before returning and never changes project state.
 */
export const inspectAssetPackWithPlan = async (
  request: InspectAssetPackRequest,
  options: InspectAssetPackWithPlanOptions = {},
): Promise<AssetPackPlanInspection> => {
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
    if (
      options.requireAlphaForNonBackground === true
      && pipeline.validation?.productionPlan !== null
      && pipeline.validation?.productionPlan !== undefined
    ) {
      const checked = new Set<string>();
      for (const [shotIndex, shot] of pipeline.validation.productionPlan.shots.entries()) {
        if (shot.kind !== 'layered-collage') continue;
        for (const [layerIndex, layer] of shot.layers.entries()) {
          if (layer.role === 'background' || checked.has(layer.assetPath)) continue;
          checked.add(layer.assetPath);
          const absolutePath = resolveAssetPath(pipeline.validation.contentRoot, layer.assetPath);
          if (absolutePath === null) continue;
          const jsonPath = `/shots/${shotIndex}/layers/${layerIndex}/assetPath`;
          extraDiagnostics.push(...await validateImage({
            assetPath: layer.assetPath,
            absolutePath,
            requireAlpha: true,
            jsonPath,
          }, limits));
          extraDiagnostics.push(...await validateCutoutTransparency(
            absolutePath,
            layer.assetPath,
            jsonPath,
          ));
        }
      }
    }
  } catch (error) {
    void error;
    extraDiagnostics.push(diagnostic('IMPORT_FAILED', 'error', '资产包检查失败。', {
      suggestion: '确认源文件可读后重试；若仍失败，请保留资产包用于诊断。',
    }));
  } finally {
    if (stagingRoot) extraDiagnostics.push(...await cleanupWithDiagnostic(stagingRoot));
  }
  return {
    inspection: asInspection(request.source, pipeline, extraDiagnostics),
    productionPlan: pipeline.validation?.productionPlan === null || pipeline.validation?.productionPlan === undefined
      ? null
      : structuredClone(pipeline.validation.productionPlan),
  };
};

/** Validate an asset pack without leaving files behind or changing project state. */
export const inspectAssetPack = async (
  request: InspectAssetPackRequest,
): Promise<AssetPackInspection> => (await inspectAssetPackWithPlan(request)).inspection;

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

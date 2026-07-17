import {
  parseProductionPlan,
  type ProductionPlan,
} from '@gen-video-tool/video-generation';
import {diagnostic} from './diagnostics';
import {probeAudio, readUtf8Text, validateImage, type ExpectedImageMetadata} from './media';
import {normalizeAssetPath, resolveAssetPath} from './paths';
import type {AssetPackDiagnostic, ImportLimits} from './types';

interface ZodLikeIssue {
  path?: PropertyKey[];
  message?: string;
}

interface ZodLikeError {
  issues?: ZodLikeIssue[];
}

export interface ValidationSummary {
  contentRoot: string;
  relativeFiles: string[];
  productionPlan: ProductionPlan | null;
  projectId: string | null;
  title: string | null;
  shotCount: number;
  diagnostics: AssetPackDiagnostic[];
  videoDurationSeconds: number | null;
  /** Duration of the local F5 reference voice, not generated narration. */
  audioDurationSeconds: number | null;
  productionSchemaVersion: 3 | null;
  generatedPerformanceShotCount: number;
}

const jsonPointer = (segments: readonly PropertyKey[]): string => `/${segments
  .map((segment) => String(segment).replace(/~/gu, '~0').replace(/\//gu, '~1'))
  .join('/')}`;

const productionPlanDiagnostics = (error: unknown): AssetPackDiagnostic[] => {
  const issues = (error as ZodLikeError)?.issues;
  if (!Array.isArray(issues) || issues.length === 0) {
    return [diagnostic(
      'PRODUCTION_PLAN_INVALID',
      'error',
      error instanceof Error ? error.message : 'production.json 不符合 v3 生产契约。',
      {
        assetPath: 'production.json',
        suggestion: '请使用当前 create-gen-video-asset-pack Skill 重新生成资产包。',
      },
    )];
  }
  return issues.map((issue) => {
    const message = issue.message ?? '字段无效。';
    const duplicate = /duplicate/iu.test(message);
    return diagnostic(
      duplicate ? 'DUPLICATE_ID' : 'PRODUCTION_PLAN_INVALID',
      'error',
      message,
      {
        path: jsonPointer(issue.path ?? []),
        assetPath: 'production.json',
        suggestion: duplicate
          ? '请确保同一集合内的 id、seed 与输出路径唯一。'
          : '请按当前 v3 production.json 契约修正字段、类型和跨字段约束。',
      },
    );
  });
};

const parseJsonFile = async (
  absolutePath: string,
): Promise<{value: unknown; diagnostics: AssetPackDiagnostic[]}> => {
  try {
    return {value: JSON.parse(await readUtf8Text(absolutePath)) as unknown, diagnostics: []};
  } catch {
    return {
      value: null,
      diagnostics: [diagnostic('JSON_CORRUPT', 'error', 'production.json 损坏或 JSON 语法无效。', {
        assetPath: 'production.json',
        suggestion: '请去掉注释、尾随逗号，并确认文件使用 UTF-8 编码。',
      })],
    };
  }
};

/** Locate the one v3 project root, allowing one optional top-level wrapper directory. */
const locateContentRoot = (
  stagingRoot: string,
  extractedFiles: readonly string[],
): {contentRoot: string; relativeFiles: string[]; diagnostics: AssetPackDiagnostic[]} => {
  const diagnostics: AssetPackDiagnostic[] = [];
  const candidates = extractedFiles.filter((file) => file === 'production.json' || file.endsWith('/production.json'));
  if (candidates.length === 0) {
    return {
      contentRoot: stagingRoot,
      relativeFiles: [...extractedFiles],
      diagnostics: [diagnostic('PRODUCTION_PLAN_MISSING', 'error', '资产包中缺少根 production.json。', {
        assetPath: 'production.json',
        suggestion: '把 production.json 放在资产包根目录，或唯一的顶层包装目录中。',
      })],
    };
  }
  if (candidates.length > 1) {
    return {
      contentRoot: stagingRoot,
      relativeFiles: [...extractedFiles],
      diagnostics: [diagnostic('PRODUCTION_PLAN_MULTIPLE', 'error', '资产包中存在多个 production.json，无法确定唯一项目根。', {
        suggestion: '一个 ZIP 或目录只能包含一个 v3 项目。',
      })],
    };
  }

  const productionPath = candidates[0]!;
  if (productionPath.split('/').length > 2) {
    return {
      contentRoot: stagingRoot,
      relativeFiles: [...extractedFiles],
      diagnostics: [diagnostic(
        'PRODUCTION_PLAN_INVALID',
        'error',
        'production.json 只能位于资产包根目录或唯一的一层包装目录中。',
        {
          assetPath: productionPath,
          suggestion: '移除多余的嵌套目录，让 production.json 成为根文件或“包装目录/production.json”。',
        },
      )],
    };
  }
  const prefix = productionPath === 'production.json' ? '' : productionPath.slice(0, -'production.json'.length);
  const relativeFiles: string[] = [];
  for (const file of extractedFiles) {
    if (!prefix || file.startsWith(prefix)) {
      relativeFiles.push(prefix ? file.slice(prefix.length) : file);
    } else {
      diagnostics.push(diagnostic('UNREFERENCED_FILE', 'warning', '该文件位于项目包装目录之外，提交时不会包含。', {
        assetPath: file,
        suggestion: '从 ZIP 中删除包装目录之外的多余文件。',
      }));
    }
  }
  return {
    contentRoot: prefix ? (resolveAssetPath(stagingRoot, prefix.slice(0, -1)) ?? stagingRoot) : stagingRoot,
    relativeFiles,
    diagnostics,
  };
};

/** Produce path-specific security diagnostics before Zod collapses them into a generic schema issue. */
const preflightPathFields = (
  value: unknown,
  limits: ImportLimits,
  pointer: PropertyKey[] = [],
): AssetPackDiagnostic[] => {
  if (Array.isArray(value)) {
    return value.flatMap((child, index) => preflightPathFields(child, limits, [...pointer, index]));
  }
  if (typeof value !== 'object' || value === null) return [];
  const diagnostics: AssetPackDiagnostic[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPointer = [...pointer, key];
    if (/path$/iu.test(key) && typeof child === 'string') {
      const result = normalizeAssetPath(child, limits);
      diagnostics.push(...result.diagnostics.map((item) => ({
        ...item,
        path: jsonPointer(childPointer),
        assetPath: child,
      })));
    } else {
      diagnostics.push(...preflightPathFields(child, limits, childPointer));
    }
  }
  return diagnostics;
};

const IMAGE_EXTENSION = /\.(?:png|jpe?g|webp|gif|avif|tiff?)$/iu;

const emptySummary = (
  contentRoot: string,
  relativeFiles: string[],
  diagnostics: AssetPackDiagnostic[],
): ValidationSummary => ({
  contentRoot,
  relativeFiles,
  productionPlan: null,
  projectId: null,
  title: null,
  shotCount: 0,
  diagnostics,
  videoDurationSeconds: null,
  audioDurationSeconds: null,
  productionSchemaVersion: null,
  generatedPerformanceShotCount: 0,
});

export const validateStagedAssetPack = async (
  stagingRoot: string,
  extractedFiles: readonly string[],
  limits: ImportLimits,
): Promise<ValidationSummary> => {
  const located = locateContentRoot(stagingRoot, extractedFiles);
  const diagnostics = [...located.diagnostics];
  const files = new Set(located.relativeFiles);
  const referenced = new Set<string>(['production.json']);

  for (const assetPath of files) {
    if (assetPath.toLocaleLowerCase('en-US').startsWith('generated/')) {
      diagnostics.push(diagnostic(
        'GENERATED_ARTIFACT_FORBIDDEN',
        'error',
        '源资产包不得包含生成候选、可变状态、旁白输出或最终成片。',
        {
          assetPath,
          suggestion: '删除 generated/。桌面工具会在导入后创建并管理该目录。',
        },
      ));
    }
  }

  if (!files.has('production.json')) {
    return emptySummary(located.contentRoot, located.relativeFiles, diagnostics);
  }

  const productionAbsolutePath = resolveAssetPath(located.contentRoot, 'production.json');
  if (!productionAbsolutePath) throw new Error('Invariant: production.json escaped content root.');
  const productionJson = await parseJsonFile(productionAbsolutePath);
  diagnostics.push(...productionJson.diagnostics);
  diagnostics.push(...preflightPathFields(productionJson.value, limits));

  let productionPlan: ProductionPlan | null = null;
  if (productionJson.diagnostics.length === 0) {
    try {
      productionPlan = parseProductionPlan(productionJson.value);
    } catch (error) {
      diagnostics.push(...productionPlanDiagnostics(error));
    }
  }

  const addInputReference = (referencePath: string, pointer: string): string | null => {
    const normalized = normalizeAssetPath(referencePath, limits);
    diagnostics.push(...normalized.diagnostics.map((item) => ({...item, path: pointer, assetPath: referencePath})));
    if (!normalized.ok) return null;
    const normalizedPath = normalized.value.normalized;
    referenced.add(normalizedPath);
    if (!files.has(normalizedPath)) {
      diagnostics.push(diagnostic('REFERENCE_MISSING', 'error', 'production.json 引用的输入资源不存在。', {
        path: pointer,
        assetPath: normalizedPath,
        suggestion: '补齐文件，并确保路径大小写与 production.json 完全一致。',
      }));
      return null;
    }
    return normalizedPath;
  };

  const images = new Map<string, ExpectedImageMetadata>();
  const registerImage = (
    assetPath: string,
    pointer: string,
    requireAlpha: boolean,
    dimensions?: {width: number; height: number},
  ): void => {
    const absolutePath = resolveAssetPath(located.contentRoot, assetPath);
    if (!absolutePath) {
      diagnostics.push(diagnostic('REFERENCE_OUTSIDE_PACK', 'error', '图片引用逃逸资产包根目录。', {path: pointer, assetPath}));
      return;
    }
    const current = images.get(assetPath);
    if (
      current
      && dimensions
      && current.declaredWidth !== undefined
      && current.declaredHeight !== undefined
      && (current.declaredWidth !== dimensions.width || current.declaredHeight !== dimensions.height)
    ) {
      diagnostics.push(diagnostic('IMAGE_DIMENSIONS_MISMATCH', 'error', '同一关键帧被声明为两组不同的原生生成尺寸。', {
        path: pointer,
        assetPath,
        suggestion: '为不同 WanGP 原生分辨率导出独立关键帧文件。',
      }));
      return;
    }
    images.set(assetPath, {
      assetPath,
      absolutePath,
      requireAlpha: requireAlpha || current?.requireAlpha === true,
      ...(dimensions
        ? {declaredWidth: dimensions.width, declaredHeight: dimensions.height}
        : current?.declaredWidth === undefined
          ? {}
          : {declaredWidth: current.declaredWidth, declaredHeight: current.declaredHeight}),
      jsonPath: current?.jsonPath ?? pointer,
    });
  };

  let audioDurationSeconds: number | null = null;
  if (productionPlan) {
    for (const [shotIndex, shot] of productionPlan.shots.entries()) {
      const basePointer = `/shots/${shotIndex}`;
      if (shot.kind === 'layered-collage') {
        for (const [layerIndex, layer] of shot.layers.entries()) {
          const pointer = `${basePointer}/layers/${layerIndex}/assetPath`;
          const assetPath = addInputReference(layer.assetPath, pointer);
          if (assetPath) {
            registerImage(
              assetPath,
              pointer,
              ['actor', 'prop', 'foreground', 'overlay'].includes(layer.role),
            );
          }
        }
        continue;
      }

      const {conditioning, raster} = shot.generation;
      const startPointer = `${basePointer}/generation/conditioning/startKeyframePath`;
      const startPath = addInputReference(conditioning.startKeyframePath, startPointer);
      if (startPath) registerImage(startPath, startPointer, false, raster);
      if (conditioning.mode === 'start-end') {
        const endPointer = `${basePointer}/generation/conditioning/endKeyframePath`;
        const endPath = addInputReference(conditioning.endKeyframePath, endPointer);
        if (endPath) registerImage(endPath, endPointer, false, raster);
      }

      for (const [propIndex, prop] of shot.hybridMotion.deterministicProps.entries()) {
        const pointer = `${basePointer}/hybridMotion/deterministicProps/${propIndex}/assetPath`;
        const assetPath = addInputReference(prop.assetPath, pointer);
        if (assetPath) registerImage(assetPath, pointer, true);
      }

      if (shot.occlusion.mode === 'local-matte' && shot.occlusion.foregroundAssetPath) {
        const pointer = `${basePointer}/occlusion/foregroundAssetPath`;
        const assetPath = addInputReference(shot.occlusion.foregroundAssetPath, pointer);
        if (assetPath) registerImage(assetPath, pointer, true);
      }
    }

    const referenceAudioPath = addInputReference(
      productionPlan.narration.referenceAudioPath,
      '/narration/referenceAudioPath',
    );
    if (referenceAudioPath) {
      const referenceAudioAbsolutePath = resolveAssetPath(located.contentRoot, referenceAudioPath);
      if (referenceAudioAbsolutePath) {
        const audio = await probeAudio(referenceAudioAbsolutePath, referenceAudioPath);
        diagnostics.push(...audio.diagnostics);
        audioDurationSeconds = audio.durationSeconds;
      }
    }
  }

  // Validate every raster payload, including unused images, before atomic commit.
  for (const assetPath of files) {
    if (IMAGE_EXTENSION.test(assetPath) && !images.has(assetPath)) {
      const absolutePath = resolveAssetPath(located.contentRoot, assetPath);
      if (absolutePath) images.set(assetPath, {assetPath, absolutePath, requireAlpha: false});
    }
  }
  const imageDiagnostics = await Promise.all([...images.values()].map((image) => validateImage(image, limits)));
  diagnostics.push(...imageDiagnostics.flat());

  for (const assetPath of files) {
    if (!referenced.has(assetPath)) {
      diagnostics.push(diagnostic('UNREFERENCED_FILE', 'warning', '文件未被 production.json 作为输入资源引用。', {
        assetPath,
        suggestion: '删除多余文件，或在 v3 生产计划中显式引用。',
      }));
    }
  }

  if (!productionPlan) {
    return emptySummary(located.contentRoot, located.relativeFiles, diagnostics);
  }

  return {
    contentRoot: located.contentRoot,
    relativeFiles: located.relativeFiles,
    productionPlan,
    projectId: productionPlan.projectId,
    title: productionPlan.metadata.title,
    shotCount: productionPlan.shots.length,
    diagnostics,
    videoDurationSeconds: productionPlan.delivery.timeline.durationFrames / productionPlan.delivery.timeline.fps,
    audioDurationSeconds,
    productionSchemaVersion: 3,
    generatedPerformanceShotCount: productionPlan.shots.filter((shot) => shot.kind === 'generated-performance').length,
  };
};

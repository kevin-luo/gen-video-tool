import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {
  parseManifestDocument,
  parseProjectDocument,
  parseShotDocument,
  rigSchema,
  type ManifestDocument,
  type ProjectDocument,
  type Rig,
  type ShotDocument,
} from '@gen-video-tool/schema';
import {diagnostic} from './diagnostics';
import {probeAudio, readUtf8Text, validateImage, type ExpectedImageMetadata} from './media';
import {normalizeAssetPath, resolveAssetPath} from './paths';
import {parseSrt} from './srt';
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
  project: ProjectDocument | null;
  projectId: string | null;
  title: string | null;
  shotCount: number;
  diagnostics: AssetPackDiagnostic[];
  videoDurationSeconds: number | null;
  audioDurationSeconds: number | null;
}

const jsonPointer = (segments: readonly PropertyKey[]): string => `/${segments
  .map((segment) => String(segment).replace(/~/gu, '~0').replace(/\//gu, '~1'))
  .join('/')}`;

const schemaDiagnostics = (
  error: unknown,
  assetPath: string,
  prefix: readonly PropertyKey[] = [],
): AssetPackDiagnostic[] => {
  const issues = (error as ZodLikeError)?.issues;
  if (!Array.isArray(issues) || issues.length === 0) {
    return [diagnostic('SCHEMA_INVALID', 'error', error instanceof Error ? error.message : 'JSON 不符合资产包 schema。', {
      assetPath,
      suggestion: '请使用当前版本的 ChatGPT Asset Director 重新生成 JSON。',
    })];
  }
  return issues.map((issue) => {
    const message = issue.message ?? '字段无效。';
    return diagnostic(
      /duplicate/i.test(message) ? 'DUPLICATE_ID' : 'SCHEMA_INVALID',
      'error',
      message,
      {
        path: jsonPointer([...prefix, ...(issue.path ?? [])]),
        assetPath,
        suggestion: /duplicate/i.test(message)
          ? '请确保同一集合内每个 id 唯一。'
          : '请按 ASSET_SCHEMA.md 修正字段、类型或约束。',
      },
    );
  });
};

const parseJsonFile = async (
  absolutePath: string,
  assetPath: string,
): Promise<{value: unknown; diagnostics: AssetPackDiagnostic[]}> => {
  try {
    return {value: JSON.parse(await readUtf8Text(absolutePath)) as unknown, diagnostics: []};
  } catch {
    return {
      value: null,
      diagnostics: [diagnostic('JSON_CORRUPT', 'error', 'JSON 文件损坏或语法无效。', {
        assetPath,
        suggestion: '请去掉注释、尾随逗号并确认文件使用 UTF-8 编码。',
      })],
    };
  }
};

const locateContentRoot = (
  stagingRoot: string,
  extractedFiles: readonly string[],
): {contentRoot: string; relativeFiles: string[]; diagnostics: AssetPackDiagnostic[]} => {
  const diagnostics: AssetPackDiagnostic[] = [];
  const candidates = extractedFiles.filter((file) => file === 'manifest.json' || file.endsWith('/manifest.json'));
  if (candidates.length === 0) {
    return {contentRoot: stagingRoot, relativeFiles: [...extractedFiles], diagnostics: [diagnostic('MANIFEST_MISSING', 'error', '资产包中缺少 manifest.json。', {
      assetPath: 'manifest.json',
      suggestion: '请把 manifest.json 放在资产包根目录，或唯一的顶层包装目录中。',
    })]};
  }
  if (candidates.length > 1) {
    return {contentRoot: stagingRoot, relativeFiles: [...extractedFiles], diagnostics: [diagnostic('MANIFEST_MULTIPLE', 'error', '资产包中存在多个 manifest.json，无法确定项目根目录。', {
      suggestion: '一个 ZIP 或目录只能包含一个项目。',
    })]};
  }
  const manifestPath = candidates[0];
  if (!manifestPath) return {contentRoot: stagingRoot, relativeFiles: [...extractedFiles], diagnostics};
  const prefix = manifestPath === 'manifest.json' ? '' : manifestPath.slice(0, -'manifest.json'.length);
  const relativeFiles: string[] = [];
  for (const file of extractedFiles) {
    if (!prefix || file.startsWith(prefix)) {
      relativeFiles.push(prefix ? file.slice(prefix.length) : file);
    } else {
      diagnostics.push(diagnostic('UNREFERENCED_FILE', 'warning', '该文件位于项目包装目录之外，提交时不会包含。', {
        assetPath: file,
        suggestion: '请从 ZIP 中删除多余文件。',
      }));
    }
  }
  return {
    contentRoot: prefix ? (resolveAssetPath(stagingRoot, prefix.slice(0, -1)) ?? stagingRoot) : stagingRoot,
    relativeFiles,
    diagnostics,
  };
};

const preflightPathFields = (
  value: unknown,
  limits: ImportLimits,
  assetPath: string,
  pointer: PropertyKey[] = [],
): AssetPackDiagnostic[] => {
  const diagnostics: AssetPackDiagnostic[] = [];
  if (Array.isArray(value)) {
    value.forEach((child, index) => diagnostics.push(...preflightPathFields(child, limits, assetPath, [...pointer, index])));
    return diagnostics;
  }
  if (typeof value !== 'object' || value === null) return diagnostics;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPointer = [...pointer, key];
    if (/path$/iu.test(key) && typeof child === 'string') {
      const result = normalizeAssetPath(child, limits);
      for (const item of result.diagnostics) {
        diagnostics.push({...item, path: jsonPointer(childPointer), assetPath: child});
      }
    } else {
      diagnostics.push(...preflightPathFields(child, limits, assetPath, childPointer));
    }
  }
  return diagnostics.map((item) => item.assetPath === null ? {...item, assetPath} : item);
};

const IMAGE_EXTENSION = /\.(?:png|jpe?g|webp|gif|avif|tiff?)$/iu;

export const validateStagedAssetPack = async (
  stagingRoot: string,
  extractedFiles: readonly string[],
  limits: ImportLimits,
): Promise<ValidationSummary> => {
  const located = locateContentRoot(stagingRoot, extractedFiles);
  const diagnostics = [...located.diagnostics];
  const files = new Set(located.relativeFiles);
  const referenced = new Set<string>(['manifest.json']);
  if (!files.has('manifest.json')) {
    return {
      contentRoot: located.contentRoot,
      relativeFiles: located.relativeFiles,
      project: null,
      projectId: null,
      title: null,
      shotCount: 0,
      diagnostics,
      videoDurationSeconds: null,
      audioDurationSeconds: null,
    };
  }

  const manifestAbsolutePath = resolveAssetPath(located.contentRoot, 'manifest.json');
  if (!manifestAbsolutePath) throw new Error('Invariant: manifest escaped content root.');
  const manifestJson = await parseJsonFile(manifestAbsolutePath, 'manifest.json');
  diagnostics.push(...manifestJson.diagnostics);
  diagnostics.push(...preflightPathFields(manifestJson.value, limits, 'manifest.json'));
  let manifest: ManifestDocument | null = null;
  if (manifestJson.diagnostics.length === 0) {
    try {
      manifest = parseManifestDocument(manifestJson.value);
    } catch (error) {
      diagnostics.push(...schemaDiagnostics(error, 'manifest.json'));
    }
  }
  if (!manifest) {
    return {
      contentRoot: located.contentRoot,
      relativeFiles: located.relativeFiles,
      project: null,
      projectId: null,
      title: null,
      shotCount: 0,
      diagnostics,
      videoDurationSeconds: null,
      audioDurationSeconds: null,
    };
  }

  const addReference = (
    referencePath: string,
    pointer: string,
    options: {missingCode?: 'REFERENCE_MISSING' | 'ACTOR_ASSET_MISSING' | 'MESH_RIG_MISSING'} = {},
  ): string | null => {
    const normalized = normalizeAssetPath(referencePath, limits);
    if (!normalized.ok) {
      diagnostics.push(...normalized.diagnostics.map((item) => ({...item, path: pointer, assetPath: referencePath})));
      return null;
    }
    diagnostics.push(...normalized.diagnostics.map((item) => ({...item, path: pointer, assetPath: referencePath})));
    const normalizedPath = normalized.value.normalized;
    referenced.add(normalizedPath);
    if (!files.has(normalizedPath)) {
      diagnostics.push(diagnostic(options.missingCode ?? 'REFERENCE_MISSING', 'error', 'JSON 引用的资源文件不存在。', {
        path: pointer,
        assetPath: normalizedPath,
        suggestion: '请补齐文件，并确保路径大小写与 manifest/shot JSON 完全一致。',
      }));
      return null;
    }
    return normalizedPath;
  };

  const shots: ShotDocument[] = [];
  const images = new Map<string, ExpectedImageMetadata>();
  const registerImage = (
    assetPath: string,
    jsonPath: string,
    requireAlpha: boolean,
    dimensions?: {width: number; height: number},
  ): void => {
    const absolutePath = resolveAssetPath(located.contentRoot, assetPath);
    if (!absolutePath) {
      diagnostics.push(diagnostic('REFERENCE_OUTSIDE_PACK', 'error', '资源引用逃逸资产包根目录。', {path: jsonPath, assetPath}));
      return;
    }
    const current = images.get(assetPath);
    images.set(assetPath, {
      assetPath,
      absolutePath,
      requireAlpha: requireAlpha || current?.requireAlpha === true,
      ...(dimensions ? {declaredWidth: dimensions.width, declaredHeight: dimensions.height} : {}),
      jsonPath,
    });
  };

  for (const [shotIndex, shotReference] of manifest.shots.entries()) {
    const pointer = `/shots/${shotIndex}/path`;
    const shotPath = addReference(shotReference.path, pointer);
    if (!shotPath) continue;
    const shotAbsolute = resolveAssetPath(located.contentRoot, shotPath);
    if (!shotAbsolute) continue;
    const shotJson = await parseJsonFile(shotAbsolute, shotPath);
    diagnostics.push(...shotJson.diagnostics);
    diagnostics.push(...preflightPathFields(shotJson.value, limits, shotPath));
    if (shotJson.diagnostics.length > 0) continue;
    let shot: ShotDocument;
    try {
      shot = parseShotDocument(shotJson.value);
    } catch (error) {
      const rawActors = typeof shotJson.value === 'object' && shotJson.value !== null && Array.isArray((shotJson.value as {actors?: unknown}).actors)
        ? (shotJson.value as {actors: unknown[]}).actors
        : [];
      rawActors.forEach((actor, actorIndex) => {
        if (typeof actor !== 'object' || actor === null) return;
        const raw = actor as Record<string, unknown>;
        if (typeof raw.mode === 'string' && !['rigid', 'mesh', 'pose-cut'].includes(raw.mode)) {
          diagnostics.push(diagnostic('ACTOR_MODE_UNSUPPORTED', 'error', `不支持角色模式“${raw.mode}”。`, {
            path: `/shots/${shotIndex}/actors/${actorIndex}/mode`,
            assetPath: shotPath,
            suggestion: '请使用 rigid、mesh 或 pose-cut；不能使用肢体拆分、flip、fold 或 crossfade。',
          }));
        }
        if (raw.mode === 'pose-cut' && Array.isArray(raw.poses) && raw.poses.length < 2) {
          diagnostics.push(diagnostic('POSE_CUT_TOO_FEW_POSES', 'error', 'Pose Cut 至少需要两个完整人物姿势。', {
            path: `/shots/${shotIndex}/actors/${actorIndex}/poses`, assetPath: shotPath,
          }));
        }
        const transition = raw.transition;
        if (raw.mode === 'pose-cut' && typeof transition === 'object' && transition !== null && (transition as {type?: unknown}).type === 'crossfade') {
          diagnostics.push(diagnostic('POSE_CUT_CROSSFADE_FORBIDDEN', 'error', 'Pose Cut 禁止交叉淡化完整人物。', {
            path: `/shots/${shotIndex}/actors/${actorIndex}/transition/type`, assetPath: shotPath,
            suggestion: '使用硬切或能完全遮住人物切换的纸片/道具转场。',
          }));
        }
        if (raw.mode === 'pose-cut' && Array.isArray(raw.poses)) {
          const visibleCount = raw.poses.filter((pose) => typeof pose === 'object' && pose !== null && (pose as {visible?: unknown}).visible === true).length;
          if (visibleCount > 1) {
            diagnostics.push(diagnostic('POSE_CUT_MULTIPLE_VISIBLE_POSES', 'error', '同一时刻只能显示一个完整 Pose Cut 人物。', {
              path: `/shots/${shotIndex}/actors/${actorIndex}/poses`, assetPath: shotPath,
            }));
          }
        }
      });
      diagnostics.push(...schemaDiagnostics(error, shotPath, ['shots', shotIndex]));
      continue;
    }
    if (shot.id !== shotReference.id) {
      diagnostics.push(diagnostic('SCHEMA_INVALID', 'error', `镜头文件 id“${shot.id}”与 manifest 引用“${shotReference.id}”不一致。`, {
        path: `/shots/${shotIndex}/id`, assetPath: shotPath,
      }));
    }
    shots.push(shot);

    for (const [layerIndex, layer] of shot.layers.entries()) {
      if (!layer.assetPath) continue;
      const jsonPath = `/shots/${shotIndex}/layers/${layerIndex}/assetPath`;
      const assetPath = addReference(layer.assetPath, jsonPath);
      if (assetPath && IMAGE_EXTENSION.test(assetPath)) {
        registerImage(assetPath, jsonPath, ['subject', 'prop', 'foreground', 'overlay'].includes(layer.role));
      }
    }
    for (const [actorIndex, actor] of shot.actors.entries()) {
      const basePointer = `/shots/${shotIndex}/actors/${actorIndex}`;
      if (actor.mode === 'rigid') {
        const assetPath = addReference(actor.sourcePath, `${basePointer}/sourcePath`, {missingCode: 'ACTOR_ASSET_MISSING'});
        if (assetPath) registerImage(assetPath, `${basePointer}/sourcePath`, true);
      } else if (actor.mode === 'pose-cut') {
        for (const [poseIndex, pose] of actor.poses.entries()) {
          const assetPath = addReference(pose.sourcePath, `${basePointer}/poses/${poseIndex}/sourcePath`, {missingCode: 'ACTOR_ASSET_MISSING'});
          if (assetPath) registerImage(assetPath, `${basePointer}/poses/${poseIndex}/sourcePath`, true);
        }
      } else {
        const assetPath = addReference(actor.sourcePath, `${basePointer}/sourcePath`, {missingCode: 'ACTOR_ASSET_MISSING'});
        if (assetPath) registerImage(assetPath, `${basePointer}/sourcePath`, true);
        const rigPath = addReference(actor.rigPath, `${basePointer}/rigPath`, {missingCode: 'MESH_RIG_MISSING'});
        if (!rigPath) continue;
        const rigAbsolute = resolveAssetPath(located.contentRoot, rigPath);
        if (!rigAbsolute) continue;
        const rigJson = await parseJsonFile(rigAbsolute, rigPath);
        diagnostics.push(...rigJson.diagnostics);
        diagnostics.push(...preflightPathFields(rigJson.value, limits, rigPath));
        if (rigJson.diagnostics.length > 0) continue;
        let rig: Rig;
        try {
          rig = rigSchema.parse(rigJson.value);
        } catch (error) {
          diagnostics.push(...schemaDiagnostics(error, rigPath, ['shots', shotIndex, 'actors', actorIndex, 'rig']));
          diagnostics.push(diagnostic('MESH_RIG_INVALID', 'error', 'Mesh Puppet 的 rig.json 无效。', {path: `${basePointer}/rigPath`, assetPath: rigPath}));
          continue;
        }
        const texturePath = addReference(rig.texturePath, `${basePointer}/rig/texturePath`, {missingCode: 'ACTOR_ASSET_MISSING'});
        if (texturePath) registerImage(texturePath, `${basePointer}/rig/texturePath`, true, rig.canvas);
        if (rig.texturePath !== actor.sourcePath) {
          diagnostics.push(diagnostic('MESH_RIG_INVALID', 'error', 'rig.texturePath 必须与 Mesh Actor sourcePath 指向同一张完整人物图。', {
            path: `${basePointer}/rigPath`, assetPath: rigPath,
            suggestion: '修改 rig.json 的 texturePath，避免绑定到错误人物。',
          }));
        }
      }
    }
  }

  let project: ProjectDocument | null = null;
  try {
    project = parseProjectDocument({schemaVersion: 2, manifest, shots});
  } catch (error) {
    diagnostics.push(...schemaDiagnostics(error, 'manifest.json'));
  }

  const standardReferences: Array<[string | undefined, string]> = [
    [manifest.narrationPath, '/narrationPath'],
    [manifest.narrationTextPath, '/narrationTextPath'],
    [manifest.subtitlesPath, '/subtitlesPath'],
    [manifest.styleReferencePath, '/styleReferencePath'],
    [manifest.audio?.narrationPath, '/audio/narrationPath'],
  ];
  for (const [assetPath, pointer] of standardReferences) {
    if (assetPath) addReference(assetPath, pointer);
  }
  if (files.has('narration.txt')) referenced.add('narration.txt');

  const videoDurationSeconds = shots.length === manifest.shots.length
    ? shots.reduce((sum, shot) => sum + shot.durationFrames, 0) / manifest.fps
    : null;
  let audioDurationSeconds: number | null = null;
  const audioPath = manifest.audio?.narrationPath ?? manifest.narrationPath;
  if (audioPath && files.has(audioPath)) {
    const absolute = resolveAssetPath(located.contentRoot, audioPath);
    if (absolute) {
      const audio = await probeAudio(absolute, audioPath);
      audioDurationSeconds = audio.durationSeconds;
      diagnostics.push(...audio.diagnostics);
      if (audioDurationSeconds !== null && manifest.audio?.durationSeconds !== undefined && Math.abs(audioDurationSeconds - manifest.audio.durationSeconds) > 0.25) {
        diagnostics.push(diagnostic('AUDIO_DURATION_MISMATCH', 'warning', `JSON 声明时长 ${manifest.audio.durationSeconds.toFixed(2)}s 与实际 ${audioDurationSeconds.toFixed(2)}s 不一致。`, {
          path: '/audio/durationSeconds', assetPath: audioPath,
          suggestion: '以实际音频为准更新 durationSeconds。',
        }));
      }
      if (audioDurationSeconds !== null && videoDurationSeconds !== null && audioDurationSeconds + 0.05 < videoDurationSeconds) {
        diagnostics.push(diagnostic('AUDIO_TOO_SHORT', 'error', `旁白 ${audioDurationSeconds.toFixed(2)}s 短于视频 ${videoDurationSeconds.toFixed(2)}s。`, {
          path: '/audio/narrationPath', assetPath: audioPath,
          suggestion: '延长旁白/静音尾部，或缩短镜头总时长。',
        }));
      }
    }
  }

  const subtitlesPath = manifest.subtitlesPath;
  if (subtitlesPath && files.has(subtitlesPath)) {
    const absolute = resolveAssetPath(located.contentRoot, subtitlesPath);
    if (absolute) {
      try {
        const srt = parseSrt(await readFile(absolute, 'utf8'), subtitlesPath);
        diagnostics.push(...srt.diagnostics);
        const lastCue = srt.cues.at(-1);
        if (lastCue && videoDurationSeconds !== null && lastCue.endMs / 1_000 > videoDurationSeconds + 0.05) {
          diagnostics.push(diagnostic('SRT_OUTSIDE_VIDEO', 'warning', '最后一条字幕超出视频结尾。', {
            path: `/cues/${srt.cues.length - 1}/time`, assetPath: subtitlesPath,
            suggestion: '缩短最后一条字幕或延长镜头。',
          }));
        }
      } catch {
        diagnostics.push(diagnostic('SRT_CORRUPT', 'error', '无法读取 SRT 字幕文件。', {assetPath: subtitlesPath}));
      }
    }
  }

  // Check every image, including unused files, so a corrupt payload cannot be committed unnoticed.
  for (const assetPath of files) {
    if (IMAGE_EXTENSION.test(assetPath) && !images.has(assetPath)) {
      const absolutePath = resolveAssetPath(located.contentRoot, assetPath);
      if (absolutePath) images.set(assetPath, {assetPath, absolutePath, requireAlpha: false});
    }
  }
  const imageDiagnostics = await Promise.all([...images.values()].map((image) => validateImage(image, limits)));
  diagnostics.push(...imageDiagnostics.flat());

  const standardOptionalFiles = new Set(['manifest.json', 'narration.txt', 'style-reference.png', 'subtitles.srt']);
  for (const assetPath of files) {
    if (!referenced.has(assetPath) && !standardOptionalFiles.has(assetPath)) {
      diagnostics.push(diagnostic('UNREFERENCED_FILE', 'warning', '文件未被 manifest、shot 或 rig 引用。', {
        assetPath,
        suggestion: '删除多余文件，或在对应 JSON 中显式引用。',
      }));
    }
  }

  return {
    contentRoot: located.contentRoot,
    relativeFiles: located.relativeFiles,
    project,
    projectId: manifest.projectId,
    title: manifest.title,
    shotCount: project?.shots.length ?? manifest.shots.length,
    diagnostics,
    videoDurationSeconds,
    audioDurationSeconds,
  };
};

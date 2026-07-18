import {createHash, randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {z} from 'zod';
import {
  importAssetPack,
  inspectAssetPackWithPlan,
  type AssetPackSource,
  type AssetPackInspection,
} from '@gen-video-tool/asset-pack';
import type {ProductionPlan} from '@gen-video-tool/video-generation';

import type {StudioConfig} from './config.js';
import {assertSafeId, resolveInside} from './path-safety.js';

export const CREATION_PLATFORMS = ['douyin', 'xiaohongshu', 'wechat-channels'] as const;
export type CreationPlatform = typeof CREATION_PLATFORMS[number];

const creationRecordSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1).max(128),
  title: z.string().min(1).max(80),
  script: z.string().min(1).max(300),
  platform: z.enum(CREATION_PLATFORMS),
  durationSeconds: z.number().int().min(20).max(60),
  voice: z.boolean(),
  subtitles: z.literal('sidecar-srt'),
  bgm: z.literal(false),
  visualMode: z.literal('paper-collage').default('paper-collage'),
  assetStatus: z.enum(['awaiting-assets', 'ready']).default('awaiting-assets'),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  jobId: z.string().uuid().optional(),
});

export type CreationRecord = z.infer<typeof creationRecordSchema>;

export type PaperCollageAssetInspection = AssetPackInspection & {
  readyForCreation: boolean;
  requestedDurationSeconds: number;
  blockingReason?: string;
};

const sourceFromPath = async (sourcePathValue: string): Promise<AssetPackSource> => {
  const sourcePath = path.resolve(sourcePathValue.trim());
  let info: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    info = await fs.lstat(sourcePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('ASSET_SOURCE_NOT_FOUND');
    throw error;
  }
  if (info.isSymbolicLink()) throw new Error('ASSET_SOURCE_SYMLINK');
  if (info.isDirectory()) return {kind: 'directory', path: sourcePath};
  if (info.isFile() && path.extname(sourcePath).toLowerCase() === '.zip') return {kind: 'zip', path: sourcePath};
  throw new Error('ASSET_SOURCE_UNSUPPORTED');
};

const collapseWhitespace = (value: string): string => value.replace(/\s+/gu, ' ').trim();

/**
 * Bind the spoken payload, not its presentation punctuation. NFKC makes
 * full-width/compatibility forms deterministic; punctuation, separators and
 * control characters are ignored so sentence splitting and typography do not
 * make a valid asset pack brittle.
 */
const spokenTextDigest = (value: string): string => createHash('sha256')
  .update(value.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\p{C}]/gu, ''), 'utf8')
  .digest('hex');

const narrationMatchesScript = (plan: ProductionPlan, script: string): boolean => {
  const narrationText = plan.narration.segments.map((segment) => segment.text).join('');
  const canonicalScript = script.normalize('NFKC').replace(/[\p{P}\p{Z}\p{C}]/gu, '');
  const canonicalNarration = narrationText.normalize('NFKC').replace(/[\p{P}\p{Z}\p{C}]/gu, '');
  return canonicalScript.length > 0
    && canonicalNarration.length > 0
    && spokenTextDigest(script) === spokenTextDigest(narrationText);
};

const titleFromScript = (script: string): string => {
  const firstThought = collapseWhitespace(script).split(/[。！？!?；;\n]/u)[0]?.trim() ?? '';
  const title = firstThought || collapseWhitespace(script);
  return Array.from(title).slice(0, 24).join('') || '未命名视频';
};

const datePart = (date: Date): string => date.toISOString().replace(/[-:TZ.]/gu, '').slice(0, 14);

const paperPlanBlockingReason = (plan: ProductionPlan): string | undefined => {
  for (const shot of plan.shots) {
    if (shot.kind !== 'layered-collage') return 'PAPER_COLLAGE_GENERATED_SHOTS_FORBIDDEN';
    const backgrounds = shot.layers.filter((layer) => layer.role === 'background');
    const groups = shot.layers.filter((layer) => layer.role !== 'background');
    if (backgrounds.length !== 1) {
      return `PAPER_COLLAGE_BACKGROUND_COUNT_INVALID:${shot.shotId}:${backgrounds.length}`;
    }
    if (groups.length < 3 || groups.length > 6) {
      return `PAPER_COLLAGE_GROUP_COUNT_INVALID:${shot.shotId}:${groups.length}`;
    }
    const nonPng = groups.find((layer) => !layer.assetPath.toLowerCase().endsWith('.png'));
    if (nonPng !== undefined) {
      return `PAPER_COLLAGE_NON_BACKGROUND_PNG_REQUIRED:${shot.shotId}:${nonPng.id}`;
    }
    const missingAssembly = groups.find((layer) => layer.assembly === undefined);
    if (missingAssembly !== undefined) {
      return `PAPER_COLLAGE_ASSEMBLY_REQUIRED:${shot.shotId}:${missingAssembly.id}`;
    }
    const assemblies = groups.map((layer) => layer.assembly!);
    if (new Set(assemblies.map((assembly) => assembly.startFrame)).size < 3) {
      return `PAPER_COLLAGE_ASSEMBLY_STAGGER_REQUIRED:${shot.shotId}`;
    }
    const lastSettleFrame = Math.max(...assemblies.map((assembly) => (
      assembly.startFrame
      + assembly.durationFrames
      + (assembly.followThrough === undefined
        ? 0
        : assembly.followThrough.delayFrames + assembly.followThrough.durationFrames)
    )));
    if (lastSettleFrame > shot.deliveryTimeline.durationFrames - 6) {
      return `PAPER_COLLAGE_SETTLE_HOLD_REQUIRED:${shot.shotId}:${lastSettleFrame}`;
    }
    const stretched = groups.find(
      (layer) => Math.abs(layer.transform.scaleX - layer.transform.scaleY) > 1e-6,
    );
    if (stretched !== undefined) {
      return `PAPER_COLLAGE_UNIFORM_SCALE_REQUIRED:${shot.shotId}:${stretched.id}`;
    }
  }
  return undefined;
};

export class CreationService {
  readonly #root: string;

  constructor(private readonly config: StudioConfig) {
    this.#root = path.join(config.dataRoot, 'creations');
  }

  async initialize(): Promise<void> {
    await Promise.all([
      fs.mkdir(this.#root, {recursive: true}),
      fs.mkdir(this.config.outputRoot, {recursive: true}),
    ]);
  }

  creationRoot(idValue: string): string {
    return path.join(this.#root, assertSafeId(idValue, 'CREATION_ID'));
  }

  outputRoot(idValue: string): string {
    return path.join(this.config.outputRoot, assertSafeId(idValue, 'CREATION_ID'));
  }

  async create(input: {
    script: string;
    platform: CreationPlatform;
    durationSeconds: number;
    voice: boolean;
  }): Promise<CreationRecord> {
    await this.initialize();
    const script = collapseWhitespace(input.script);
    const now = new Date();
    const id = `creation-${datePart(now)}-${randomUUID().slice(0, 8)}`;
    const record = creationRecordSchema.parse({
      schemaVersion: 1,
      id,
      title: titleFromScript(script),
      script,
      platform: input.platform,
      durationSeconds: input.durationSeconds,
      voice: input.voice,
      subtitles: 'sidecar-srt',
      bgm: false,
      visualMode: 'paper-collage',
      assetStatus: 'awaiting-assets',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    await fs.mkdir(this.creationRoot(id), {recursive: false});
    await this.#write(record);
    return structuredClone(record);
  }

  async get(idValue: string): Promise<CreationRecord> {
    const id = assertSafeId(idValue, 'CREATION_ID');
    try {
      return creationRecordSchema.parse(JSON.parse(await fs.readFile(
        path.join(this.creationRoot(id), 'creation.json'),
        'utf8',
      )));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('CREATION_NOT_FOUND');
      throw error;
    }
  }

  async list(): Promise<CreationRecord[]> {
    await this.initialize();
    const entries = await fs.readdir(this.#root, {withFileTypes: true});
    const records: CreationRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      try {
        records.push(await this.get(entry.name));
      } catch {
        // A directory becomes visible only after its creation manifest validates.
      }
    }
    return records.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async attachJob(idValue: string, jobId: string): Promise<CreationRecord> {
    const record = await this.get(idValue);
    const updated = creationRecordSchema.parse({
      ...record,
      jobId: z.string().uuid().parse(jobId),
      updatedAt: new Date().toISOString(),
    });
    await this.#write(updated);
    return structuredClone(updated);
  }

  /** Validate and atomically attach a v3 paper-collage asset pack to a creation. */
  async attachPaperProject(idValue: string, sourcePathValue: string): Promise<CreationRecord> {
    const record = await this.get(idValue);
    const creationRoot = this.creationRoot(record.id);
    const destination = path.join(creationRoot, 'paper-project');
    try {
      await fs.lstat(destination);
      throw new Error('PAPER_PROJECT_ALREADY_ATTACHED');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const source = await sourceFromPath(sourcePathValue);
    const inspection = await this.inspectPaperSource(record, source);
    if (!inspection.readyForCreation) throw new Error(inspection.blockingReason ?? 'PAPER_COLLAGE_ASSET_PACK_REJECTED:UNKNOWN');
    const imported = await importAssetPack({
      source,
      projectsRoot: creationRoot,
      destinationName: 'paper-project',
    });
    if (imported.status !== 'committed' || imported.projectPath === null) {
      const codes = imported.diagnostics.map((item) => item.code).join(',') || 'UNKNOWN';
      throw new Error(`PAPER_COLLAGE_ASSET_PACK_REJECTED:${codes}`);
    }
    // Re-run the paper-only contract against the imported snapshot. Directory
    // sources can change between preflight and copy; the creation must never
    // become ready from bytes that were not checked by the stricter gate.
    const attachedInspection = await this.inspectPaperSource(record, {
      kind: 'directory',
      path: imported.projectPath,
    });
    if (!attachedInspection.readyForCreation) {
      await fs.rm(imported.projectPath, {recursive: true, force: true});
      throw new Error(attachedInspection.blockingReason ?? 'PAPER_COLLAGE_ASSET_PACK_REJECTED:IMPORTED_SNAPSHOT');
    }
    const updated = creationRecordSchema.parse({
      ...record,
      assetStatus: 'ready',
      updatedAt: new Date().toISOString(),
    });
    try {
      await this.#write(updated);
    } catch (error) {
      await fs.rm(imported.projectPath, {recursive: true, force: true});
      throw error;
    }
    return structuredClone(updated);
  }

  async inspectPaperProject(idValue: string, sourcePathValue: string): Promise<PaperCollageAssetInspection> {
    const record = await this.get(idValue);
    return await this.inspectPaperSource(record, await sourceFromPath(sourcePathValue));
  }

  private async inspectPaperSource(record: CreationRecord, source: AssetPackSource): Promise<PaperCollageAssetInspection> {
    const inspected = await inspectAssetPackWithPlan(
      {source},
      {requireAlphaForNonBackground: true},
    );
    const {inspection, productionPlan} = inspected;
    const paperReason = productionPlan === null ? undefined : paperPlanBlockingReason(productionPlan);
    let blockingReason: string | undefined;
    if (inspection.status !== 'ready') {
      const codes = inspection.diagnostics.map((item) => item.code).join(',') || 'UNKNOWN';
      blockingReason = inspection.diagnostics.some((item) => item.code === 'IMAGE_ALPHA_REQUIRED')
        ? 'PAPER_COLLAGE_NON_BACKGROUND_ALPHA_REQUIRED'
        : `PAPER_COLLAGE_ASSET_PACK_REJECTED:${codes}`;
    } else if (productionPlan === null) {
      blockingReason = 'PAPER_COLLAGE_PRODUCTION_PLAN_REQUIRED';
    } else if (inspection.generatedPerformanceShotCount > 0) {
      blockingReason = 'PAPER_COLLAGE_GENERATED_SHOTS_FORBIDDEN';
    } else if (paperReason !== undefined) {
      blockingReason = paperReason;
    } else if (
      inspection.videoDurationSeconds === null
      || Math.abs(inspection.videoDurationSeconds - record.durationSeconds) > 0.05
    ) {
      blockingReason = `PAPER_COLLAGE_DURATION_MISMATCH:${inspection.videoDurationSeconds ?? 'unknown'}!=${record.durationSeconds}`;
    } else if (!narrationMatchesScript(productionPlan, record.script)) {
      blockingReason = 'PAPER_COLLAGE_NARRATION_SCRIPT_MISMATCH';
    }
    return {
      ...inspection,
      readyForCreation: blockingReason === undefined,
      requestedDurationSeconds: record.durationSeconds,
      ...(blockingReason === undefined ? {} : {blockingReason}),
    };
  }

  resolveCreationFile(idValue: string, relativePath: string): string {
    return resolveInside(this.creationRoot(idValue), relativePath);
  }

  async #write(record: CreationRecord): Promise<void> {
    const filePath = path.join(this.creationRoot(record.id), 'creation.json');
    const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, {encoding: 'utf8', flag: 'wx'});
    await fs.rename(temporary, filePath);
  }
}

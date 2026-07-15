import type {ZodType} from 'zod';
import {CURRENT_SCHEMA_VERSION} from './common';
import {manifestSchema, type ManifestDocument} from './manifest';
import {projectSchema, type ProjectDocument} from './project';
import {shotSchema, type ShotDocument} from './shot';

type UnknownRecord = Record<string, unknown>;

export class UnsupportedSchemaVersionError extends Error {
  public readonly receivedVersion: number;
  public readonly currentVersion = CURRENT_SCHEMA_VERSION;

  public constructor(receivedVersion: number) {
    super(`Unsupported schema version ${receivedVersion}; this build supports up to v${CURRENT_SCHEMA_VERSION}.`);
    this.name = 'UnsupportedSchemaVersionError';
    this.receivedVersion = receivedVersion;
  }
}

const asRecord = (input: unknown, label: string): UnknownRecord => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError(`${label} must be a JSON object.`);
  }
  return input as UnknownRecord;
};

const readVersion = (record: UnknownRecord): number => {
  const raw = record.schemaVersion ?? record.version ?? 1;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    throw new TypeError('schemaVersion must be a positive integer.');
  }
  if (raw > CURRENT_SCHEMA_VERSION) {
    throw new UnsupportedSchemaVersionError(raw);
  }
  return raw;
};

const parseCurrent = <T>(schema: ZodType<T>, input: unknown): T => schema.parse(input);

const stringValue = (record: UnknownRecord, keys: string[], fallback?: string): string | undefined => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return fallback;
};

const numberValue = (record: UnknownRecord, keys: string[], fallback?: number): number | undefined => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return fallback;
};

const normalizeAspect = (value: unknown): '9:16' | '16:9' | '1:1' | '4:5' => {
  if (value === '16:9' || value === '1:1' || value === '4:5') return value;
  return '9:16';
};

const defaultCanvas = (aspectRatio: '9:16' | '16:9' | '1:1' | '4:5') => {
  if (aspectRatio === '16:9') return {width: 1920, height: 1080, aspectRatio};
  if (aspectRatio === '1:1') return {width: 1080, height: 1080, aspectRatio};
  if (aspectRatio === '4:5') return {width: 1080, height: 1350, aspectRatio};
  return {width: 1080, height: 1920, aspectRatio};
};

const migrateV1Manifest = (input: UnknownRecord): ManifestDocument => {
  const projectId = stringValue(input, ['projectId', 'id']);
  const title = stringValue(input, ['title', 'name']);
  if (!projectId || !title) throw new TypeError('A v1 manifest requires id/projectId and name/title.');
  const ratio = normalizeAspect(input.aspectRatio ?? input.ratio);
  const oldCanvas = typeof input.canvas === 'object' && input.canvas !== null ? (input.canvas as UnknownRecord) : undefined;
  const defaultSize = defaultCanvas(ratio);
  const canvas = {
    width: oldCanvas ? numberValue(oldCanvas, ['width'], defaultSize.width) : defaultSize.width,
    height: oldCanvas ? numberValue(oldCanvas, ['height'], defaultSize.height) : defaultSize.height,
    aspectRatio: ratio,
  };
  const rawShots = Array.isArray(input.shots)
    ? input.shots
    : Array.isArray(input.shotFiles)
      ? input.shotFiles
      : [];
  const shots = rawShots.map((entry, index) => {
    if (typeof entry === 'string') {
      const match = entry.match(/([^/]+)\.json$/i);
      return {id: match?.[1] ?? `shot-${String(index + 1).padStart(2, '0')}`, path: entry};
    }
    const record = asRecord(entry, `shots[${index}]`);
    const path = stringValue(record, ['path', 'file']);
    const id = stringValue(record, ['id']) ?? `shot-${String(index + 1).padStart(2, '0')}`;
    if (!path) throw new TypeError(`v1 manifest shots[${index}] is missing a path.`);
    return {id, path};
  });

  const narrationPath = stringValue(input, ['narrationPath', 'narration']);
  const subtitlesPath = stringValue(input, ['subtitlesPath', 'subtitles']);
  const styleReferencePath = stringValue(input, ['styleReferencePath', 'styleReference']);
  const migrated: Record<string, unknown> = {
    schemaVersion: 2,
    projectId,
    title,
    locale: stringValue(input, ['locale'], 'zh-CN'),
    canvas,
    fps: numberValue(input, ['fps'], 30),
    shots,
  };
  if (narrationPath) migrated.narrationPath = narrationPath;
  if (subtitlesPath) migrated.subtitlesPath = subtitlesPath;
  if (styleReferencePath) migrated.styleReferencePath = styleReferencePath;
  return manifestSchema.parse(migrated);
};

const normalizeV1Layer = (entry: unknown, index: number): Record<string, unknown> => {
  const record = asRecord(entry, `layers[${index}]`);
  const role = stringValue(record, ['role', 'type'], index === 0 ? 'background' : 'subject');
  const layer: Record<string, unknown> = {
    id: stringValue(record, ['id'], `layer-${index + 1}`),
    role,
    depth: numberValue(record, ['depth'], role === 'background' ? 0.1 : role === 'foreground' ? 0.9 : 0.5),
    visible: record.visible !== false,
  };
  const assetPath = stringValue(record, ['assetPath', 'src', 'path']);
  const text = stringValue(record, ['text']);
  if (assetPath) layer.assetPath = assetPath;
  if (text) layer.text = text;
  if (typeof record.transform === 'object' && record.transform !== null) layer.transform = record.transform;
  return layer;
};

const migrateV1Shot = (input: UnknownRecord): ShotDocument => {
  const id = stringValue(input, ['id']);
  if (!id) throw new TypeError('A v1 shot requires an id.');
  const rawLayers = Array.isArray(input.layers) ? input.layers : [];
  const migrated: Record<string, unknown> = {
    schemaVersion: 2,
    id,
    durationFrames: numberValue(input, ['durationFrames', 'frames'], 150),
    recipeId: stringValue(input, ['recipeId', 'recipe', 'template'], 'editorial-pan'),
    energy: stringValue(input, ['energy'], 'balanced'),
    layers: rawLayers.map(normalizeV1Layer),
    actors: Array.isArray(input.actors) ? input.actors : [],
    motionEvents: Array.isArray(input.motionEvents) ? input.motionEvents : [],
    transition: input.transition ?? {type: 'hard-cut', durationFrames: 0},
  };
  const name = stringValue(input, ['name']);
  if (name) migrated.name = name;
  if (typeof input.camera === 'object' && input.camera !== null) migrated.camera = input.camera;
  if (typeof input.title === 'object' && input.title !== null) migrated.title = input.title;
  return shotSchema.parse(migrated);
};

export const migrateManifestDocument = (input: unknown): ManifestDocument => {
  const record = asRecord(input, 'Manifest');
  return readVersion(record) === 2 ? parseCurrent(manifestSchema, record) : migrateV1Manifest(record);
};

export const parseManifestDocument = (input: unknown): ManifestDocument => migrateManifestDocument(input);

export const migrateShotDocument = (input: unknown): ShotDocument => {
  const record = asRecord(input, 'Shot');
  return readVersion(record) === 2 ? parseCurrent(shotSchema, record) : migrateV1Shot(record);
};

export const parseShotDocument = (input: unknown): ShotDocument => migrateShotDocument(input);

export const migrateProjectDocument = (input: unknown): ProjectDocument => {
  const record = asRecord(input, 'Project');
  const version = readVersion(record);
  if (version === 2) return projectSchema.parse(record);
  const manifestInput = record.manifest;
  const shotInputs = record.shots;
  if (!manifestInput || !Array.isArray(shotInputs)) {
    throw new TypeError('A v1 project requires manifest and shots.');
  }
  return projectSchema.parse({
    schemaVersion: 2,
    manifest: migrateManifestDocument(manifestInput),
    shots: shotInputs.map(migrateShotDocument),
  });
};

export const parseProjectDocument = (input: unknown): ProjectDocument => migrateProjectDocument(input);

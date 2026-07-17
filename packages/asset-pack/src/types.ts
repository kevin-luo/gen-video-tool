export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export type DiagnosticCode =
  | 'IMPORT_FAILED'
  | 'SOURCE_NOT_FOUND'
  | 'SOURCE_NOT_DIRECTORY'
  | 'SOURCE_DESTINATION_OVERLAP'
  | 'SOURCE_FILE_UNSUPPORTED'
  | 'SOURCE_SYMLINK'
  | 'SYMLINK_OUTSIDE_SOURCE'
  | 'SYMLINK_CYCLE'
  | 'PATH_EMPTY'
  | 'PATH_ABSOLUTE'
  | 'PATH_DRIVE_LETTER'
  | 'PATH_UNC'
  | 'PATH_TRAVERSAL'
  | 'PATH_BACKSLASH_NORMALIZED'
  | 'PATH_INVALID_CHARACTER'
  | 'PATH_RESERVED_NAME'
  | 'PATH_TOO_LONG'
  | 'PATH_COLLISION'
  | 'ZIP_CORRUPT'
  | 'ZIP64_UNSUPPORTED'
  | 'ZIP_ENCRYPTED_ENTRY'
  | 'ZIP_SYMLINK_ENTRY'
  | 'ZIP_TOO_MANY_ENTRIES'
  | 'ZIP_ENTRY_TOO_LARGE'
  | 'ZIP_TOTAL_TOO_LARGE'
  | 'ZIP_COMPRESSION_RATIO_EXCEEDED'
  | 'STAGING_CREATE_FAILED'
  | 'STAGING_CLEANUP_FAILED'
  | 'DESTINATION_EXISTS'
  | 'ATOMIC_COMMIT_FAILED'
  | 'PRODUCTION_PLAN_MISSING'
  | 'PRODUCTION_PLAN_MULTIPLE'
  | 'JSON_CORRUPT'
  | 'PRODUCTION_PLAN_INVALID'
  | 'GENERATED_ARTIFACT_FORBIDDEN'
  | 'REFERENCE_PATH_INVALID'
  | 'REFERENCE_MISSING'
  | 'REFERENCE_OUTSIDE_PACK'
  | 'DUPLICATE_ID'
  | 'UNREFERENCED_FILE'
  | 'IMAGE_CORRUPT'
  | 'IMAGE_DIMENSIONS_INVALID'
  | 'IMAGE_DIMENSIONS_MISMATCH'
  | 'IMAGE_TOO_LARGE'
  | 'IMAGE_ALPHA_REQUIRED'
  | 'SRT_CORRUPT'
  | 'SRT_TIME_INVALID'
  | 'SRT_ORDER_INVALID'
  | 'SRT_OVERLAP'
  | 'SRT_OUTSIDE_VIDEO'
  | 'AUDIO_CORRUPT'
  | 'AUDIO_DURATION_MISSING'
  | 'AUDIO_DURATION_MISMATCH'
  | 'AUDIO_TOO_SHORT'
  | 'AUDIO_TOO_LONG';

/** A stable, serializable problem record suitable for Electron IPC. */
export interface AssetPackDiagnostic {
  code: DiagnosticCode;
  severity: DiagnosticSeverity;
  /** JSON pointer or import phase (for example `/shots/0/path`). */
  path: string | null;
  /** POSIX path inside the asset pack, never an absolute host path. */
  assetPath: string | null;
  message: string;
  suggestion: string | null;
}

export interface ImportLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
  maxCompressionRatio: number;
  maxPathLength: number;
  maxSegmentLength: number;
  maxImagePixels: number;
}

export const DEFAULT_IMPORT_LIMITS: Readonly<ImportLimits> = Object.freeze({
  maxEntries: 2_000,
  maxEntryBytes: 256 * 1024 * 1024,
  maxTotalBytes: 1024 * 1024 * 1024,
  maxCompressionRatio: 250,
  maxPathLength: 512,
  maxSegmentLength: 180,
  maxImagePixels: 80_000_000,
});

export type AssetPackSource =
  | {kind: 'zip'; path: string}
  | {kind: 'directory'; path: string};

export interface InspectAssetPackRequest {
  source: AssetPackSource;
  limits?: Partial<ImportLimits>;
}

export interface ImportAssetPackRequest extends InspectAssetPackRequest {
  /** Existing directory under which a new project directory is atomically created. */
  projectsRoot: string;
  /** Optional destination directory name. Defaults to the validated production.json projectId. */
  destinationName?: string;
}

export interface AssetPackInspection {
  status: 'ready' | 'rejected';
  diagnostics: AssetPackDiagnostic[];
  projectId: string | null;
  title: string | null;
  shotCount: number;
  sourceKind: AssetPackSource['kind'];
  fileCount: number;
  totalBytes: number;
  videoDurationSeconds: number | null;
  audioDurationSeconds: number | null;
  /** 3 after production.json parses as v3; null when no valid plan could be identified. */
  productionSchemaVersion: 3 | null;
  generatedPerformanceShotCount: number;
}

export interface AssetPackImportResult extends Omit<AssetPackInspection, 'status'> {
  status: 'committed' | 'rejected';
  /** Absolute path is returned only after a successful atomic commit. */
  projectPath: string | null;
}

export interface NormalizedAssetPath {
  /** Slash-normalized spelling before Unicode normalization. */
  original: string;
  normalized: string;
  canonical: string;
  usedBackslashes: boolean;
}

export interface ExtractedPack {
  stagingRoot: string;
  contentRoot: string;
  relativeFiles: string[];
  fileCount: number;
  totalBytes: number;
  diagnostics: AssetPackDiagnostic[];
}

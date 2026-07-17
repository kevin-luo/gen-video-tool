import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const PRODUCTION_RUN_LOCK_RELATIVE_PATH = 'generated/production-run.lock' as const;

export type ProductionRunKind = 'generation' | 'narration' | 'recovery' | 'render' | 'review';

export type ProductionRunLockRecord = {
  schemaVersion: 1;
  ownerId: string;
  pid: number;
  hostname: string;
  kind: ProductionRunKind;
  acquiredAt: string;
};

export type ProductionRunLockInspection =
  | {status: 'unlocked'}
  | {status: 'active'; record: ProductionRunLockRecord; reason: 'local-pid-alive' | 'remote-lease-not-expired'}
  | {status: 'stale'; record?: ProductionRunLockRecord; reason: 'local-pid-dead' | 'remote-lease-expired' | 'invalid-lock'};

export type AcquireProductionRunLockOptions = {
  kind: ProductionRunKind;
  ownerId?: string;
  pid?: number;
  hostname?: string;
  acquiredAt?: string;
  /** Only protects a lock written by another host. A live local PID never expires by age. */
  remoteStaleAfterMs?: number;
  isPidAlive?: (pid: number) => boolean;
};

export type InspectProductionRunLockOptions = {
  now?: number;
  hostname?: string;
  remoteStaleAfterMs?: number;
  invalidLockGraceMs?: number;
  isPidAlive?: (pid: number) => boolean;
};

export type ProductionRunLockHandle = {
  readonly projectRoot: string;
  readonly lockPath: string;
  readonly record: ProductionRunLockRecord;
  release: () => Promise<boolean>;
};

export class ProductionRunLockedError extends Error {
  readonly code = 'PRODUCTION_RUN_LOCKED';
  readonly lock: ProductionRunLockRecord;

  constructor(lock: ProductionRunLockRecord) {
    super(`PRODUCTION_RUN_LOCKED:${lock.kind}:${lock.ownerId}:pid=${lock.pid}`);
    this.name = 'ProductionRunLockedError';
    this.lock = lock;
  }
}

const DEFAULT_REMOTE_STALE_AFTER_MS = 24 * 60 * 60_000;
const DEFAULT_INVALID_LOCK_GRACE_MS = 30_000;
const MAX_ACQUIRE_ATTEMPTS = 8;

const resolveProjectRoot = (projectRoot: string): string => {
  if (!path.isAbsolute(projectRoot)) throw new Error('PRODUCTION_PROJECT_ROOT_MUST_BE_ABSOLUTE');
  return path.resolve(projectRoot);
};

export const resolveProductionRunLockPath = (projectRoot: string): string =>
  path.join(resolveProjectRoot(projectRoot), ...PRODUCTION_RUN_LOCK_RELATIVE_PATH.split('/'));

const isMissing = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';

const isAlreadyExists = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';

const parseLockRecord = (value: unknown): ProductionRunLockRecord | null => {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Partial<ProductionRunLockRecord>;
  if (
    record.schemaVersion !== 1
    || typeof record.ownerId !== 'string'
    || record.ownerId.length === 0
    || !Number.isSafeInteger(record.pid)
    || (record.pid ?? 0) <= 0
    || typeof record.hostname !== 'string'
    || record.hostname.length === 0
    || !['generation', 'narration', 'recovery', 'render', 'review'].includes(String(record.kind))
    || typeof record.acquiredAt !== 'string'
    || !Number.isFinite(Date.parse(record.acquiredAt))
  ) return null;
  return record as ProductionRunLockRecord;
};

export const isLocalPidAlive = (pid: number): boolean => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // EPERM means the process exists but this user is not allowed to signal it.
    return code === 'EPERM';
  }
};

export const inspectProductionRunLock = async (
  projectRoot: string,
  options: InspectProductionRunLockOptions = {},
): Promise<ProductionRunLockInspection> => {
  const lockPath = resolveProductionRunLockPath(projectRoot);
  let text: string;
  let modifiedAtMs: number;
  try {
    const [contents, stat] = await Promise.all([fs.readFile(lockPath, 'utf8'), fs.stat(lockPath)]);
    text = contents;
    modifiedAtMs = stat.mtimeMs;
  } catch (error) {
    if (isMissing(error)) return {status: 'unlocked'};
    throw error;
  }

  let record: ProductionRunLockRecord | null = null;
  try { record = parseLockRecord(JSON.parse(text) as unknown); } catch { /* handled below */ }
  const now = options.now ?? Date.now();
  if (!record) {
    const invalidLockGraceMs = options.invalidLockGraceMs ?? DEFAULT_INVALID_LOCK_GRACE_MS;
    if (now - modifiedAtMs < invalidLockGraceMs) {
      // A just-created lock can briefly be visible before its JSON body is flushed.
      throw new Error('PRODUCTION_RUN_LOCK_INITIALIZING');
    }
    return {status: 'stale', reason: 'invalid-lock'};
  }

  const localHostname = options.hostname ?? os.hostname();
  if (record.hostname === localHostname) {
    return (options.isPidAlive ?? isLocalPidAlive)(record.pid)
      ? {status: 'active', record, reason: 'local-pid-alive'}
      : {status: 'stale', record, reason: 'local-pid-dead'};
  }

  const acquiredAtMs = Date.parse(record.acquiredAt);
  const remoteStaleAfterMs = options.remoteStaleAfterMs ?? DEFAULT_REMOTE_STALE_AFTER_MS;
  return now - acquiredAtMs >= remoteStaleAfterMs
    ? {status: 'stale', record, reason: 'remote-lease-expired'}
    : {status: 'active', record, reason: 'remote-lease-not-expired'};
};

const quarantineStaleLock = async (
  lockPath: string,
  expectedOwnerId: string | undefined,
): Promise<boolean> => {
  const quarantinePath = `${lockPath}.stale.${process.pid}.${randomUUID()}`;
  try {
    await fs.rename(lockPath, quarantinePath);
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }

  try {
    if (expectedOwnerId !== undefined) {
      let quarantined: ProductionRunLockRecord | null = null;
      try {
        quarantined = parseLockRecord(JSON.parse(await fs.readFile(quarantinePath, 'utf8')) as unknown);
      } catch { /* invalid files are recoverable only when no owner was expected */ }
      if (quarantined?.ownerId !== expectedOwnerId) {
        // The lock changed between inspection and rename. Never delete that owner's lease.
        try { await fs.rename(quarantinePath, lockPath); } catch { /* another owner won; preserve quarantine */ }
        throw new Error('PRODUCTION_RUN_LOCK_RACE');
      }
    }
    await fs.rm(quarantinePath, {force: true});
    return true;
  } catch (error) {
    if (!isMissing(error)) {
      try { await fs.rename(quarantinePath, lockPath); } catch { /* keep the quarantined copy for diagnosis */ }
      throw error;
    }
    return false;
  }
};

export const releaseProductionRunLock = async (
  projectRoot: string,
  ownerId: string,
): Promise<boolean> => {
  const lockPath = resolveProductionRunLockPath(projectRoot);
  let record: ProductionRunLockRecord | null;
  try {
    record = parseLockRecord(JSON.parse(await fs.readFile(lockPath, 'utf8')) as unknown);
  } catch (error) {
    if (isMissing(error)) return false;
    return false;
  }
  if (record?.ownerId !== ownerId) return false;

  const releasedPath = `${lockPath}.released.${process.pid}.${randomUUID()}`;
  try {
    await fs.rename(lockPath, releasedPath);
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
  try {
    const moved = parseLockRecord(JSON.parse(await fs.readFile(releasedPath, 'utf8')) as unknown);
    if (moved?.ownerId !== ownerId) {
      try { await fs.rename(releasedPath, lockPath); } catch { /* preserve the other owner's file */ }
      return false;
    }
    await fs.rm(releasedPath, {force: true});
    return true;
  } catch (error) {
    if (!isMissing(error)) {
      try { await fs.rename(releasedPath, lockPath); } catch { /* keep the released copy for diagnosis */ }
      throw error;
    }
    return false;
  }
};

export const acquireProductionRunLock = async (
  projectRootValue: string,
  options: AcquireProductionRunLockOptions,
): Promise<ProductionRunLockHandle> => {
  const projectRoot = resolveProjectRoot(projectRootValue);
  const lockPath = resolveProductionRunLockPath(projectRoot);
  const record: ProductionRunLockRecord = {
    schemaVersion: 1,
    ownerId: options.ownerId ?? randomUUID(),
    pid: options.pid ?? process.pid,
    hostname: options.hostname ?? os.hostname(),
    kind: options.kind,
    acquiredAt: options.acquiredAt ?? new Date().toISOString(),
  };
  if (!parseLockRecord(record)) throw new Error('PRODUCTION_RUN_LOCK_RECORD_INVALID');
  await fs.mkdir(path.dirname(lockPath), {recursive: true});

  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
    let fileHandle: fs.FileHandle | undefined;
    let created = false;
    try {
      fileHandle = await fs.open(lockPath, 'wx');
      created = true;
      await fileHandle.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
      await fileHandle.sync();
      await fileHandle.close();
      fileHandle = undefined;
      let released = false;
      let releasePromise: Promise<boolean> | undefined;
      return {
        projectRoot,
        lockPath,
        record,
        release: async () => {
          if (released) return false;
          if (releasePromise) return releasePromise;
          releasePromise = releaseProductionRunLock(projectRoot, record.ownerId).then((didRelease) => {
            if (didRelease) released = true;
            return didRelease;
          });
          try { return await releasePromise; } finally { releasePromise = undefined; }
        },
      };
    } catch (error) {
      if (fileHandle) await fileHandle.close().catch(() => undefined);
      if (created) await fs.rm(lockPath, {force: true}).catch(() => undefined);
      if (!isAlreadyExists(error)) throw error;
    }

    let inspection: ProductionRunLockInspection;
    try {
      inspection = await inspectProductionRunLock(projectRoot, {
        hostname: record.hostname,
        ...(options.remoteStaleAfterMs === undefined ? {} : {remoteStaleAfterMs: options.remoteStaleAfterMs}),
        ...(options.isPidAlive === undefined ? {} : {isPidAlive: options.isPidAlive}),
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'PRODUCTION_RUN_LOCK_INITIALIZING') {
        await new Promise((resolve) => setTimeout(resolve, 10));
        continue;
      }
      throw error;
    }
    if (inspection.status === 'unlocked') continue;
    if (inspection.status === 'active') throw new ProductionRunLockedError(inspection.record);
    await quarantineStaleLock(lockPath, inspection.record?.ownerId);
  }

  throw new Error('PRODUCTION_RUN_LOCK_ACQUIRE_RETRY_EXHAUSTED');
};

export const withProductionRunLock = async <T>(
  projectRoot: string,
  options: AcquireProductionRunLockOptions,
  action: (lock: ProductionRunLockHandle) => Promise<T>,
): Promise<T> => {
  const lock = await acquireProductionRunLock(projectRoot, options);
  try {
    return await action(lock);
  } finally {
    await lock.release();
  }
};

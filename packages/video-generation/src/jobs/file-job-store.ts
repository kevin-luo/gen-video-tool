import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {VideoGenerationJob} from '../providers/provider';

type StoredJobDocument = {
  version: 1;
  jobs: VideoGenerationJob[];
};

const ACTIVE_STATUSES = new Set<VideoGenerationJob['status']>([
  'preparing',
  'running',
  'downloading',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isJobStatus = (value: unknown): value is VideoGenerationJob['status'] =>
  value === 'queued' || value === 'preparing' || value === 'running' ||
  value === 'downloading' || value === 'complete' || value === 'failed' || value === 'cancelled';

const parseStoredJob = (value: unknown, index: number): VideoGenerationJob => {
  if (!isRecord(value)) throw new Error(`VIDEO_JOB_STORE_INVALID:jobs[${index}] must be an object`);
  if (typeof value.id !== 'string' || value.id.length === 0) {
    throw new Error(`VIDEO_JOB_STORE_INVALID:jobs[${index}].id`);
  }
  if (value.providerId !== 'wangp' && value.providerId !== 'local-video-import') {
    throw new Error(`VIDEO_JOB_STORE_INVALID:jobs[${index}].providerId`);
  }
  if (!isJobStatus(value.status)) throw new Error(`VIDEO_JOB_STORE_INVALID:jobs[${index}].status`);
  if (typeof value.progress !== 'number' || !Number.isFinite(value.progress)) {
    throw new Error(`VIDEO_JOB_STORE_INVALID:jobs[${index}].progress`);
  }
  if (typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string') {
    throw new Error(`VIDEO_JOB_STORE_INVALID:jobs[${index}].timestamps`);
  }
  return value as VideoGenerationJob;
};

const parseDocument = (value: unknown): StoredJobDocument => {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.jobs)) {
    throw new Error('VIDEO_JOB_STORE_INVALID:expected version 1 job document');
  }
  const jobs = value.jobs.map(parseStoredJob);
  if (new Set(jobs.map((job) => job.id)).size !== jobs.length) {
    throw new Error('VIDEO_JOB_STORE_INVALID:duplicate job id');
  }
  return {version: 1, jobs};
};

const cloneJob = (job: VideoGenerationJob): VideoGenerationJob => structuredClone(job);

export class FileVideoGenerationJobStore {
  readonly filePath: string;

  #jobs = new Map<string, VideoGenerationJob>();
  #initialized = false;
  #operation: Promise<void> = Promise.resolve();

  public constructor(filePath: string) {
    if (!path.isAbsolute(filePath)) throw new Error('VIDEO_JOB_STORE_PATH_MUST_BE_ABSOLUTE');
    this.filePath = path.resolve(filePath);
  }

  public async initialize(): Promise<VideoGenerationJob[]> {
    return this.#serialize(async () => {
      if (!this.#initialized) await this.#loadAndRecover();
      return this.#snapshot();
    });
  }

  public async list(): Promise<VideoGenerationJob[]> {
    return this.#serialize(async () => {
      if (!this.#initialized) await this.#loadAndRecover();
      return this.#snapshot();
    });
  }

  public async get(jobId: string): Promise<VideoGenerationJob | null> {
    return this.#serialize(async () => {
      if (!this.#initialized) await this.#loadAndRecover();
      const job = this.#jobs.get(jobId);
      return job ? cloneJob(job) : null;
    });
  }

  public async upsert(job: VideoGenerationJob): Promise<VideoGenerationJob> {
    return this.#serialize(async () => {
      if (!this.#initialized) await this.#loadAndRecover();
      this.#jobs.set(job.id, cloneJob(job));
      await this.#write();
      return cloneJob(job);
    });
  }

  public async update(
    jobId: string,
    updater: (current: VideoGenerationJob) => VideoGenerationJob,
  ): Promise<VideoGenerationJob> {
    return this.#serialize(async () => {
      if (!this.#initialized) await this.#loadAndRecover();
      const current = this.#jobs.get(jobId);
      if (!current) throw new Error(`VIDEO_GENERATION_JOB_NOT_FOUND:${jobId}`);
      const next = updater(cloneJob(current));
      if (next.id !== jobId) throw new Error('VIDEO_GENERATION_JOB_ID_IMMUTABLE');
      this.#jobs.set(jobId, cloneJob(next));
      await this.#write();
      return cloneJob(next);
    });
  }

  public async remove(jobId: string): Promise<boolean> {
    return this.#serialize(async () => {
      if (!this.#initialized) await this.#loadAndRecover();
      const removed = this.#jobs.delete(jobId);
      if (removed) await this.#write();
      return removed;
    });
  }

  async #loadAndRecover(): Promise<void> {
    let document: StoredJobDocument = {version: 1, jobs: []};
    try {
      document = parseDocument(JSON.parse(await fs.readFile(this.filePath, 'utf8')) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const recoveredAt = new Date().toISOString();
    let changed = false;
    this.#jobs.clear();
    for (const job of document.jobs) {
      if (ACTIVE_STATUSES.has(job.status)) {
        changed = true;
        this.#jobs.set(job.id, {
          ...cloneJob(job),
          status: 'failed',
          progress: Math.min(0.99, Math.max(0, job.progress)),
          updatedAt: recoveredAt,
          error: {
            code: 'JOB_INTERRUPTED',
            message: 'The application stopped while this local generation job was active.',
            details: {recoverable: true, previousStatus: job.status},
          },
        });
      } else {
        this.#jobs.set(job.id, cloneJob(job));
      }
    }
    this.#initialized = true;
    if (changed) await this.#write();
  }

  async #write(): Promise<void> {
    const directory = path.dirname(this.filePath);
    await fs.mkdir(directory, {recursive: true});
    const temporaryPath = path.join(directory, `.${path.basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`);
    const document: StoredJobDocument = {version: 1, jobs: this.#snapshot()};
    try {
      await fs.writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, {encoding: 'utf8', flag: 'wx'});
      await fs.rename(temporaryPath, this.filePath);
    } finally {
      await fs.rm(temporaryPath, {force: true});
    }
  }

  #snapshot(): VideoGenerationJob[] {
    return [...this.#jobs.values()]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      .map(cloneJob);
  }

  async #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operation.then(operation, operation);
    this.#operation = result.then(() => undefined, () => undefined);
    return result;
  }
}

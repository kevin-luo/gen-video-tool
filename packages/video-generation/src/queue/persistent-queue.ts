import type {VideoGenerationJob} from '../providers/provider';
import type {FileVideoGenerationJobStore} from '../jobs/file-job-store';

export type VideoGenerationRunContext = {
  signal: AbortSignal;
  update: (
    patch: Partial<Pick<VideoGenerationJob, 'status' | 'progress' | 'previewPath' | 'outputPath' | 'seed' | 'error'>>,
  ) => Promise<VideoGenerationJob>;
};

export type VideoGenerationJobRunner = (
  job: VideoGenerationJob,
  context: VideoGenerationRunContext,
) => Promise<VideoGenerationJob>;

export type PersistentGenerationQueueOptions = {
  concurrency?: number;
  now?: () => string;
};

const terminal = (status: VideoGenerationJob['status']): boolean =>
  status === 'complete' || status === 'failed' || status === 'cancelled';

const errorDetails = (error: unknown): unknown => {
  if (error instanceof Error) return {name: error.name, message: error.message};
  return error;
};

export class PersistentVideoGenerationQueue {
  readonly concurrency: number;

  #store: FileVideoGenerationJobStore;
  #runner: VideoGenerationJobRunner;
  #now: () => string;
  #started = false;
  #active = new Map<string, AbortController>();
  #pumping = false;
  #pumpRequested = false;
  #idleWaiters = new Set<() => void>();

  public constructor(
    store: FileVideoGenerationJobStore,
    runner: VideoGenerationJobRunner,
    options: PersistentGenerationQueueOptions = {},
  ) {
    const concurrency = options.concurrency ?? 1;
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error('VIDEO_GENERATION_CONCURRENCY_INVALID');
    }
    this.concurrency = concurrency;
    this.#store = store;
    this.#runner = runner;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  public async start(): Promise<void> {
    if (this.#started) return;
    await this.#store.initialize();
    this.#started = true;
    await this.#pump();
  }

  public async enqueue(job: VideoGenerationJob): Promise<VideoGenerationJob> {
    await this.start();
    const existing = await this.#store.get(job.id);
    if (existing) throw new Error(`VIDEO_GENERATION_JOB_ALREADY_EXISTS:${job.id}`);
    const now = this.#now();
    const queued: VideoGenerationJob = {
      ...job,
      status: 'queued',
      progress: 0,
      createdAt: job.createdAt || now,
      updatedAt: now,
    };
    delete queued.outputPath;
    delete queued.previewPath;
    delete queued.error;
    await this.#store.upsert(queued);
    void this.#pump();
    return queued;
  }

  public async retry(jobId: string): Promise<VideoGenerationJob> {
    await this.start();
    const queued = await this.#store.update(jobId, (job) => {
      if (job.status !== 'failed' && job.status !== 'cancelled') {
        throw new Error(`VIDEO_GENERATION_JOB_NOT_RETRYABLE:${jobId}:${job.status}`);
      }
      const next: VideoGenerationJob = {...job, status: 'queued', progress: 0, updatedAt: this.#now()};
      delete next.outputPath;
      delete next.previewPath;
      delete next.error;
      return next;
    });
    void this.#pump();
    return queued;
  }

  public async cancel(jobId: string): Promise<VideoGenerationJob> {
    await this.start();
    this.#active.get(jobId)?.abort();
    const cancelled = await this.#store.update(jobId, (job) => {
      if (terminal(job.status)) return job;
      return {...job, status: 'cancelled', updatedAt: this.#now()};
    });
    void this.#pump();
    return cancelled;
  }

  public async list(): Promise<VideoGenerationJob[]> {
    await this.start();
    return this.#store.list();
  }

  public async get(jobId: string): Promise<VideoGenerationJob | null> {
    await this.start();
    return this.#store.get(jobId);
  }

  public async waitForIdle(): Promise<void> {
    await this.start();
    if (await this.#isIdle()) return;
    await new Promise<void>((resolve) => {
      this.#idleWaiters.add(resolve);
      // Close the gap between the check above and registering this waiter.
      void this.#resolveIdleWaiters();
    });
  }

  async #pump(): Promise<void> {
    if (!this.#started) return;
    if (this.#pumping) {
      this.#pumpRequested = true;
      return;
    }
    this.#pumping = true;
    try {
      do {
        this.#pumpRequested = false;
        const jobs = await this.#store.list();
        const available = this.concurrency - this.#active.size;
        if (available > 0) {
          for (const job of jobs.filter((candidate) => candidate.status === 'queued').slice(0, available)) {
            this.#launch(job);
          }
        }
      } while (this.#pumpRequested);
    } finally {
      this.#pumping = false;
      await this.#resolveIdleWaiters();
    }
  }

  #launch(job: VideoGenerationJob): void {
    if (this.#active.has(job.id)) return;
    const controller = new AbortController();
    this.#active.set(job.id, controller);
    void this.#run(job, controller).finally(() => {
      this.#active.delete(job.id);
      void this.#pump();
    });
  }

  async #run(job: VideoGenerationJob, controller: AbortController): Promise<void> {
    try {
      const preparing = await this.#store.update(job.id, (current) => ({
        ...current,
        status: current.status === 'cancelled' ? 'cancelled' : 'preparing',
        progress: current.status === 'cancelled' ? current.progress : Math.max(0, current.progress),
        updatedAt: this.#now(),
      }));
      if (preparing.status === 'cancelled') return;
      const result = await this.#runner(preparing, {
        signal: controller.signal,
        update: async (patch) => this.#store.update(job.id, (current) => {
          if (current.status === 'cancelled') return current;
          return {
            ...current,
            ...patch,
            progress: patch.progress === undefined ? current.progress : Math.min(1, Math.max(0, patch.progress)),
            updatedAt: this.#now(),
          };
        }),
      });
      await this.#store.update(job.id, (current) => {
        if (current.status === 'cancelled') return current;
        if (result.id !== job.id) throw new Error('VIDEO_GENERATION_RUNNER_JOB_ID_MISMATCH');
        if (!terminal(result.status)) throw new Error(`VIDEO_GENERATION_RUNNER_NON_TERMINAL:${result.status}`);
        return {...result, updatedAt: this.#now()};
      });
    } catch (error) {
      await this.#store.update(job.id, (current) => {
        if (current.status === 'cancelled') return current;
        if (controller.signal.aborted) return {...current, status: 'cancelled', updatedAt: this.#now()};
        return {
          ...current,
          status: 'failed',
          progress: Math.min(0.99, current.progress),
          updatedAt: this.#now(),
          error: {
            code: 'JOB_EXECUTION_FAILED',
            message: error instanceof Error ? error.message : 'Local generation job failed.',
            details: errorDetails(error),
          },
        };
      });
    }
  }

  async #isIdle(): Promise<boolean> {
    if (this.#active.size > 0) return false;
    return !(await this.#store.list()).some((job) => job.status === 'queued');
  }

  async #resolveIdleWaiters(): Promise<void> {
    if (!(await this.#isIdle())) return;
    for (const resolve of this.#idleWaiters) resolve();
    this.#idleWaiters.clear();
  }
}

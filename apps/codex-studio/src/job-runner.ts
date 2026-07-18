import {spawn, type ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type {StudioConfig} from './config.js';
import {assertSafeId} from './path-safety.js';

export type StudioJobAction =
  | 'detect-runtime'
  | 'generate-shot'
  | 'synthesize-narration'
  | 'render-project'
  | 'produce-video';
export type StudioJobStatus = 'queued' | 'running' | 'complete' | 'failed' | 'cancelled' | 'interrupted';

export interface StudioJobLog {
  at: string;
  stream: 'stdout' | 'stderr' | 'system';
  text: string;
}

export interface StudioJob {
  id: string;
  action: StudioJobAction;
  projectId: string;
  shotId?: string;
  status: StudioJobStatus;
  progress: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  result?: unknown;
  error?: string;
  logs: StudioJobLog[];
}

export interface JobCommand {
  executable: string;
  args: string[];
  cwd: string;
}

export const buildJobCommand = (
  config: Pick<StudioConfig, 'repositoryRoot' | 'dataRoot' | 'projectsRoot' | 'outputRoot'>,
  job: Pick<StudioJob, 'action' | 'projectId' | 'shotId'>,
  executable = process.execPath,
): JobCommand => {
  const projectId = assertSafeId(job.projectId, 'PROJECT_ID');
  const projectRoot = path.join(config.projectsRoot, projectId);
  const tsxCli = path.join(config.repositoryRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (job.action === 'produce-video') {
    return {
      executable,
      cwd: config.repositoryRoot,
      args: [
        tsxCli,
        path.join(config.repositoryRoot, 'scripts', 'paper-collage-production.ts'),
        path.join(config.dataRoot, 'creations', projectId),
        path.join(config.outputRoot, projectId),
      ],
    };
  }
  if (job.action === 'detect-runtime') {
    return {
      executable,
      cwd: config.repositoryRoot,
      args: [tsxCli, path.join(config.repositoryRoot, 'scripts/local-production-cli.ts'), 'detect', projectRoot, '--summary'],
    };
  }
  if (job.action === 'generate-shot') {
    if (!job.shotId) throw new Error('SHOT_ID_REQUIRED');
    return {executable, cwd: config.repositoryRoot, args: [tsxCli, path.join(config.repositoryRoot, 'scripts/local-production-cli.ts'), 'generate', projectRoot, assertSafeId(job.shotId, 'SHOT_ID')]};
  }
  if (job.action === 'synthesize-narration') {
    return {executable, cwd: config.repositoryRoot, args: [tsxCli, path.join(config.repositoryRoot, 'scripts/synthesize-production.ts'), projectRoot]};
  }
  return {
    executable,
    cwd: config.repositoryRoot,
    args: [
      tsxCli,
      path.join(config.repositoryRoot, 'scripts/render-production.ts'),
      projectRoot,
      path.join(config.outputRoot, projectId),
    ],
  };
};

export const parseJobProgress = (line: string, current: number): number => {
  try {
    const event = JSON.parse(line) as {event?: string; progress?: number};
    if (
      (event.event === 'render-progress'
        || event.event === 'quick-progress'
        || event.event === 'paper-collage-progress')
      && typeof event.progress === 'number'
    ) {
      return Math.max(current, Math.min(0.98, event.progress));
    }
  } catch {
    // Human-readable provider logs are expected.
  }
  const percent = line.match(/\b(\d{1,3})%/u)?.[1];
  if (percent !== undefined) return Math.max(current, Math.min(0.98, Number(percent) / 100));
  return current;
};

export const tryParseJobResult = (stdout: string): unknown => {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try { return JSON.parse(trimmed) as unknown; } catch { /* Multiple JSON events may precede the result. */ }
  for (let cursor = trimmed.lastIndexOf('\n{'); cursor >= 0; cursor = trimmed.lastIndexOf('\n{', cursor - 1)) {
    try { return JSON.parse(trimmed.slice(cursor + 1)) as unknown; } catch { /* Continue to the previous object. */ }
  }
  return {output: trimmed.slice(-16_000)};
};

export const meaningfulJobError = (logs: readonly StudioJobLog[], fallback: string): string => {
  const stderr = [...logs].reverse().filter((entry) => entry.stream === 'stderr');
  return stderr.find((entry) => !/^\s*at\s/u.test(entry.text) && !/^Node\.js\s/u.test(entry.text))?.text
    ?? stderr[0]?.text
    ?? fallback;
};

export class StudioJobRunner {
  private jobs: StudioJob[] = [];
  private active: {jobId: string; process: ChildProcess} | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly config: StudioConfig) {}

  async initialize(): Promise<void> {
    await fs.mkdir(path.dirname(this.config.jobsFile), {recursive: true});
    try {
      const stored = JSON.parse(await fs.readFile(this.config.jobsFile, 'utf8')) as StudioJob[];
      const now = new Date().toISOString();
      this.jobs = stored.map((job) => job.status === 'running'
        ? {...job, status: 'interrupted', finishedAt: now, error: 'Codex Studio stopped while this job was running.'}
        : job);
      await this.persist();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await this.persist();
    }
    this.pump();
  }

  list(): StudioJob[] {
    return structuredClone(this.jobs.slice().sort((left, right) => right.createdAt.localeCompare(left.createdAt)));
  }

  get(jobId: string): StudioJob {
    const job = this.jobs.find((entry) => entry.id === jobId);
    if (!job) throw new Error('STUDIO_JOB_NOT_FOUND');
    return structuredClone(job);
  }

  async start(action: StudioJobAction, projectIdValue: string, shotIdValue?: string): Promise<StudioJob> {
    const projectId = assertSafeId(projectIdValue, 'PROJECT_ID');
    const shotId = shotIdValue === undefined ? undefined : assertSafeId(shotIdValue, 'SHOT_ID');
    const duplicate = this.jobs.find((job) =>
      job.action === action && job.projectId === projectId && job.shotId === shotId
      && (job.status === 'queued' || job.status === 'running'));
    if (duplicate) return structuredClone(duplicate);
    const now = new Date().toISOString();
    const job: StudioJob = {
      id: randomUUID(),
      action,
      projectId,
      ...(shotId === undefined ? {} : {shotId}),
      status: 'queued',
      progress: 0,
      createdAt: now,
      logs: [{at: now, stream: 'system', text: 'Queued by Codex Studio.'}],
    };
    this.jobs.push(job);
    if (this.jobs.length > 200) this.jobs = this.jobs.slice(-200);
    await this.persist();
    this.pump();
    return structuredClone(job);
  }

  async cancel(jobId: string): Promise<StudioJob> {
    const job = this.jobs.find((entry) => entry.id === jobId);
    if (!job) throw new Error('STUDIO_JOB_NOT_FOUND');
    if (job.status !== 'queued' && job.status !== 'running') return structuredClone(job);
    const now = new Date().toISOString();
    job.status = 'cancelled';
    job.finishedAt = now;
    job.logs.push({at: now, stream: 'system', text: 'Cancellation requested.'});
    if (this.active?.jobId === job.id) this.active.process.kill('SIGTERM');
    await this.persist();
    this.pump();
    return structuredClone(job);
  }

  private pump(): void {
    if (this.active) return;
    const next = this.jobs.find((job) => job.status === 'queued');
    if (!next) return;
    void this.run(next).catch(async (error) => {
      const now = new Date().toISOString();
      next.status = 'failed';
      next.finishedAt = now;
      next.error = error instanceof Error ? error.message : String(error);
      next.logs.push({at: now, stream: 'system', text: next.error});
      this.active = null;
      await this.persist();
      this.pump();
    });
  }

  private async run(job: StudioJob): Promise<void> {
    const command = buildJobCommand(this.config, job);
    await fs.access(command.args[0]!);
    const startedAt = new Date().toISOString();
    job.status = 'running';
    job.startedAt = startedAt;
    job.progress = 0.01;
    job.logs.push({at: startedAt, stream: 'system', text: `Started ${job.action}.`});
    const child = spawn(command.executable, command.args, {
      cwd: command.cwd,
      env: {...process.env, FORCE_COLOR: '0'},
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.active = {jobId: job.id, process: child};
    await this.persist();

    let stdout = '';
    const onChunk = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      if (stream === 'stdout') stdout = (stdout + text).slice(-128_000);
      for (const line of text.split(/\r?\n/u).filter(Boolean)) {
        job.logs.push({at: new Date().toISOString(), stream, text: line.slice(0, 4_000)});
        job.progress = parseJobProgress(line, job.progress);
      }
      if (job.logs.length > 160) job.logs.splice(0, job.logs.length - 160);
      void this.persist();
    };
    child.stdout.on('data', (chunk: Buffer) => onChunk('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => onChunk('stderr', chunk));

    const exit = await new Promise<{code: number | null; signal: NodeJS.Signals | null}>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({code, signal}));
    });
    const finishedAt = new Date().toISOString();
    this.active = null;
    if ((job.status as StudioJobStatus) === 'cancelled') {
      job.logs.push({at: finishedAt, stream: 'system', text: `Stopped (${exit.signal ?? exit.code ?? 'unknown'}).`});
    } else if (exit.code === 0) {
      job.status = 'complete';
      job.progress = 1;
      job.finishedAt = finishedAt;
      const result = tryParseJobResult(stdout);
      if (result !== undefined) job.result = result;
      job.logs.push({at: finishedAt, stream: 'system', text: 'Completed successfully.'});
    } else {
      job.status = 'failed';
      job.finishedAt = finishedAt;
      job.error = meaningfulJobError(job.logs, `Process exited with code ${String(exit.code)}.`);
      job.logs.push({at: finishedAt, stream: 'system', text: job.error});
    }
    await this.persist();
    this.pump();
  }

  private async persist(): Promise<void> {
    const snapshot = `${JSON.stringify(this.jobs, null, 2)}\n`;
    this.writeChain = this.writeChain.then(async () => {
      await fs.mkdir(path.dirname(this.config.jobsFile), {recursive: true});
      const temporary = `${this.config.jobsFile}.${process.pid}.tmp`;
      await fs.writeFile(temporary, snapshot, 'utf8');
      await fs.rename(temporary, this.config.jobsFile);
    });
    await this.writeChain;
  }
}

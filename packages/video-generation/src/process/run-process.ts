import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { once } from 'node:events';

export type ProcessLineSource = 'stdout' | 'stderr';

export type SpawnManagedProcessOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  windowsHide?: boolean;
  signal?: AbortSignal;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
};

export type ProcessExit = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
};

export type ManagedProcess = {
  readonly child: ChildProcessWithoutNullStreams;
  readonly exited: Promise<ProcessExit>;
  write(data: string | Uint8Array): Promise<void>;
  endInput(): void;
  terminate(gracePeriodMs?: number): Promise<ProcessExit>;
};

export type RunProcessOptions = SpawnManagedProcessOptions & {
  timeoutMs?: number;
  maxOutputBytes?: number;
  allowNonZeroExit?: boolean;
};

export type RunProcessResult = ProcessExit & {
  stdout: string;
  stderr: string;
};

export class ProcessExecutionError extends Error {
  readonly command: string;
  readonly args: readonly string[];
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly cause?: unknown;

  constructor(options: {
    message: string;
    command: string;
    args: readonly string[];
    exitCode?: number | null;
    signal?: NodeJS.Signals | null;
    stdout?: string;
    stderr?: string;
    cause?: unknown;
  }) {
    super(options.message);
    this.name = 'ProcessExecutionError';
    this.command = options.command;
    this.args = [...options.args];
    this.exitCode = options.exitCode ?? null;
    this.signal = options.signal ?? null;
    this.stdout = options.stdout ?? '';
    this.stderr = options.stderr ?? '';
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

function attachLineReader(
  stream: NodeJS.ReadableStream,
  callback: ((line: string) => void) | undefined,
): void {
  if (callback === undefined) {
    return;
  }

  let buffered = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buffered += chunk;
    let newline = buffered.indexOf('\n');
    while (newline >= 0) {
      const line = buffered.slice(0, newline).replace(/\r$/, '');
      buffered = buffered.slice(newline + 1);
      callback(line);
      newline = buffered.indexOf('\n');
    }
  });
  stream.on('end', () => {
    if (buffered.length > 0) {
      callback(buffered.replace(/\r$/, ''));
    }
  });
}

/**
 * Spawn without a shell.  Keeping command and arguments separate is important on
 * Windows: paths containing spaces or Chinese characters must never be rebuilt
 * into a shell command string.
 */
export function spawnManagedProcess(
  command: string,
  args: readonly string[] = [],
  options: SpawnManagedProcessOptions = {},
): ManagedProcess {
  const spawnOptions: SpawnOptionsWithoutStdio = {
    shell: false,
    windowsHide: options.windowsHide ?? true,
    env: { ...process.env, ...options.env },
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  };
  const child = spawn(command, [...args], {
    ...spawnOptions,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  attachLineReader(child.stdout, options.onStdoutLine);
  attachLineReader(child.stderr, options.onStderrLine);

  const exited = new Promise<ProcessExit>((resolve, reject) => {
    child.once('error', (cause) => {
      reject(
        new ProcessExecutionError({
          message: `Unable to start process: ${command}`,
          command,
          args,
          cause,
        }),
      );
    });
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
  });

  const abort = (): void => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
    }
  };
  if (options.signal !== undefined) {
    if (options.signal.aborted) {
      abort();
    } else {
      options.signal.addEventListener('abort', abort, { once: true });
      const removeAbortListener = (): void => options.signal?.removeEventListener('abort', abort);
      void exited.then(removeAbortListener, removeAbortListener);
    }
  }

  return {
    child,
    exited,
    async write(data: string | Uint8Array): Promise<void> {
      if (child.stdin.destroyed || !child.stdin.writable) {
        throw new ProcessExecutionError({
          message: `Process stdin is not writable: ${command}`,
          command,
          args,
        });
      }
      if (!child.stdin.write(data)) {
        await once(child.stdin, 'drain');
      }
    },
    endInput(): void {
      if (!child.stdin.destroyed) {
        child.stdin.end();
      }
    },
    async terminate(gracePeriodMs = 3_000): Promise<ProcessExit> {
      if (child.exitCode !== null || child.signalCode !== null) {
        return exited;
      }
      child.kill('SIGTERM');
      let timer: NodeJS.Timeout | undefined;
      const forceKill = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
          }
          reject(new Error('Process did not stop during the grace period'));
        }, gracePeriodMs);
        timer.unref();
      });
      try {
        return await Promise.race([exited, forceKill]);
      } catch {
        return exited;
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      }
    },
  };
}

export async function runProcess(
  command: string,
  args: readonly string[] = [],
  options: RunProcessOptions = {},
): Promise<RunProcessResult> {
  const maxOutputBytes = options.maxOutputBytes ?? 8 * 1024 * 1024;
  let stdout = '';
  let stderr = '';

  const append = (current: string, chunk: Buffer | string): string => {
    const next = current + (typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    if (Buffer.byteLength(next) <= maxOutputBytes) {
      return next;
    }
    return Buffer.from(next).subarray(-maxOutputBytes).toString('utf8');
  };

  const managed = spawnManagedProcess(command, args, options);
  managed.child.stdout.on('data', (chunk: Buffer | string) => {
    stdout = append(stdout, chunk);
  });
  managed.child.stderr.on('data', (chunk: Buffer | string) => {
    stderr = append(stderr, chunk);
  });

  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    if (options.timeoutMs === undefined) {
      return;
    }
    timeout = setTimeout(() => {
      void managed.terminate();
      reject(
        new ProcessExecutionError({
          message: `Process timed out after ${options.timeoutMs} ms: ${command}`,
          command,
          args,
          stdout,
          stderr,
        }),
      );
    }, options.timeoutMs);
    timeout.unref();
  });

  try {
    const result = await Promise.race([managed.exited, timeoutPromise]);
    const fullResult: RunProcessResult = { ...result, stdout, stderr };
    if (result.exitCode !== 0 && options.allowNonZeroExit !== true) {
      throw new ProcessExecutionError({
        message: `Process exited with code ${String(result.exitCode)}: ${command}`,
        command,
        args,
        exitCode: result.exitCode,
        signal: result.signal,
        stdout,
        stderr,
      });
    }
    return fullResult;
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

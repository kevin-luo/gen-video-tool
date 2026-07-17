import {spawn} from 'node:child_process';

import {LocalTtsError, type LocalProcessAdapter, type LocalProcessRequest, type LocalProcessResult} from './types';

const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;

const appendBounded = (current: string, chunk: Buffer | string): string => {
  const next = current + (typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
  const bytes = Buffer.from(next, 'utf8');
  return bytes.length <= MAX_CAPTURE_BYTES ? next : bytes.subarray(-MAX_CAPTURE_BYTES).toString('utf8');
};

export class NodeLocalProcessAdapter implements LocalProcessAdapter {
  public async run(request: LocalProcessRequest): Promise<LocalProcessResult> {
    if (request.signal?.aborted === true) {
      throw new LocalTtsError('LOCAL_TTS_ABORTED', 'Local F5-TTS generation was cancelled');
    }

    return new Promise<LocalProcessResult>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      let timedOut = false;
      let aborted = false;
      let forceKillTimer: NodeJS.Timeout | undefined;
      const child = spawn(request.command, [...request.args], {
        cwd: request.cwd,
        env: {...process.env, ...request.environment},
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      child.stdout.on('data', (chunk: Buffer | string) => { stdout = appendBounded(stdout, chunk); });
      child.stderr.on('data', (chunk: Buffer | string) => { stderr = appendBounded(stderr, chunk); });

      const stop = (): void => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill('SIGTERM');
        forceKillTimer ??= setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }, 2_000);
        forceKillTimer.unref();
      };
      const onAbort = (): void => { aborted = true; stop(); };
      request.signal?.addEventListener('abort', onAbort, {once: true});
      const timer = setTimeout(() => { timedOut = true; stop(); }, request.timeoutMs);
      timer.unref();

      const cleanup = (): void => {
        clearTimeout(timer);
        if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
        request.signal?.removeEventListener('abort', onAbort);
      };
      child.once('error', (cause) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new LocalTtsError('LOCAL_TTS_PROCESS_FAILED', `Unable to start local F5-TTS: ${request.command}`, {
          details: {command: request.command},
          cause,
        }));
      });
      child.once('close', (exitCode, signal) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (aborted) {
          reject(new LocalTtsError('LOCAL_TTS_ABORTED', 'Local F5-TTS generation was cancelled'));
          return;
        }
        if (timedOut) {
          reject(new LocalTtsError('LOCAL_TTS_PROCESS_FAILED', `Local F5-TTS timed out after ${request.timeoutMs} ms`, {
            details: {command: request.command, timeoutMs: request.timeoutMs, stderr},
          }));
          return;
        }
        resolve({exitCode, signal, stdout, stderr});
      });
    });
  }
}

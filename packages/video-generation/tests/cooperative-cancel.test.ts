import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  raceWithAbortSignal,
  settleCooperativeCancellation,
} from '../src/orchestration/cooperative-cancel';

type Job = {status: 'running' | 'cancelled'; progress: number};

afterEach(() => {
  vi.useRealTimers();
});

describe('bounded cooperative cancellation', () => {
  it('converges at the deadline even when the cancellation RPC never settles', async () => {
    vi.useFakeTimers();
    const pending = settleCooperativeCancellation<Job>({
      initialValue: {status: 'running', progress: 0.4},
      requestCancel: async () => await new Promise<void>(() => undefined),
      readStatus: async () => ({status: 'running', progress: 0.4}),
      isTerminal: (job) => job.status === 'cancelled',
      timeoutMs: 1_000,
      pollIntervalMs: 100,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toMatchObject({
      outcome: 'deadline',
      value: {status: 'running', progress: 0.4},
    });
  });

  it('returns the backend-confirmed terminal state before the deadline', async () => {
    vi.useFakeTimers();
    let polls = 0;
    const pending = settleCooperativeCancellation<Job>({
      initialValue: {status: 'running', progress: 0.4},
      requestCancel: async () => undefined,
      readStatus: async () => {
        polls += 1;
        return polls >= 2
          ? {status: 'cancelled', progress: 0.5}
          : {status: 'running', progress: 0.5};
      },
      isTerminal: (job) => job.status === 'cancelled',
      timeoutMs: 1_000,
      pollIntervalMs: 100,
    });

    await vi.advanceTimersByTimeAsync(250);
    await expect(pending).resolves.toMatchObject({
      outcome: 'terminal',
      value: {status: 'cancelled'},
    });
  });

  it('detaches a pending provider operation as soon as the owning run aborts', async () => {
    const controller = new AbortController();
    const pending = raceWithAbortSignal(new Promise<Job>(() => undefined), controller.signal);
    controller.abort();
    await expect(pending).resolves.toEqual({outcome: 'aborted'});
  });
});

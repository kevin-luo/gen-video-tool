export type AbortRaceResult<T> =
  | {outcome: 'completed'; value: T}
  | {outcome: 'aborted'};

/**
 * Stop awaiting an operation when the owning desktop run is cancelled. The
 * operation itself is allowed to settle in the background, with both resolve
 * and reject handlers attached so a late failure cannot become unhandled.
 */
export const raceWithAbortSignal = async <T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<AbortRaceResult<T>> => {
  if (signal.aborted) {
    void operation.catch(() => undefined);
    return {outcome: 'aborted'};
  }
  return await new Promise<AbortRaceResult<T>>((resolve, reject) => {
    let settled = false;
    const finish = (result: AbortRaceResult<T>): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onAbort = (): void => finish({outcome: 'aborted'});
    signal.addEventListener('abort', onAbort, {once: true});
    void operation.then(
      (value) => finish({outcome: 'completed', value}),
      (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
};

export type CooperativeCancellationResult<T> =
  | {outcome: 'terminal'; value: T; cancelError?: unknown; statusError?: unknown}
  | {outcome: 'deadline'; value: T; cancelError?: unknown; statusError?: unknown};

export type CooperativeCancellationOptions<T> = {
  initialValue: T;
  requestCancel: () => Promise<void>;
  readStatus: () => Promise<T>;
  isTerminal: (value: T) => boolean;
  onStatus?: (value: T) => void | Promise<void>;
  timeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  delay?: (milliseconds: number) => Promise<void>;
};

const defaultDelay = async (milliseconds: number): Promise<void> =>
  await new Promise((resolve) => setTimeout(resolve, milliseconds));

type DeadlineResult<T> = {outcome: 'completed'; value: T} | {outcome: 'deadline'};

const beforeDeadline = async <T>(
  operation: Promise<T>,
  deadlineAt: number,
  now: () => number,
): Promise<DeadlineResult<T>> => {
  const remaining = deadlineAt - now();
  if (remaining <= 0) {
    void operation.catch(() => undefined);
    return {outcome: 'deadline'};
  }
  return await new Promise<DeadlineResult<T>>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({outcome: 'deadline'});
    }, remaining);
    void operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve({outcome: 'completed', value});
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
};

/**
 * Request WanGP's cooperative cancellation, then poll only until a fixed
 * deadline. A non-cooperating backend is reported as `deadline`; callers can
 * persist an interrupted local state and release their run lock without ever
 * claiming that the remote/local backend confirmed cancellation.
 */
export const settleCooperativeCancellation = async <T>(
  options: CooperativeCancellationOptions<T>,
): Promise<CooperativeCancellationResult<T>> => {
  const now = options.now ?? Date.now;
  const delay = options.delay ?? defaultDelay;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('CANCELLATION_TIMEOUT_INVALID');
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) throw new Error('CANCELLATION_POLL_INTERVAL_INVALID');
  let value = options.initialValue;
  if (options.isTerminal(value)) return {outcome: 'terminal', value};

  const deadlineAt = now() + timeoutMs;
  let cancelError: unknown;
  let statusError: unknown;
  try {
    const cancel = await beforeDeadline(options.requestCancel(), deadlineAt, now);
    if (cancel.outcome === 'deadline') return {outcome: 'deadline', value};
  } catch (error) {
    cancelError = error;
  }

  while (now() < deadlineAt) {
    await delay(Math.min(pollIntervalMs, Math.max(0, deadlineAt - now())));
    if (now() >= deadlineAt) break;
    try {
      const status = await beforeDeadline(options.readStatus(), deadlineAt, now);
      if (status.outcome === 'deadline') break;
      value = status.value;
      await options.onStatus?.(value);
      if (options.isTerminal(value)) {
        return {
          outcome: 'terminal',
          value,
          ...(cancelError === undefined ? {} : {cancelError}),
          ...(statusError === undefined ? {} : {statusError}),
        };
      }
    } catch (error) {
      statusError = error;
    }
  }
  return {
    outcome: 'deadline',
    value,
    ...(cancelError === undefined ? {} : {cancelError}),
    ...(statusError === undefined ? {} : {statusError}),
  };
};

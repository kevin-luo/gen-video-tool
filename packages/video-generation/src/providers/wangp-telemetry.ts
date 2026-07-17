import type {VideoGenerationMetrics} from './provider.js';

export type WanGPTelemetryEvent = {
  kind: string;
  timestamp?: number | string;
  data?: unknown;
};

type PhaseKey = 'modelLoadMs' | 'textEncodeMs' | 'denoiseMs' | 'vaeDecodeMs' | 'providerOutputMs';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const eventTimeMs = (value: number | string | undefined): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 10_000_000_000 ? value * 1000 : value;
  if (typeof value !== 'string') return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const phaseText = (event: WanGPTelemetryEvent): string => {
  if (typeof event.data === 'string') return `${event.kind} ${event.data}`.toLowerCase();
  if (!isRecord(event.data)) return event.kind.toLowerCase();
  return `${event.kind} ${String(event.data.phase ?? '')} ${String(event.data.raw_phase ?? '')} ${String(event.data.status ?? '')}`.toLowerCase();
};

const phaseKey = (event: WanGPTelemetryEvent): PhaseKey | undefined => {
  const text = phaseText(event);
  if (/loading_model|loading model|model load/.test(text)) return 'modelLoadMs';
  if (/encoding_text|encoding prompt|encoding text|text encod/.test(text)) return 'textEncodeMs';
  if (/inference_stage|denois|sampl|diffusion/.test(text)) return 'denoiseMs';
  if (/vae.*decod|decoding|decode latent/.test(text)) return 'vaeDecodeMs';
  if (/downloading_output|saving|saved|output|artifact/.test(text)) return 'providerOutputMs';
  return undefined;
};

const eventFingerprint = (event: WanGPTelemetryEvent): string => {
  let data: string;
  try { data = JSON.stringify(event.data); }
  catch { data = String(event.data); }
  return `${String(event.timestamp)}\0${event.kind}\0${data}`;
};

export class WanGPTelemetryTracker {
  readonly #startedAtMs: number;
  readonly #startupMs: number | undefined;
  readonly #seen = new Set<string>();
  readonly #durations: Partial<Record<PhaseKey, number>> = {};
  #activePhase: {key: PhaseKey; startedAtMs: number} | undefined;
  #lastEventAtMs: number | undefined;
  #finishedAtMs: number | undefined;

  constructor(options: {startedAtMs?: number; startupMs?: number} = {}) {
    this.#startedAtMs = options.startedAtMs ?? Date.now();
    this.#startupMs = options.startupMs;
  }

  ingest(events: readonly WanGPTelemetryEvent[], done = false, nowMs = Date.now()): VideoGenerationMetrics {
    const ordered = events
      .map((event) => ({event, time: eventTimeMs(event.timestamp)}))
      .filter((entry): entry is {event: WanGPTelemetryEvent; time: number} => entry.time !== undefined)
      .sort((left, right) => left.time - right.time);
    for (const {event, time} of ordered) {
      const fingerprint = eventFingerprint(event);
      if (this.#seen.has(fingerprint)) continue;
      this.#seen.add(fingerprint);
      this.#lastEventAtMs = Math.max(this.#lastEventAtMs ?? time, time);
      const nextPhase = phaseKey(event);
      if (nextPhase === undefined || this.#activePhase?.key === nextPhase) continue;
      this.#closeActive(time);
      this.#activePhase = {key: nextPhase, startedAtMs: time};
    }
    if (done && this.#finishedAtMs === undefined) {
      this.#finishedAtMs = this.#lastEventAtMs ?? nowMs;
      this.#closeActive(this.#finishedAtMs);
    }
    return this.snapshot(nowMs);
  }

  snapshot(nowMs = Date.now()): VideoGenerationMetrics {
    const durations = {...this.#durations};
    if (this.#activePhase !== undefined) {
      durations[this.#activePhase.key] = (durations[this.#activePhase.key] ?? 0)
        + Math.max(0, (this.#finishedAtMs ?? nowMs) - this.#activePhase.startedAtMs);
    }
    const rounded = Object.fromEntries(
      Object.entries(durations).map(([key, value]) => [key, Math.round(value)]),
    ) as Partial<Record<PhaseKey, number>>;
    return {
      ...(this.#startupMs === undefined ? {} : {providerStartupMs: Math.round(this.#startupMs)}),
      ...rounded,
      generationTotalMs: Math.max(0, Math.round((this.#finishedAtMs ?? nowMs) - this.#startedAtMs)),
    };
  }

  #closeActive(atMs: number): void {
    if (this.#activePhase === undefined) return;
    this.#durations[this.#activePhase.key] = (this.#durations[this.#activePhase.key] ?? 0)
      + Math.max(0, atMs - this.#activePhase.startedAtMs);
    this.#activePhase = undefined;
  }
}

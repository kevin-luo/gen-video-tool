import {execFile} from 'node:child_process';
import os from 'node:os';
import {promisify} from 'node:util';

import type {VideoGenerationMetrics} from '../providers/provider.js';

const execFileAsync = promisify(execFile);

export type LocalResourceSamplerOptions = {
  intervalMs?: number;
  gpuQuery?: () => Promise<number | undefined>;
  ramQuery?: () => number;
};

const queryNvidiaVramMb = async (): Promise<number | undefined> => {
  try {
    const result = await execFileAsync(
      'nvidia-smi',
      ['--query-gpu=memory.used', '--format=csv,noheader,nounits'],
      {encoding: 'utf8', timeout: 5_000, windowsHide: true, maxBuffer: 64 * 1024},
    );
    const values = result.stdout.split(/\r?\n/)
      .map((line) => Number(line.trim()))
      .filter(Number.isFinite);
    return values.length === 0 ? undefined : Math.max(...values);
  } catch {
    return undefined;
  }
};

export class LocalResourceSampler {
  readonly #intervalMs: number;
  readonly #gpuQuery: () => Promise<number | undefined>;
  readonly #ramQuery: () => number;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #pending: Promise<void> | undefined;
  #stopped = false;
  #peakVramMb = 0;
  #peakRamMb = 0;

  constructor(options: LocalResourceSamplerOptions = {}) {
    this.#intervalMs = Math.max(250, Math.round(options.intervalMs ?? 750));
    this.#gpuQuery = options.gpuQuery ?? queryNvidiaVramMb;
    this.#ramQuery = options.ramQuery ?? (() => (os.totalmem() - os.freemem()) / 1024 / 1024);
  }

  start(): void {
    if (this.#pending !== undefined || this.#timer !== undefined) return;
    this.#stopped = false;
    this.#schedule(0);
  }

  async stop(): Promise<Pick<VideoGenerationMetrics, 'peakVramMb' | 'peakRamMb'>> {
    this.#stopped = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#pending;
    return {
      ...(this.#peakVramMb <= 0 ? {} : {peakVramMb: Math.round(this.#peakVramMb)}),
      ...(this.#peakRamMb <= 0 ? {} : {peakRamMb: Math.round(this.#peakRamMb)}),
    };
  }

  #schedule(delayMs: number): void {
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#pending = this.#sample().finally(() => {
        this.#pending = undefined;
        if (!this.#stopped) this.#schedule(this.#intervalMs);
      });
    }, delayMs);
  }

  async #sample(): Promise<void> {
    const ramMb = this.#ramQuery();
    if (Number.isFinite(ramMb)) this.#peakRamMb = Math.max(this.#peakRamMb, ramMb);
    const vramMb = await this.#gpuQuery();
    if (vramMb !== undefined && Number.isFinite(vramMb)) {
      this.#peakVramMb = Math.max(this.#peakVramMb, vramMb);
    }
  }
}

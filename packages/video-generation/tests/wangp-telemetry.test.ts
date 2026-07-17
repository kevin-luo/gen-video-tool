import {describe, expect, it} from 'vitest';

import {WanGPTelemetryTracker} from '../src/providers/wangp-telemetry';

describe('WanGP phase telemetry', () => {
  it('deduplicates repeated MCP snapshots and measures normalized WanGP phases', () => {
    const tracker = new WanGPTelemetryTracker({startedAtMs: 1_000, startupMs: 750});
    const events = [
      {kind: 'progress', timestamp: 1, data: {phase: 'loading_model'}},
      {kind: 'progress', timestamp: 3, data: {phase: 'encoding_text'}},
      {kind: 'progress', timestamp: 4, data: {phase: 'inference_stage_1', current_step: 1}},
      {kind: 'progress', timestamp: 9, data: {phase: 'decoding'}},
      {kind: 'progress', timestamp: 11, data: {phase: 'downloading_output'}},
      {kind: 'completed', timestamp: 12, data: {success: true}},
    ];

    tracker.ingest(events.slice(0, 4), false, 9_000);
    const metrics = tracker.ingest(events, true, 12_000);
    expect(metrics).toEqual({
      providerStartupMs: 750,
      modelLoadMs: 2_000,
      textEncodeMs: 1_000,
      denoiseMs: 5_000,
      vaeDecodeMs: 2_000,
      providerOutputMs: 1_000,
      generationTotalMs: 11_000,
    });
  });

  it('understands human-readable WanGP status events', () => {
    const tracker = new WanGPTelemetryTracker({startedAtMs: 10_000});
    tracker.ingest([
      {kind: 'status', timestamp: 10, data: 'Loading model'},
      {kind: 'status', timestamp: 12, data: 'Encoding prompt'},
      {kind: 'status', timestamp: 13, data: 'Denoising first pass'},
      {kind: 'status', timestamp: 16, data: 'VAE decoding'},
    ], true, 18_000);

    expect(tracker.snapshot(18_000)).toMatchObject({
      modelLoadMs: 2_000,
      textEncodeMs: 1_000,
      denoiseMs: 3_000,
      generationTotalMs: 6_000,
    });
  });
});


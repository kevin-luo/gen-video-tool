import {describe, expect, it} from 'vitest';
import {parseSrt} from '@gen-video-tool/asset-pack';

describe('SRT validation', () => {
  it('accepts UTF-8 BOM and CRLF', () => {
    const result = parseSrt('\uFEFF1\r\n00:00:00,000 --> 00:00:01,200\r\n第一句\r\n\r\n2\r\n00:00:01,200 --> 00:00:02,000\r\nSecond\r\n');
    expect(result.diagnostics).toEqual([]);
    expect(result.cues).toHaveLength(2);
    expect(result.cues[1]?.endMs).toBe(2_000);
  });

  it('reports invalid timing and overlap with stable codes', () => {
    const invalid = parseSrt('1\n00:00:02,000 --> 00:00:01,000\nBad');
    expect(invalid.diagnostics[0]?.code).toBe('SRT_TIME_INVALID');

    const overlap = parseSrt('1\n00:00:00,000 --> 00:00:02,000\nA\n\n2\n00:00:01,500 --> 00:00:03,000\nB');
    expect(overlap.diagnostics.some((item) => item.code === 'SRT_OVERLAP' && item.severity === 'warning')).toBe(true);
  });
});

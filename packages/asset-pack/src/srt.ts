import {diagnostic} from './diagnostics';
import type {AssetPackDiagnostic} from './types';

export interface SrtCue {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
}

export interface SrtParseResult {
  cues: SrtCue[];
  diagnostics: AssetPackDiagnostic[];
}

const parseTimestamp = (value: string): number | null => {
  const match = /^(\d{2,}):([0-5]\d):([0-5]\d),(\d{3})$/u.exec(value.trim());
  if (!match) return null;
  const [, hoursText, minutesText, secondsText, millisecondsText] = match;
  if (!hoursText || !minutesText || !secondsText || !millisecondsText) return null;
  const hours = Number(hoursText);
  const minutes = Number(minutesText);
  const seconds = Number(secondsText);
  const milliseconds = Number(millisecondsText);
  return (((hours * 60) + minutes) * 60 + seconds) * 1_000 + milliseconds;
};

export const parseSrt = (content: string, assetPath = 'subtitles.srt'): SrtParseResult => {
  const normalized = content.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n').trim();
  const diagnostics: AssetPackDiagnostic[] = [];
  if (!normalized) return {cues: [], diagnostics};
  const blocks = normalized.split(/\n{2,}/u);
  const cues: SrtCue[] = [];
  let previousIndex = 0;
  let previousStart = -1;
  let previousEnd = -1;

  blocks.forEach((block, blockIndex) => {
    const lines = block.split('\n');
    const indexText = lines.shift()?.trim() ?? '';
    const timingText = lines.shift()?.trim() ?? '';
    const cueIndex = Number(indexText);
    if (!Number.isSafeInteger(cueIndex) || cueIndex < 1 || !timingText) {
      diagnostics.push(diagnostic('SRT_CORRUPT', 'error', `第 ${blockIndex + 1} 个字幕块缺少有效序号或时间行。`, {
        path: `/cues/${blockIndex}`,
        assetPath,
        suggestion: '请使用标准 SRT：序号、时间行、正文，各字幕块之间留空行。',
      }));
      return;
    }
    const timingMatch = /^(.*?)\s+-->\s+(.*?)(?:\s+.*)?$/u.exec(timingText);
    const startMs = timingMatch?.[1] ? parseTimestamp(timingMatch[1]) : null;
    const endMs = timingMatch?.[2] ? parseTimestamp(timingMatch[2]) : null;
    if (startMs === null || endMs === null || startMs >= endMs) {
      diagnostics.push(diagnostic('SRT_TIME_INVALID', 'error', `字幕 ${cueIndex} 的时间范围无效。`, {
        path: `/cues/${blockIndex}/time`,
        assetPath,
        suggestion: '时间格式应为 HH:MM:SS,mmm，且结束时间必须晚于开始时间。',
      }));
      return;
    }
    const text = lines.join('\n').trim();
    if (!text) {
      diagnostics.push(diagnostic('SRT_CORRUPT', 'error', `字幕 ${cueIndex} 没有正文。`, {
        path: `/cues/${blockIndex}/text`,
        assetPath,
      }));
      return;
    }
    if (cueIndex <= previousIndex || startMs < previousStart) {
      diagnostics.push(diagnostic('SRT_ORDER_INVALID', 'error', `字幕 ${cueIndex} 的序号或开始时间未递增。`, {
        path: `/cues/${blockIndex}`,
        assetPath,
        suggestion: '请按播放顺序排列字幕，并使用递增序号。',
      }));
    }
    if (previousEnd >= 0 && startMs < previousEnd) {
      diagnostics.push(diagnostic('SRT_OVERLAP', 'warning', `字幕 ${previousIndex} 与 ${cueIndex} 时间重叠。`, {
        path: `/cues/${blockIndex}/time`,
        assetPath,
        suggestion: '若不是刻意双行显示，请让上一条字幕先结束。',
      }));
    }
    cues.push({index: cueIndex, startMs, endMs, text});
    previousIndex = cueIndex;
    previousStart = startMs;
    previousEnd = endMs;
  });
  return {cues, diagnostics};
};

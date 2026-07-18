import {describe, expect, it} from 'vitest';

import {
  allocateQuickProductionNarrationTimings,
  buildQuickProductionShotPrompt,
  splitQuickProductionThoughts,
  stableQuickProductionSeed,
} from '../../../scripts/quick-production';

describe('quick production planning', () => {
  it('splits natural Chinese copy into reusable visual beats', () => {
    expect(splitQuickProductionThoughts('小猫支起摊位。第一锅炒粉下锅！香气引来客人。')).toEqual([
      '小猫支起摊位。',
      '第一锅炒粉下锅！',
      '香气引来客人。',
    ]);
  });

  it('keeps seeds stable per creation and shot', () => {
    expect(stableQuickProductionSeed('creation-a', 0)).toBe(stableQuickProductionSeed('creation-a', 0));
    expect(stableQuickProductionSeed('creation-a', 0)).not.toBe(stableQuickProductionSeed('creation-a', 1));
  });

  it('allocates one fast narration render back onto sidecar subtitle beats', () => {
    const segments = allocateQuickProductionNarrationTimings(['短句。', '这是一句更长的话。'], 9);
    expect(segments).toHaveLength(2);
    expect(segments[0]?.startSeconds).toBe(0);
    expect(segments[1]?.endSeconds).toBe(9);
    expect(segments[1]!.durationSeconds).toBeGreaterThan(segments[0]!.durationSeconds);
  });

  it('adds real-world direction and anatomy constraints without requesting visible text', () => {
    const prompt = buildQuickProductionShotPrompt({
      schemaVersion: 1,
      id: 'creation-a',
      title: '小猫炒粉',
      script: '一只小猫在夜市摆摊卖炒粉。',
      platform: 'douyin',
      durationSeconds: 20,
      voice: true,
      subtitles: 'sidecar-srt',
      bgm: false,
    }, '小猫把炒粉盛进碗里。', 2);
    expect(prompt).toContain('actions have a clear target and direction');
    expect(prompt).toContain('hands and tools maintain contact');
    expect(prompt).toContain('gravity');
    expect(prompt).toContain('no text in image');
    expect(prompt).toContain('its own paws grip and move the tool');
    expect(prompt).toContain('Do not substitute an offscreen human hand');
  });

  it('changes visual direction for each supported publishing platform', () => {
    const base = {
      schemaVersion: 1 as const,
      id: 'creation-platform',
      title: '早餐',
      script: '清晨做一份热气腾腾的早餐。',
      durationSeconds: 20,
      voice: true,
      subtitles: 'sidecar-srt' as const,
      bgm: false as const,
    };
    expect(buildQuickProductionShotPrompt({...base, platform: 'douyin'}, base.script, 0)).toContain('immediate visual hook');
    expect(buildQuickProductionShotPrompt({...base, platform: 'xiaohongshu'}, base.script, 0)).toContain('lifestyle cinematography');
    expect(buildQuickProductionShotPrompt({...base, platform: 'wechat-channels'}, base.script, 0)).toContain('documentary tone');
  });
});

import type {VideoGenerationPreset} from '../providers/provider';

export type {VideoGenerationPreset} from '../providers/provider';

export const LOCAL_I2V_FAST_PORTRAIT_ID = 'local-i2v-fast-portrait' as const;
export const LOCAL_I2V_QUALITY_PORTRAIT_ID = 'local-i2v-quality-portrait' as const;

export const VIDEO_GENERATION_PRESETS = [
  {
    id: LOCAL_I2V_FAST_PORTRAIT_ID,
    label: 'Local I2V Fast Portrait',
    width: 480,
    height: 832,
    fps: 24,
    frameCount: 81,
    candidateCount: 2,
    qualityTier: 'preview',
    allowUpscale: true,
    allowInterpolation: false,
  },
  {
    id: LOCAL_I2V_QUALITY_PORTRAIT_ID,
    label: 'Local I2V Quality Portrait',
    width: 480,
    height: 832,
    fps: 24,
    frameCount: 81,
    candidateCount: 2,
    qualityTier: 'quality',
    allowUpscale: true,
    allowInterpolation: true,
  },
] as const satisfies readonly VideoGenerationPreset[];

export type BuiltInVideoGenerationPresetId = (typeof VIDEO_GENERATION_PRESETS)[number]['id'];

const PRESETS_BY_ID = new Map<string, VideoGenerationPreset>(
  VIDEO_GENERATION_PRESETS.map((preset) => [preset.id, preset]),
);

export const listVideoGenerationPresets = (): VideoGenerationPreset[] =>
  VIDEO_GENERATION_PRESETS.map((preset) => ({...preset}));

export const getVideoGenerationPreset = (presetId: string): VideoGenerationPreset | null => {
  const preset = PRESETS_BY_ID.get(presetId);
  return preset ? {...preset} : null;
};

export const requireVideoGenerationPreset = (presetId: string): VideoGenerationPreset => {
  const preset = getVideoGenerationPreset(presetId);
  if (!preset) throw new Error(`VIDEO_GENERATION_PRESET_UNKNOWN:${presetId}`);
  return preset;
};

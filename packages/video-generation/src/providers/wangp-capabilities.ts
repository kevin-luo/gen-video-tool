import {createHash} from 'node:crypto';

export type WanGPLocalTier = 'ultra-preview' | 'balanced-local' | 'quality-local';
export type WanGPAvailability = 'available' | 'partial' | 'missing' | 'unknown';
export type WanGPCacheKind = 'off' | 'tea' | 'mag';

export type WanGPAcceleratorProfileSource = {
  directory: string;
  label: string;
  relativePath: string;
  settings: Record<string, unknown>;
  source: 'mcp' | 'local-catalog';
};

export type WanGPAcceleratorProfile = WanGPAcceleratorProfileSource & {
  id: string;
  tags: string[];
  steps?: number;
  guidance?: number;
  acceleratorLoras: string[];
  loraMultipliers: string[];
};

export type WanGPModelCapability = {
  runtimeModelId: string;
  label: string;
  family?: string;
  baseModelType?: string;
  finetune: boolean;
  availability: WanGPAvailability;
  imageToVideo: boolean;
  tags: string[];
  profileDirectories: string[];
  defaultSettings: Record<string, unknown>;
  supportedResolutions: Array<{width: number; height: number}>;
  supportedFrameCounts: number[];
  frameMinimum?: number;
  frameStep?: number;
  defaultSteps?: number;
  defaultGuidance?: number;
  quantization: string[];
  cache: {tea: boolean; mag: boolean};
  raw: Record<string, unknown>;
  schema: Record<string, unknown>;
};

export type WanGPCachePolicy = {
  kind: WanGPCacheKind;
  multiplier?: number;
  reason: string;
};

export type WanGPTierSelection = {
  tier: WanGPLocalTier;
  available: boolean;
  configurationId: string;
  modelRuntimeId: string;
  modelLabel: string;
  acceleratorProfileId?: string;
  acceleratorProfileLabel?: string;
  width: number;
  height: number;
  fps: number;
  frameCount: 49 | 81;
  candidateCount: 1;
  steps: number;
  guidance: number;
  memoryProfile: 4;
  attention: 'auto';
  quantization: string[];
  cachePolicy: WanGPCachePolicy;
  reason: string;
};

export type WanGPCapabilityCatalog = {
  discoveredAt: string;
  source: 'wangp-mcp';
  models: WanGPModelCapability[];
  acceleratorProfiles: WanGPAcceleratorProfile[];
  tiers: WanGPTierSelection[];
};

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

const asFiniteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const asPositiveInteger = (value: unknown): number | undefined => {
  const number = asFiniteNumber(value);
  return number !== undefined && Number.isInteger(number) && number > 0 ? number : undefined;
};

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];

const serialize = (value: unknown): string => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const collectNamedValues = (value: unknown, pattern: RegExp): unknown[] => {
  const result: unknown[] = [];
  const visit = (entry: unknown, path: string): void => {
    if (isRecord(entry)) {
      for (const [key, nested] of Object.entries(entry)) visit(nested, path === '' ? key : `${path}.${key}`);
      return;
    }
    if (pattern.test(path)) result.push(entry);
  };
  visit(value, '');
  return result;
};

const collectStrings = (value: unknown): string[] => {
  if (typeof value === 'string' && value.trim() !== '') return [value.trim()];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (isRecord(value)) return Object.values(value).flatMap(collectStrings);
  return [];
};

const normalizeTagText = (value: unknown): string =>
  serialize(value).toLowerCase().replaceAll('_', ' ').replaceAll('-', ' ');

const deriveTags = (value: unknown): string[] => {
  const text = normalizeTagText(value);
  const tags: string[] = [];
  const add = (tag: string, pattern: RegExp) => { if (pattern.test(text)) tags.push(tag); };
  add('image-to-video', /image.?to.?video|image2video|\bi2v\b|textimage2video/);
  add('wan-2.2', /wan\s*2[.]?2|wan2\s*2/);
  add('fun-inp', /fun\s*inp/);
  add('fastwan', /fastwan/);
  add('enhanced-lightning', /enhanced\s*lightning/);
  add('lightning', /lightning/);
  add('lightx2v', /lightx2v|lightx\s*2v/);
  add('self-forcing', /self\s*forcing/);
  add('fusionix', /fusionix|fusionx/);
  add('distilled', /distill|lightning|fastwan|self\s*forcing|fusionix|fusionx/);
  add('two-step', /2\s*steps?|two\s*steps?/);
  add('four-step', /4\s*steps?|four\s*steps?/);
  add('five-billion', /\b5\s*b\b|5b/);
  add('one-point-three-billion', /1[.]?3\s*b|1[.]?3b/);
  add('fourteen-billion', /\b14\s*b\b|14b/);
  add('nvfp4', /nvfp4/);
  add('int8', /int8|quanto[_ -]?int8/);
  add('gguf', /gguf/);
  add('fp8', /\bfp8\b/);
  add('bf16', /\bbf16\b/);
  return unique(tags);
};

const availabilityFrom = (value: unknown): WanGPAvailability => {
  if (typeof value === 'string') {
    const status = value.toLowerCase();
    if (status === 'available' || status === 'partial' || status === 'missing') return status;
  }
  if (isRecord(value)) {
    const nested = availabilityFrom(value.status ?? value.state ?? value.availability);
    if (nested !== 'unknown') return nested;
    if (value.available === true || value.installed === true) return 'available';
    if (value.available === false || value.installed === false) return 'missing';
  }
  return 'unknown';
};

const resolutionValues = (value: unknown): Array<{width: number; height: number}> => {
  const values = collectNamedValues(value, /resolution/i).flatMap(collectStrings);
  const result: Array<{width: number; height: number}> = [];
  for (const raw of values) {
    const match = /^(\d{2,5})x(\d{2,5})$/i.exec(raw.trim());
    if (!match) continue;
    const width = Number(match[1]);
    const height = Number(match[2]);
    result.push({width, height});
    if (width !== height) result.push({width: height, height: width});
  }
  const byKey = new Map(result.map((item) => [`${item.width}x${item.height}`, item]));
  return [...byKey.values()];
};

const modelDefFromSchema = (schema: UnknownRecord): UnknownRecord =>
  isRecord(schema.model_def) ? schema.model_def : schema;

const profileDirectoriesFrom = (schema: UnknownRecord): string[] => {
  const modelDef = modelDefFromSchema(schema);
  return unique(
    collectStrings(modelDef.profiles_dir ?? modelDef.profile_dirs)
      .map((value) => value.replaceAll('\\', '/').replace(/^\/+|\/+$/g, ''))
      .filter(Boolean),
  );
};

const quantizationFrom = (value: unknown): string[] => {
  const tags = deriveTags(value);
  return ['int8', 'gguf', 'nvfp4', 'fp8', 'bf16'].filter((tag) => tags.includes(tag));
};

const imageToVideoFrom = (raw: UnknownRecord): boolean => {
  const capabilities = isRecord(raw.capabilities) ? raw.capabilities : {};
  const mediaInputs = isRecord(raw.media_inputs) ? raw.media_inputs : {};
  const image = isRecord(mediaInputs.image) ? mediaInputs.image : {};
  return capabilities.image_to_video === true
    || image.start === true
    || (Object.keys(capabilities).length === 0 && Object.keys(mediaInputs).length === 0);
};

export const buildWanGPModelCapability = (input: {
  raw: UnknownRecord;
  schema?: UnknownRecord;
  defaultSettings?: UnknownRecord;
}): WanGPModelCapability | null => {
  const raw = input.raw;
  const runtimeModelId = asString(raw.model_type ?? raw.modelType ?? raw.id);
  if (!runtimeModelId) return null;
  const schema = input.schema ?? {};
  const modelDef = modelDefFromSchema(schema);
  const modelSettings = isRecord(modelDef.settings) ? modelDef.settings : {};
  const defaultSettings = input.defaultSettings
    ?? (isRecord(schema.default_settings) ? schema.default_settings : {})
    ?? {};
  const frameMinimum = asPositiveInteger(modelDef.frames_minimum);
  const frameStep = asPositiveInteger(modelDef.frames_steps);
  const supportedFrameCounts = [49, 81].filter((frameCount) =>
    frameMinimum === undefined || frameStep === undefined || (
      frameCount >= frameMinimum && (frameCount - frameMinimum) % frameStep === 0
    ));
  const textSource = {raw, schema, defaultSettings};
  // Family, accelerator name and parameter count are identity facts.  Do not
  // infer them from nested checkpoint URLs or unrelated profile defaults,
  // otherwise a 10B model carrying a 5B helper checkpoint can masquerade as
  // the requested 5B runtime.
  const identityTags = deriveTags({
    runtimeModelId,
    label: raw.name ?? raw.label ?? raw.description,
    family: raw.family,
    baseModelType: raw.base_model_type ?? raw.baseModelType,
    modelDefName: modelDef.name ?? modelDef.label ?? modelDef.description,
  });
  const operationalTags = deriveTags(textSource).filter((tagName) => [
    'distilled', 'two-step', 'four-step', 'nvfp4', 'int8', 'gguf', 'fp8', 'bf16',
  ].includes(tagName));
  const tags = unique([...identityTags, ...operationalTags]);
  const defaultSteps = asPositiveInteger(defaultSettings.num_inference_steps)
    ?? asPositiveInteger(modelSettings.num_inference_steps);
  const defaultGuidance = asFiniteNumber(defaultSettings.guidance_scale)
    ?? asFiniteNumber(modelSettings.guidance_scale);
  const family = asString(raw.family);
  const baseModelType = asString(raw.base_model_type ?? raw.baseModelType);
  return {
    runtimeModelId,
    label: asString(raw.name ?? raw.label ?? raw.description) ?? runtimeModelId,
    ...(family === undefined ? {} : {family}),
    ...(baseModelType === undefined ? {} : {baseModelType}),
    finetune: raw.finetune === true,
    availability: availabilityFrom(raw.availability ?? raw.status),
    imageToVideo: imageToVideoFrom(raw),
    tags,
    profileDirectories: profileDirectoriesFrom(schema),
    defaultSettings: {...defaultSettings},
    supportedResolutions: resolutionValues(textSource),
    supportedFrameCounts,
    ...(frameMinimum === undefined ? {} : {frameMinimum}),
    ...(frameStep === undefined ? {} : {frameStep}),
    ...(defaultSteps === undefined ? {} : {defaultSteps}),
    ...(defaultGuidance === undefined ? {} : {defaultGuidance}),
    quantization: quantizationFrom(textSource),
    cache: {tea: modelDef.tea_cache === true, mag: modelDef.mag_cache === true},
    raw: {...raw},
    schema: {...schema},
  };
};

const normalizeMultipliers = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.flatMap((item) => asString(item) ?? []).filter(Boolean);
  const string = asString(value);
  return string === undefined ? [] : string.split(/\s+/).filter(Boolean);
};

export const buildWanGPAcceleratorProfile = (
  source: WanGPAcceleratorProfileSource,
): WanGPAcceleratorProfile => {
  const acceleratorLoras = collectStrings(source.settings.activated_loras);
  const loraMultipliers = normalizeMultipliers(source.settings.loras_multipliers);
  const tags = deriveTags({label: source.label, settings: source.settings, acceleratorLoras});
  const steps = asPositiveInteger(source.settings.num_inference_steps);
  const guidance = asFiniteNumber(source.settings.guidance_scale);
  const id = createHash('sha256')
    .update(`${source.directory}\0${source.relativePath}\0${serialize(source.settings)}`)
    .digest('hex')
    .slice(0, 20);
  return {
    ...source,
    id: `wangp-profile-${id}`,
    tags,
    ...(steps === undefined ? {} : {steps}),
    ...(guidance === undefined ? {} : {guidance}),
    acceleratorLoras,
    loraMultipliers,
  };
};

const profileCompatible = (
  model: WanGPModelCapability,
  profile: WanGPAcceleratorProfile,
): boolean => model.profileDirectories.includes(profile.directory);

const tag = (value: {tags: string[]}, name: string): boolean => value.tags.includes(name);

const availabilityScore = (availability: WanGPAvailability): number =>
  availability === 'available' ? 45 : availability === 'partial' ? 20 : availability === 'unknown' ? 5 : 0;

const modelIsRtx30Compatible = (model: WanGPModelCapability): boolean => !tag(model, 'nvfp4');

type ModelProfileOption = {model: WanGPModelCapability; profile?: WanGPAcceleratorProfile};

const optionScore = (option: ModelProfileOption, tier: WanGPLocalTier): number => {
  const {model, profile} = option;
  if (!model.imageToVideo || !modelIsRtx30Compatible(model)) return Number.NEGATIVE_INFINITY;
  let score = availabilityScore(model.availability);
  const has = (name: string) => tag(model, name) || (profile !== undefined && tag(profile, name));
  if (model.quantization.includes('int8') || model.quantization.includes('gguf')) score += 12;
  if (tier === 'ultra-preview') {
    if (has('self-forcing') && (profile?.steps === 2 || model.defaultSteps === 2 || has('two-step'))) score += 340;
    if (has('fun-inp') && tag(model, 'one-point-three-billion')) score += 300;
    if (tag(model, 'one-point-three-billion')) score += 40;
    if (has('fourteen-billion')) score -= 80;
  }
  if (tier === 'balanced-local') {
    if (has('fastwan') && tag(model, 'five-billion')) score += 360;
    if (has('fastwan')) score += 140;
    if (tag(model, 'wan-2.2')) score += 45;
    if (profile && tag(profile, 'fastwan')) score += 50;
  }
  if (tier === 'quality-local') {
    if (tag(model, 'enhanced-lightning') && tag(model, 'fourteen-billion')) score += 420;
    else if (has('lightx2v') && (profile?.steps === 4 || model.defaultSteps === 4 || has('four-step'))) score += 350;
    else if (has('fusionix')) score += 180;
    if (tag(model, 'fourteen-billion')) score += 50;
    if (tag(model, 'wan-2.2')) score += 35;
  }
  return score;
};

const optionPriority = (option: ModelProfileOption, tier: WanGPLocalTier): number => {
  const {model, profile} = option;
  if (!model.imageToVideo || !modelIsRtx30Compatible(model)) return -1;
  const has = (name: string) => tag(model, name) || (profile !== undefined && tag(profile, name));
  if (tier === 'ultra-preview') {
    if (has('self-forcing') && (profile?.steps === 2 || model.defaultSteps === 2 || has('two-step'))) return 4;
    if (has('fun-inp') && tag(model, 'one-point-three-billion')) return 3;
    if (tag(model, 'one-point-three-billion')) return 2;
    return 1;
  }
  if (tier === 'balanced-local') {
    if (has('fastwan') && tag(model, 'five-billion')) return 4;
    if (has('fastwan')) return 3;
    if (tag(model, 'wan-2.2') && tag(model, 'five-billion')) return 2;
    return 1;
  }
  if (tag(model, 'enhanced-lightning') && tag(model, 'fourteen-billion')) return 5;
  if (has('lightx2v') && (profile?.steps === 4 || model.defaultSteps === 4 || has('four-step'))) return 4;
  if (has('fusionix')) return 3;
  if (tag(model, 'fourteen-billion') && tag(model, 'wan-2.2')) return 2;
  return 1;
};

const choosePortraitResolution = (model: WanGPModelCapability): {width: number; height: number} => {
  const productionNative = model.supportedResolutions.find((resolution) =>
    resolution.width === 480 && resolution.height === 832);
  if (productionNative) return productionNative;
  // WanGP metadata currently reports one illustrative default resolution, not
  // an exhaustive allow-list. Keep the low-VRAM portrait generation raster
  // unless the MCP schema explicitly advertises the exact production native.
  if (model.supportedResolutions.length <= 2) return {width: 480, height: 832};
  const portrait = model.supportedResolutions
    .filter((resolution) => resolution.height > resolution.width)
    .sort((left, right) => Math.abs(left.width - 480) + Math.abs(left.height - 832)
      - Math.abs(right.width - 480) - Math.abs(right.height - 832))[0];
  return portrait ?? {width: 480, height: 832};
};

export const resolveWanGPCachePolicy = (input: {
  model: WanGPModelCapability;
  profile?: WanGPAcceleratorProfile;
  steps: number;
}): WanGPCachePolicy => {
  const distilled = tag(input.model, 'distilled')
    || (input.profile !== undefined && tag(input.profile, 'distilled'));
  if (input.steps <= 4) return {kind: 'off', reason: '4-step distilled runs keep TeaCache and MagCache disabled.'};
  if (distilled && input.steps < 8) return {kind: 'off', reason: 'Short distilled runs do not stack aggressive cache skipping.'};
  if (input.steps >= 8 && input.steps <= 12 && input.model.cache.tea) {
    return {kind: 'tea', multiplier: 1.5, reason: '8-12 step run uses conservative TeaCache 1.5.'};
  }
  if (!distilled && input.steps > 12) {
    if (input.model.cache.tea) return {kind: 'tea', multiplier: 2, reason: 'High-step base model allows TeaCache 2.0.'};
    if (input.model.cache.mag) return {kind: 'mag', multiplier: 2, reason: 'High-step base model allows MagCache.'};
  }
  return {kind: 'off', reason: 'Model metadata and step count do not justify cache skipping.'};
};

const tierReason = (tier: WanGPLocalTier, option: ModelProfileOption): string => {
  const profile = option.profile ? ` + ${option.profile.label}` : '';
  if (tier === 'ultra-preview') return `Fastest compatible I2V metadata match: ${option.model.label}${profile}.`;
  if (tier === 'balanced-local') return `RTX 30 balanced metadata match: ${option.model.label}${profile}.`;
  return `Highest-priority distilled quality metadata match: ${option.model.label}${profile}.`;
};

const configurationId = (tier: WanGPLocalTier, option: ModelProfileOption): string => {
  const fingerprint = createHash('sha256')
    .update(`${tier}\0${option.model.runtimeModelId}\0${option.profile?.id ?? ''}`)
    .digest('hex')
    .slice(0, 18);
  return `wangp-${tier}-${fingerprint}`;
};

export const resolveWanGPLocalTiers = (
  models: readonly WanGPModelCapability[],
  profiles: readonly WanGPAcceleratorProfile[],
): WanGPTierSelection[] => {
  const options: ModelProfileOption[] = [];
  for (const model of models) {
    options.push({model});
    for (const profile of profiles) if (profileCompatible(model, profile)) options.push({model, profile});
  }
  return (['ultra-preview', 'balanced-local', 'quality-local'] as const).flatMap((tier) => {
    const chosen = [...options].sort((left, right) => {
      const priority = optionPriority(right, tier) - optionPriority(left, tier);
      return priority !== 0 ? priority : optionScore(right, tier) - optionScore(left, tier);
    })[0];
    if (!chosen || !Number.isFinite(optionScore(chosen, tier))) return [];
    const steps = chosen.profile?.steps ?? chosen.model.defaultSteps
      ?? (tier === 'quality-local' ? 4 : tier === 'balanced-local' ? 6 : 20);
    const guidance = chosen.profile?.guidance ?? chosen.model.defaultGuidance
      ?? (steps <= 4 ? 1 : 5);
    const frameCount: 49 | 81 = tier === 'ultra-preview'
      ? 49
      : chosen.model.supportedFrameCounts.includes(81) ? 81 : 49;
    const resolution = choosePortraitResolution(chosen.model);
    return [{
      tier,
      available: chosen.model.availability === 'available',
      configurationId: configurationId(tier, chosen),
      modelRuntimeId: chosen.model.runtimeModelId,
      modelLabel: chosen.model.label,
      ...(chosen.profile === undefined ? {} : {
        acceleratorProfileId: chosen.profile.id,
        acceleratorProfileLabel: chosen.profile.label,
      }),
      ...resolution,
      fps: 24,
      frameCount,
      candidateCount: 1,
      steps,
      guidance,
      memoryProfile: 4,
      attention: 'auto',
      quantization: chosen.model.quantization,
      cachePolicy: resolveWanGPCachePolicy({
        model: chosen.model,
        ...(chosen.profile === undefined ? {} : {profile: chosen.profile}),
        steps,
      }),
      reason: tierReason(tier, chosen),
    }];
  });
};

export const buildWanGPCapabilityCatalog = (input: {
  models: WanGPModelCapability[];
  profiles: WanGPAcceleratorProfile[];
  discoveredAt?: string;
}): WanGPCapabilityCatalog => ({
  discoveredAt: input.discoveredAt ?? new Date().toISOString(),
  source: 'wangp-mcp',
  models: input.models,
  acceleratorProfiles: input.profiles,
  tiers: resolveWanGPLocalTiers(input.models, input.profiles),
});

export const applyWanGPCachePolicy = (
  settings: Record<string, unknown>,
  policy: WanGPCachePolicy,
): Record<string, unknown> => ({
  ...settings,
  skip_steps_cache_type: policy.kind === 'off' ? '' : policy.kind,
  ...(policy.multiplier === undefined ? {} : {skip_steps_multiplier: policy.multiplier}),
});

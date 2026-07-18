import type {WanGPCapabilityCatalog, WanGPModelCapability} from './wangp-capabilities.js';

export type WanGPBenchmarkCapabilityId =
  | 'fun-inp-1.3b'
  | 'fastwan-5b'
  | 'enhanced-lightning-14b'
  | 'lightx2v-4step';

export type WanGPBenchmarkTargetSelection = {
  targetId: WanGPBenchmarkCapabilityId;
  label: string;
  discovered: boolean;
  installed: boolean;
  modelRuntimeId?: string;
  modelLabel?: string;
  acceleratorProfileId?: string;
  acceleratorProfileLabel?: string;
};

const TARGETS: Array<{
  targetId: WanGPBenchmarkCapabilityId;
  label: string;
  modelTags: string[];
  profileTags: string[];
  combinedTags?: string[];
}> = [
  {targetId: 'fun-inp-1.3b', label: 'Fun InP 1.3B', modelTags: ['fun-inp', 'one-point-three-billion'], profileTags: ['self-forcing']},
  {targetId: 'fastwan-5b', label: 'FastWan 2.2 5B', modelTags: ['five-billion'], profileTags: ['fastwan'], combinedTags: ['fastwan']},
  {targetId: 'enhanced-lightning-14b', label: 'Enhanced Lightning v2 14B', modelTags: ['enhanced-lightning', 'fourteen-billion'], profileTags: ['lightning'], combinedTags: ['enhanced-lightning']},
  {targetId: 'lightx2v-4step', label: 'LightX2V 4-step', modelTags: ['image-to-video', 'fourteen-billion'], profileTags: ['lightx2v', 'four-step'], combinedTags: ['lightx2v', 'four-step']},
];

const hasTags = (model: WanGPModelCapability, tags: readonly string[]): boolean =>
  tags.every((tag) => model.tags.includes(tag));

const benchmarkModelSpecializationCount = (
  model: WanGPModelCapability,
  requiredTags: readonly string[],
): number => {
  const genericTags = new Set([...requiredTags, 'image-to-video', 'int8', 'bf16', 'gguf']);
  return model.tags.filter((tag) => !genericTags.has(tag)).length;
};

type BenchmarkOption = {
  model: WanGPModelCapability;
  profile?: WanGPCapabilityCatalog['acceleratorProfiles'][number];
};

export const resolveWanGPBenchmarkTargets = (
  catalog: WanGPCapabilityCatalog,
): WanGPBenchmarkTargetSelection[] => TARGETS.map((target) => {
  const options = catalog.models
    .filter((model) => model.imageToVideo && !model.tags.includes('nvfp4') && hasTags(model, target.modelTags))
    .flatMap((model) => {
      const modelCarriesTarget = (target.combinedTags ?? []).length > 0
        && (target.combinedTags ?? []).every((tag) => model.tags.includes(tag));
      const compatibleProfiles = catalog.acceleratorProfiles.filter((profile) => (
        model.profileDirectories.includes(profile.directory)
        && target.profileTags.every((tag) => profile.tags.includes(tag))
      ));
      const candidates: BenchmarkOption[] = [
        ...(modelCarriesTarget || compatibleProfiles.length === 0 ? [{model}] : []),
        ...compatibleProfiles.map((profile) => ({model, profile})),
      ];
      return candidates.filter(({model: candidateModel, profile}) => {
        const combined = new Set([...candidateModel.tags, ...(profile?.tags ?? [])]);
        return (target.combinedTags ?? []).every((tag) => combined.has(tag));
      });
    })
    .sort((left, right) => {
      const installed = Number(right.model.availability === 'available') - Number(left.model.availability === 'available');
      if (installed !== 0) return installed;
      const rightModelCarriesTarget = (target.combinedTags ?? []).every((tag) => right.model.tags.includes(tag));
      const leftModelCarriesTarget = (target.combinedTags ?? []).every((tag) => left.model.tags.includes(tag));
      const modelCarriesTarget = Number(rightModelCarriesTarget) - Number(leftModelCarriesTarget);
      if (modelCarriesTarget !== 0) return modelCarriesTarget;
      const redundantProfile = Number(left.profile !== undefined) - Number(right.profile !== undefined);
      if (leftModelCarriesTarget && redundantProfile !== 0) return redundantProfile;
      const specialization = benchmarkModelSpecializationCount(left.model, target.modelTags)
        - benchmarkModelSpecializationCount(right.model, target.modelTags);
      if (specialization !== 0) return specialization;
      const quantized = Number(right.model.quantization.some((value) => value === 'int8' || value === 'gguf'))
        - Number(left.model.quantization.some((value) => value === 'int8' || value === 'gguf'));
      return quantized !== 0 ? quantized : left.model.label.localeCompare(right.model.label);
    });
  const selected = options[0];
  if (!selected) return {targetId: target.targetId, label: target.label, discovered: false, installed: false};
  const {model, profile} = selected;
  return {
    targetId: target.targetId,
    label: target.label,
    discovered: true,
    installed: model.availability === 'available',
    modelRuntimeId: model.runtimeModelId,
    modelLabel: model.label,
    ...(profile === undefined ? {} : {
      acceleratorProfileId: profile.id,
      acceleratorProfileLabel: profile.label,
    }),
  };
});

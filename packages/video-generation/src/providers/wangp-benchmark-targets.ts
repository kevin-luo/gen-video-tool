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
}> = [
  {targetId: 'fun-inp-1.3b', label: 'Fun InP 1.3B', modelTags: ['fun-inp', 'one-point-three-billion'], profileTags: ['self-forcing']},
  {targetId: 'fastwan-5b', label: 'FastWan 2.2 5B', modelTags: ['fastwan', 'five-billion'], profileTags: ['fastwan']},
  {targetId: 'enhanced-lightning-14b', label: 'Enhanced Lightning v2 14B', modelTags: ['enhanced-lightning', 'fourteen-billion'], profileTags: ['lightning']},
  {targetId: 'lightx2v-4step', label: 'LightX2V 4-step', modelTags: ['lightx2v', 'four-step'], profileTags: ['lightx2v']},
];

const hasTags = (model: WanGPModelCapability, tags: readonly string[]): boolean =>
  tags.every((tag) => model.tags.includes(tag));

export const resolveWanGPBenchmarkTargets = (
  catalog: WanGPCapabilityCatalog,
): WanGPBenchmarkTargetSelection[] => TARGETS.map((target) => {
  const model = catalog.models
    .filter((candidate) => candidate.imageToVideo && !candidate.tags.includes('nvfp4') && hasTags(candidate, target.modelTags))
    .sort((left, right) => {
      const installed = Number(right.availability === 'available') - Number(left.availability === 'available');
      if (installed !== 0) return installed;
      const avoidsNvfp4 = Number(!right.tags.includes('nvfp4')) - Number(!left.tags.includes('nvfp4'));
      return avoidsNvfp4 !== 0 ? avoidsNvfp4 : left.label.localeCompare(right.label);
    })[0];
  if (!model) return {targetId: target.targetId, label: target.label, discovered: false, installed: false};
  const profile = catalog.acceleratorProfiles.find((candidate) => (
    model.profileDirectories.includes(candidate.directory)
    && target.profileTags.some((tag) => candidate.tags.includes(tag))
  ));
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

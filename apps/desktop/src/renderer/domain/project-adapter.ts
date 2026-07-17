import type {ProductionShot} from '@gen-video-tool/video-generation';
import type {ProjectPayload} from '../../shared/desktop-api';
import type {ProjectModel, ShotModel} from './editor';

const shotCamera = (shot: ProductionShot) => shot.kind === 'generated-performance'
  ? shot.hybridMotion.editorialCamera
  : shot.editorialCamera;

const previewAssetPath = (shot: ProductionShot): string => {
  if (shot.kind === 'generated-performance') return shot.generation.conditioning.startKeyframePath;
  const background = [...shot.layers]
    .sort((left, right) => left.zIndex - right.zIndex)
    .find((layer) => layer.role === 'background');
  return background?.assetPath ?? [...shot.layers].sort((left, right) => left.zIndex - right.zIndex)[0]!.assetPath;
};

export const buildProjectModel = (payload: ProjectPayload): ProjectModel => {
  const stateByShot = new Map(payload.state.shots.map((shot) => [shot.shotId, shot]));
  const narrationByShot = new Map(payload.plan.narration.segments.map((segment) => [segment.shotId, segment.text]));
  const shots: ShotModel[] = payload.plan.shots.map((shot, index) => {
    const state = stateByShot.get(shot.shotId);
    if (!state) throw new Error(`PRODUCTION_STATE_SHOT_MISSING:${shot.shotId}`);
    const narration = narrationByShot.get(shot.shotId) ?? '';
    return {
      id: shot.shotId,
      index: index + 1,
      title: narration || shot.shotId,
      narration,
      kind: shot.kind,
      startFrame: shot.deliveryTimeline.startFrame,
      durationFrames: shot.deliveryTimeline.durationFrames,
      durationSeconds: shot.deliveryTimeline.durationFrames / payload.plan.delivery.timeline.fps,
      camera: shotCamera(shot),
      previewAssetPath: previewAssetPath(shot),
      plan: shot,
      state,
    };
  });
  return {
    id: payload.plan.projectId,
    name: payload.plan.metadata.title,
    aspectRatio: '9:16',
    plan: payload.plan,
    state: payload.state,
    ...(payload.renderData === undefined ? {} : {renderData: payload.renderData}),
    ...(payload.renderGate === undefined ? {} : {renderGate: payload.renderGate}),
    shots,
    assetBase: payload.assetBase,
    readOnly: payload.readOnly,
  };
};

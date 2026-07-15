import type {Actor, ProjectDocument, ShotDocument, TransitionType} from '@gen-video-tool/schema';
import type {ProjectPayload} from '../../shared/desktop-api';
import type {ActorConfig, CameraMove, ProjectModel, ShotModel, Transition} from './editor';

const cameraToUi = (kind: NonNullable<ShotDocument['camera']>['kind']): CameraMove => {
  if (kind === 'push') return 'push-in';
  if (kind.startsWith('pan-')) return 'follow';
  return 'static';
};

const transitionToUi = (type: TransitionType): Transition => ({
  'hard-cut': 'hard-cut',
  'flash-frame': 'flash-frame',
  'foreground-wipe': 'foreground-wipe',
  'tear-cover': 'torn-paper',
  'paper-cover': 'torn-paper',
  'prop-cover': 'foreground-wipe',
  'cut-shot': 'hard-cut',
} satisfies Record<TransitionType, Transition>)[type];

const actorConfig = (actor: Actor | undefined): ActorConfig => {
  if (!actor) return {mode: 'rigid', availableModes: [], action: '无人物', poseA: '—', poseB: '—', switchCover: 'hard-cut'};
  if (actor.mode === 'pose-cut') {
    const first = actor.poses[0];
    const second = actor.poses[1];
    return {
      mode: actor.mode,
      availableModes: [actor.mode],
      action: '完整姿态硬切',
      poseA: first?.sourcePath ?? '—',
      poseB: second?.sourcePath ?? '—',
      switchCover: actor.transition.type === 'flash-frame' ? 'flash-frame'
        : actor.transition.type === 'hard-cut' || actor.transition.type === 'cut-shot' ? 'hard-cut'
          : actor.transition.type === 'tear-cover' ? 'paper-tear' : 'foreground',
    };
  }
  return {
    mode: actor.mode,
    availableModes: [actor.mode],
    action: actor.mode === 'mesh' ? actor.actionTemplate ?? 'idle-breathe' : actor.motion[0] ?? 'shadow-settle',
    poseA: actor.sourcePath,
    poseB: '—',
    switchCover: 'hard-cut',
  };
};

export const buildProjectModel = (payload: ProjectPayload): ProjectModel => ({
  id: payload.project.manifest.projectId,
  name: payload.project.manifest.title,
  aspectRatio: payload.project.manifest.canvas.aspectRatio,
  document: payload.project,
  assetBase: payload.assetBase,
  readOnly: payload.readOnly,
  shots: payload.project.shots.map((shot, index) => ({
    id: shot.id,
    index: index + 1,
    title: shot.title?.text ?? shot.name ?? shot.id,
    note: shot.name ?? '纸片镜头',
    year: '',
    duration: shot.durationFrames / payload.project.manifest.fps,
    recipe: shot.recipeId,
    energy: shot.energy,
    camera: cameraToUi(shot.camera?.kind ?? 'locked'),
    transition: transitionToUi(shot.transition.type),
    selectedLayerId: shot.layers.find((layer) => layer.role !== 'background')?.id ?? shot.layers[0]?.id ?? '',
    layers: shot.layers.map((layer) => ({
      id: layer.id,
      name: layer.text ?? layer.assetPath?.split('/').at(-1) ?? layer.id,
      role: layer.role,
      x: layer.transform?.x ?? 0,
      y: layer.transform?.y ?? 0,
      scale: (layer.transform?.scaleX ?? 1) * 100,
      rotation: layer.transform?.rotation ?? 0,
      depth: Math.round(layer.depth * 100),
      visible: layer.visible,
    })),
    actor: actorConfig(shot.actors[0]),
    palette: (['sand', 'ink', 'rust', 'olive'] as const)[index % 4] ?? 'sand',
  })),
});

const cameraFromUi = (camera: CameraMove, current: ShotDocument['camera']): NonNullable<ShotDocument['camera']> => {
  if (camera === 'push-in') return {kind: 'push', strength: current?.strength ?? 0.35};
  if (camera === 'follow') return {kind: current?.kind.startsWith('pan-') ? current.kind : 'pan-right', strength: current?.strength ?? 0.35};
  return {kind: 'locked', strength: current?.strength ?? 0.35};
};

const transitionFromUi = (transition: Transition, current: ShotDocument['transition']): ShotDocument['transition'] => {
  if (transition === 'hard-cut') return {type: 'hard-cut', durationFrames: 0};
  if (transition === 'flash-frame') return {type: 'flash-frame', durationFrames: Math.max(1, current.durationFrames || 6)};
  if (transition === 'torn-paper') return {type: 'tear-cover', durationFrames: Math.max(1, current.durationFrames || 10)};
  if (transition === 'foreground-wipe') {
    return current.coverLayerId
      ? {type: 'foreground-wipe', durationFrames: Math.max(1, current.durationFrames || 10), coverLayerId: current.coverLayerId}
      : {type: 'hard-cut', durationFrames: 0};
  }
  return {type: 'cut-shot', durationFrames: Math.max(1, current.durationFrames || 4)};
};

export const materializeProjectDocument = (model: ProjectModel): ProjectDocument => {
  const fps = model.document.manifest.fps;
  const sourceShots = new Map(model.document.shots.map((shot) => [shot.id, shot]));
  const shots = model.shots.map((uiShot) => {
    const source = sourceShots.get(uiShot.id);
    if (!source) throw new Error(`EDITOR_SHOT_MISSING:${uiShot.id}`);
    const uiLayers = new Map(uiShot.layers.map((layer) => [layer.id, layer]));
    return {
      ...source,
      name: uiShot.note,
      durationFrames: Math.max(1, Math.round(uiShot.duration * fps)),
      recipeId: uiShot.recipe,
      energy: uiShot.energy,
      camera: cameraFromUi(uiShot.camera, source.camera),
      transition: transitionFromUi(uiShot.transition, source.transition),
      layers: source.layers.map((layer) => {
        const ui = uiLayers.get(layer.id);
        if (!ui) return layer;
        return {
          ...layer,
          visible: ui.visible,
          depth: Math.min(1, Math.max(0, ui.depth / 100)),
          transform: {
            x: ui.x, y: ui.y, scaleX: Math.max(0.01, ui.scale / 100), scaleY: Math.max(0.01, ui.scale / 100),
            rotation: ui.rotation, opacity: layer.transform?.opacity ?? 1,
            anchorX: layer.transform?.anchorX ?? 0.5, anchorY: layer.transform?.anchorY ?? 0.5,
          },
        };
      }),
      ...(source.title ? {title: {...source.title, text: uiShot.title}} : {}),
    } satisfies ShotDocument;
  });
  const pathById = new Map(model.document.manifest.shots.map((reference) => [reference.id, reference.path]));
  return {
    schemaVersion: 2,
    manifest: {
      ...model.document.manifest,
      title: model.name,
      shots: model.shots.map((shot) => ({id: shot.id, path: pathById.get(shot.id) ?? `shots/${shot.id}/shot.json`})),
    },
    shots,
  };
};

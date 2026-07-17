import {z} from 'zod';
import {
  assertHybridMotionPlan,
  type HybridMotionPlan,
} from '../orchestration/hybrid-motion-plan.js';

export const PRODUCTION_PLAN_SCHEMA_VERSION = 3 as const;
export const DELIVERY_WIDTH = 1_080 as const;
export const DELIVERY_HEIGHT = 1_920 as const;
export const DELIVERY_FPS = 30 as const;

const nonEmptyTextSchema = z.string().min(1).max(4_000).refine(
  (value) => value.trim() === value && value.length > 0,
  'Text must not have leading or trailing whitespace.',
);

export const productionIdSchema = z.string().min(1).max(128).superRefine((value, context) => {
  if (value.trim() !== value || value === '.' || value === '..') {
    context.addIssue({code: 'custom', message: 'ID must be trimmed and cannot be a dot segment.'});
  }
  if (/[\\/\u0000-\u001f\u007f]/u.test(value)) {
    context.addIssue({code: 'custom', message: 'ID cannot contain path separators or control characters.'});
  }
});

/** A portable project path: POSIX separators, no drive/root prefix, and no traversal. */
export const safePosixRelativePathSchema = z.string().min(1).max(1_024).superRefine((value, context) => {
  if (value.trim() !== value) {
    context.addIssue({code: 'custom', message: 'Path must not have leading or trailing whitespace.'});
  }
  if (value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:/u.test(value)) {
    context.addIssue({code: 'custom', message: 'Path must be relative to the project root.'});
  }
  if (value.includes(':')) {
    context.addIssue({code: 'custom', message: 'Path cannot contain a drive prefix or alternate-data-stream separator.'});
  }
  if (value.includes('\\')) {
    context.addIssue({code: 'custom', message: 'Path must use POSIX forward slashes.'});
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    context.addIssue({code: 'custom', message: 'Path cannot contain control characters.'});
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    context.addIssue({code: 'custom', message: 'Path cannot contain empty, current, or parent segments.'});
  }
  if (segments.some((segment) => /[. ]$/u.test(segment))) {
    context.addIssue({code: 'custom', message: 'Portable path segments cannot end with a dot or space.'});
  }
  if (segments.some((segment) => /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment))) {
    context.addIssue({code: 'custom', message: 'Path cannot contain a reserved Windows device segment.'});
  }
});

export const productionCapabilitySchema = z.enum([
  'local-f5-tts',
  'local-i2v',
  'local-i2v-start-end',
  'local-video-matting',
  'deterministic-ballistics',
  'remotion-render',
  'ffmpeg',
  'sidecar-srt',
]);
export type ProductionCapability = z.infer<typeof productionCapabilitySchema>;

const uniqueCapabilitiesSchema = z.array(productionCapabilitySchema).min(1).superRefine((values, context) => {
  const seen = new Set<ProductionCapability>();
  values.forEach((value, index) => {
    if (seen.has(value)) {
      context.addIssue({code: 'custom', path: [index], message: `Duplicate capability: ${value}`});
    }
    seen.add(value);
  });
});

const pointSchema = z.object({
  x: z.number().finite().min(0).max(1),
  y: z.number().finite().min(0).max(1),
}).strict();

const deliveryTimelineSchema = z.object({
  startFrame: z.number().int().nonnegative().max(36_000),
  durationFrames: z.number().int().positive().max(36_000),
}).strict();

export const deliveryContractSchema = z.object({
  raster: z.object({
    width: z.literal(DELIVERY_WIDTH),
    height: z.literal(DELIVERY_HEIGHT),
    pixelAspectRatio: z.literal(1),
  }).strict(),
  timeline: z.object({
    fps: z.literal(DELIVERY_FPS),
    durationFrames: z.number().int().positive().max(36_000),
  }).strict(),
  video: z.object({
    path: safePosixRelativePathSchema,
    codec: z.literal('h264'),
    pixelFormat: z.literal('yuv420p'),
  }).strict(),
  audio: z.object({
    path: safePosixRelativePathSchema,
    /** F5-TTS writes a local PCM WAV; export muxes it without pretending the source is AAC. */
    sourceFormat: z.literal('wav'),
    muxCodec: z.literal('aac'),
    muxSampleRate: z.literal(48_000),
  }).strict(),
  subtitles: z.object({
    path: safePosixRelativePathSchema,
    format: z.literal('srt'),
    burnIn: z.literal(false),
  }).strict(),
  bgm: z.null(),
}).strict();
export type DeliveryContract = z.infer<typeof deliveryContractSchema>;

export const editorialCameraSchema = z.object({
  owner: z.literal('editorial-camera'),
  operation: z.enum(['locked', 'push', 'pull', 'pan-left', 'pan-right', 'pan-up', 'pan-down']),
  strength: z.number().finite().min(0).max(1),
}).strict().superRefine((camera, context) => {
  if (camera.operation === 'locked' && camera.strength !== 0) {
    context.addIssue({code: 'custom', path: ['strength'], message: 'A locked camera must have zero strength.'});
  }
  if (camera.operation !== 'locked' && camera.strength === 0) {
    context.addIssue({code: 'custom', path: ['strength'], message: 'An editorial move must have positive strength.'});
  }
});
export type EditorialCamera = z.infer<typeof editorialCameraSchema>;

const layerTransformSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  scaleX: z.number().finite().positive().max(20),
  scaleY: z.number().finite().positive().max(20),
  rotationDegrees: z.number().finite().min(-3_600).max(3_600),
  opacity: z.number().finite().min(0).max(1),
}).strict();

const collageLayerSchema = z.object({
  id: productionIdSchema,
  assetPath: safePosixRelativePathSchema,
  role: z.enum(['background', 'midground', 'actor', 'prop', 'foreground', 'overlay']),
  zIndex: z.number().int().min(-10_000).max(10_000),
  transform: layerTransformSchema,
  motionPreset: z.enum(['locked', 'idle-breathe', 'paper-sway', 'drift', 'pop-in']).optional(),
}).strict();

const commonShotFields = {
  shotId: productionIdSchema,
  deliveryTimeline: deliveryTimelineSchema,
};

export const layeredCollageShotSchema = z.object({
  ...commonShotFields,
  kind: z.literal('layered-collage'),
  layers: z.array(collageLayerSchema).min(1),
  editorialCamera: editorialCameraSchema,
}).strict().superRefine((shot, context) => {
  const layerIds = new Set<string>();
  shot.layers.forEach((layer, index) => {
    if (layerIds.has(layer.id)) {
      context.addIssue({code: 'custom', path: ['layers', index, 'id'], message: `Duplicate layer ID: ${layer.id}`});
    }
    layerIds.add(layer.id);
  });
});
export type LayeredCollageShot = z.infer<typeof layeredCollageShotSchema>;

const milestoneKindSchema = z.enum([
  'setup',
  'anticipation',
  'approach',
  'plant',
  'contact',
  'release',
  'follow-through',
  'settle',
  'end',
]);

const milestoneSchema = z.object({
  id: productionIdSchema,
  kind: milestoneKindSchema,
  /** Shot-local frame in the exact 30 fps delivery timeline. */
  frame: z.number().int().nonnegative(),
}).strict();

const bodyPartSchema = z.enum([
  'head',
  'torso',
  'hips',
  'left-hand',
  'right-hand',
  'left-foot',
  'right-foot',
  'left-knee',
  'right-knee',
  'left-elbow',
  'right-elbow',
]);

const facingConstraintSchema = z.object({
  id: productionIdSchema,
  actorId: productionIdSchema,
  towardTargetId: productionIdSchema,
  bodyAxis: z.enum(['head', 'torso', 'hips', 'travel']),
  fromMilestoneId: productionIdSchema,
  throughMilestoneId: productionIdSchema,
  maxDeviationDegrees: z.number().finite().positive().max(90),
}).strict();

const supportConstraintSchema = z.object({
  id: productionIdSchema,
  actorId: productionIdSchema,
  bodyPart: bodyPartSchema,
  surfaceId: productionIdSchema,
  mode: z.enum(['planted', 'supported', 'sliding-allowed']),
  fromMilestoneId: productionIdSchema,
  throughMilestoneId: productionIdSchema,
  maxSlipPixels: z.number().finite().nonnegative().max(DELIVERY_WIDTH),
}).strict();

const contactTargetSchema = z.discriminatedUnion('owner', [
  z.object({
    owner: z.literal('deterministic-interaction'),
    propId: productionIdSchema,
  }).strict(),
  z.object({
    owner: z.literal('generated-world'),
    objectId: productionIdSchema,
  }).strict(),
]);

const contactConstraintSchema = z.object({
  id: productionIdSchema,
  actorId: productionIdSchema,
  bodyPart: bodyPartSchema,
  target: contactTargetSchema,
  milestoneId: productionIdSchema,
  kind: z.enum(['strike', 'touch', 'grasp', 'release']),
  toleranceFrames: z.number().int().nonnegative().max(3),
}).strict();

export const worldConstraintsSchema = z.object({
  facing: z.array(facingConstraintSchema).min(1),
  support: z.array(supportConstraintSchema).min(1),
  contact: z.array(contactConstraintSchema),
}).strict();
export type WorldConstraints = z.infer<typeof worldConstraintsSchema>;

const ballisticPropSchema = z.object({
  propId: productionIdSchema,
  assetPath: safePosixRelativePathSchema,
  /** Intrinsic delivery-pixel size before transform scale is applied. */
  renderSize: z.object({
    width: z.number().finite().positive().max(DELIVERY_WIDTH),
    height: z.number().finite().positive().max(DELIVERY_HEIGHT),
  }).strict(),
  trigger: z.object({
    milestoneId: productionIdSchema,
    kind: z.enum(['contact', 'release']),
  }).strict(),
  /** Position is the prop centre in 1080x1920 delivery pixels. */
  transform: z.object({
    x: z.number().finite().min(0).max(DELIVERY_WIDTH),
    y: z.number().finite().min(0).max(DELIVERY_HEIGHT),
    scaleX: z.number().finite().positive().max(20),
    scaleY: z.number().finite().positive().max(20),
    rotationDegrees: z.number().finite().min(-3_600).max(3_600),
  }).strict(),
  motion: z.object({
    kind: z.literal('ballistic'),
    /** Shot-local delivery frame. */
    contactFrame: z.number().int().nonnegative(),
    flightFrames: z.number().int().positive().max(2_400),
    targetX: z.number().finite().min(0).max(DELIVERY_WIDTH),
    targetY: z.number().finite().min(0).max(DELIVERY_HEIGHT),
    targetScale: z.number().finite().positive().max(20),
    curveX: z.number().finite().min(-4_000).max(4_000),
    spinDegrees: z.number().finite().min(-14_400).max(14_400),
  }).strict(),
}).strict();

const noOcclusionSchema = z.object({
  mode: z.literal('none'),
  requirement: z.literal('none'),
}).strict();

const matteOcclusionSchema = z.object({
  mode: z.literal('local-matte'),
  requirement: z.enum(['optional', 'required']),
  subjectId: productionIdSchema,
  engine: z.literal('local-video-matting'),
  outputDirectory: safePosixRelativePathSchema,
  outputFormat: z.literal('webm-alpha'),
  foregroundAssetPath: safePosixRelativePathSchema.optional(),
  featherPixels: z.number().int().nonnegative().max(64),
}).strict();

export const occlusionContractSchema = z.discriminatedUnion('mode', [
  noOcclusionSchema,
  matteOcclusionSchema,
]);
export type OcclusionContract = z.infer<typeof occlusionContractSchema>;

export const generatedPerformanceShotSchema = z.object({
  ...commonShotFields,
  kind: z.literal('generated-performance'),
  generation: z.object({
    engine: z.literal('wangp-local-i2v'),
    conditioning: z.discriminatedUnion('mode', [
      z.object({
        mode: z.literal('start-only'),
        startKeyframePath: safePosixRelativePathSchema,
      }).strict(),
      z.object({
        mode: z.literal('start-end'),
        startKeyframePath: safePosixRelativePathSchema,
        endKeyframePath: safePosixRelativePathSchema,
      }).strict(),
    ]),
    preset: z.object({
      id: productionIdSchema,
      quality: z.enum(['preview', 'quality']),
      /** Capability advertised by the selected local WanGP preset/model. */
      conditioning: z.enum(['start-only', 'start-end']),
      motionStrength: z.number().finite().min(0).max(1),
    }).strict(),
    /** Native local-model raster. It is intentionally independent from delivery raster. */
    raster: z.object({
      width: z.number().int().positive().max(8_192),
      height: z.number().int().positive().max(8_192),
    }).strict(),
    /** Native local-model timebase. It is conformed by duration, never by frame identity. */
    timeline: z.object({
      fps: z.number().int().positive().max(120),
      frameCount: z.number().int().positive().max(36_000),
    }).strict(),
    conformToDelivery: z.object({
      spatialFit: z.literal('cover'),
      focalPoint: pointSchema,
      temporalFit: z.literal('preserve-duration'),
    }).strict(),
    candidateSeeds: z.tuple([
      z.number().int().nonnegative().max(2_147_483_647),
      z.number().int().nonnegative().max(2_147_483_647),
    ]),
  }).strict(),
  hybridMotion: z.object({
    actor: z.object({
      id: productionIdSchema,
      supportingActorIds: z.array(productionIdSchema),
      action: nonEmptyTextSchema.max(500),
      prompt: nonEmptyTextSchema,
      negativePrompt: nonEmptyTextSchema,
      generatedCamera: z.literal('locked'),
      excludedCausalPropIds: z.array(productionIdSchema),
    }).strict(),
    world: z.object({
      subjectId: productionIdSchema,
      targetId: productionIdSchema.optional(),
      /** Generated-world objects that may participate in structured contact. */
      generatedObjectIds: z.array(productionIdSchema),
      supportSurfaceId: productionIdSchema,
      actionAxis: z.object({from: pointSchema, to: pointSchema}).strict(),
      milestones: z.array(milestoneSchema).min(1),
      constraints: worldConstraintsSchema,
    }).strict(),
    deterministicProps: z.array(ballisticPropSchema),
    editorialCamera: editorialCameraSchema,
  }).strict(),
  occlusion: occlusionContractSchema,
}).strict().superRefine((shot, context) => {
  const {generation} = shot;
  if (generation.candidateSeeds[0] === generation.candidateSeeds[1]) {
    context.addIssue({
      code: 'custom',
      path: ['generation', 'candidateSeeds', 1],
      message: 'Exactly two distinct candidate seeds are required.',
    });
  }
  if (
    generation.conditioning.mode === 'start-end'
    && generation.conditioning.startKeyframePath === generation.conditioning.endKeyframePath
  ) {
    context.addIssue({
      code: 'custom',
      path: ['generation', 'conditioning', 'endKeyframePath'],
      message: 'Complete start and end conditioning frames must be distinct assets.',
    });
  }
  if (generation.conditioning.mode === 'start-end' && generation.preset.conditioning !== 'start-end') {
    context.addIssue({
      code: 'custom',
      path: ['generation', 'preset', 'conditioning'],
      message: 'The selected local WanGP preset does not advertise end-frame conditioning.',
    });
  }

  const deliveryDuration = shot.deliveryTimeline.durationFrames / DELIVERY_FPS;
  const generationDuration = generation.timeline.frameCount / generation.timeline.fps;
  const durationTolerance = Math.max(1 / DELIVERY_FPS, 1 / generation.timeline.fps);
  if (Math.abs(deliveryDuration - generationDuration) > durationTolerance) {
    context.addIssue({
      code: 'custom',
      path: ['generation', 'timeline'],
      message: 'WanGP and delivery timelines must represent the same duration within one source frame.',
    });
  }

  if (shot.hybridMotion.actor.id !== shot.hybridMotion.world.subjectId) {
    context.addIssue({
      code: 'custom',
      path: ['hybridMotion', 'world', 'subjectId'],
      message: 'World subject must be the primary generated actor.',
    });
  }
  const actorIds = [shot.hybridMotion.actor.id, ...shot.hybridMotion.actor.supportingActorIds];
  const actorIdSet = new Set(actorIds);
  if (actorIdSet.size !== actorIds.length) {
    context.addIssue({
      code: 'custom',
      path: ['hybridMotion', 'actor', 'supportingActorIds'],
      message: 'Primary and supporting actor IDs must be unique.',
    });
  }
  const {from, to} = shot.hybridMotion.world.actionAxis;
  if (Math.hypot(to.x - from.x, to.y - from.y) < 0.01) {
    context.addIssue({
      code: 'custom',
      path: ['hybridMotion', 'world', 'actionAxis'],
      message: 'Action axis must be a non-zero direction from actor toward target.',
    });
  }

  const milestoneById = new Map<string, z.infer<typeof milestoneSchema>>();
  let previousFrame = -1;
  shot.hybridMotion.world.milestones.forEach((milestone, index) => {
    const basePath = ['hybridMotion', 'world', 'milestones', index] as const;
    if (milestoneById.has(milestone.id)) {
      context.addIssue({code: 'custom', path: [...basePath, 'id'], message: `Duplicate milestone ID: ${milestone.id}`});
    }
    if (milestone.frame <= previousFrame) {
      context.addIssue({code: 'custom', path: [...basePath, 'frame'], message: 'Milestones must use strictly increasing frames.'});
    }
    if (milestone.frame >= shot.deliveryTimeline.durationFrames) {
      context.addIssue({code: 'custom', path: [...basePath, 'frame'], message: 'Milestone must remain inside the delivery shot.'});
    }
    milestoneById.set(milestone.id, milestone);
    previousFrame = milestone.frame;
  });

  const propIds = new Set<string>();
  const propTriggerMilestoneById = new Map<string, string>();
  shot.hybridMotion.deterministicProps.forEach((prop, index) => {
    const basePath = ['hybridMotion', 'deterministicProps', index] as const;
    if (propIds.has(prop.propId)) {
      context.addIssue({code: 'custom', path: [...basePath, 'propId'], message: `Duplicate prop ID: ${prop.propId}`});
    }
    propIds.add(prop.propId);
    propTriggerMilestoneById.set(prop.propId, prop.trigger.milestoneId);
    const trigger = milestoneById.get(prop.trigger.milestoneId);
    if (trigger === undefined) {
      context.addIssue({code: 'custom', path: [...basePath, 'trigger', 'milestoneId'], message: 'Trigger milestone does not exist.'});
    } else {
      if (trigger.kind !== prop.trigger.kind) {
        context.addIssue({code: 'custom', path: [...basePath, 'trigger', 'kind'], message: 'Trigger kind must match its milestone.'});
      }
      if (trigger.frame !== prop.motion.contactFrame) {
        context.addIssue({code: 'custom', path: [...basePath, 'motion', 'contactFrame'], message: 'Ballistic contactFrame must match the trigger milestone frame.'});
      }
    }
    if (prop.motion.contactFrame + prop.motion.flightFrames > shot.deliveryTimeline.durationFrames - 1) {
      context.addIssue({code: 'custom', path: [...basePath, 'motion', 'flightFrames'], message: 'Ballistic flight must finish inside the delivery shot.'});
    }
  });

  const generatedObjectIds = new Set<string>();
  shot.hybridMotion.world.generatedObjectIds.forEach((objectId, index) => {
    if (generatedObjectIds.has(objectId)) {
      context.addIssue({
        code: 'custom',
        path: ['hybridMotion', 'world', 'generatedObjectIds', index],
        message: `Duplicate generated-world object ID: ${objectId}`,
      });
    }
    generatedObjectIds.add(objectId);
  });

  const excluded = shot.hybridMotion.actor.excludedCausalPropIds;
  const excludedSet = new Set(excluded);
  excluded.forEach((propId, index) => {
    if (excluded.indexOf(propId) !== index) {
      context.addIssue({code: 'custom', path: ['hybridMotion', 'actor', 'excludedCausalPropIds', index], message: `Duplicate excluded prop ID: ${propId}`});
    }
    if (!propIds.has(propId)) {
      context.addIssue({code: 'custom', path: ['hybridMotion', 'actor', 'excludedCausalPropIds', index], message: `Excluded causal prop has no deterministic owner: ${propId}`});
    }
  });
  propIds.forEach((propId) => {
    if (!excludedSet.has(propId)) {
      context.addIssue({
        code: 'custom',
        path: ['hybridMotion', 'actor', 'excludedCausalPropIds'],
        message: `Deterministic prop must be excluded from generated frames: ${propId}`,
      });
    }
  });

  const constraintIds = new Set<string>();
  const rememberConstraint = (id: string, path: Array<string | number>): void => {
    if (constraintIds.has(id)) {
      context.addIssue({code: 'custom', path, message: `Duplicate world constraint ID: ${id}`});
    }
    constraintIds.add(id);
  };
  const milestoneFrame = (id: string): number | undefined => milestoneById.get(id)?.frame;
  const validateInterval = (
    fromId: string,
    throughId: string,
    path: Array<string | number>,
  ): void => {
    const start = milestoneFrame(fromId);
    const end = milestoneFrame(throughId);
    if (start === undefined) context.addIssue({code: 'custom', path: [...path, 'fromMilestoneId'], message: 'Constraint start milestone does not exist.'});
    if (end === undefined) context.addIssue({code: 'custom', path: [...path, 'throughMilestoneId'], message: 'Constraint end milestone does not exist.'});
    if (start !== undefined && end !== undefined && end < start) {
      context.addIssue({code: 'custom', path, message: 'Constraint interval must run forward in delivery time.'});
    }
  };
  shot.hybridMotion.world.constraints.facing.forEach((constraint, index) => {
    const basePath = ['hybridMotion', 'world', 'constraints', 'facing', index];
    rememberConstraint(constraint.id, [...basePath, 'id']);
    if (!actorIdSet.has(constraint.actorId)) {
      context.addIssue({code: 'custom', path: [...basePath, 'actorId'], message: 'Facing constraint actor must be present in the generated performance.'});
    }
    if (shot.hybridMotion.world.targetId !== constraint.towardTargetId) {
      context.addIssue({code: 'custom', path: [...basePath, 'towardTargetId'], message: 'Facing constraint must point at the declared world target.'});
    }
    validateInterval(constraint.fromMilestoneId, constraint.throughMilestoneId, basePath);
  });
  shot.hybridMotion.world.constraints.support.forEach((constraint, index) => {
    const basePath = ['hybridMotion', 'world', 'constraints', 'support', index];
    rememberConstraint(constraint.id, [...basePath, 'id']);
    if (!actorIdSet.has(constraint.actorId)) {
      context.addIssue({code: 'custom', path: [...basePath, 'actorId'], message: 'Support constraint actor must be present in the generated performance.'});
    }
    if (constraint.surfaceId !== shot.hybridMotion.world.supportSurfaceId) {
      context.addIssue({code: 'custom', path: [...basePath, 'surfaceId'], message: 'Support constraint must reference the declared support surface.'});
    }
    validateInterval(constraint.fromMilestoneId, constraint.throughMilestoneId, basePath);
  });
  shot.hybridMotion.world.constraints.contact.forEach((constraint, index) => {
    const basePath = ['hybridMotion', 'world', 'constraints', 'contact', index];
    rememberConstraint(constraint.id, [...basePath, 'id']);
    if (!actorIdSet.has(constraint.actorId)) {
      context.addIssue({code: 'custom', path: [...basePath, 'actorId'], message: 'Contact constraint actor must be present in the generated performance.'});
    }
    if (constraint.target.owner === 'deterministic-interaction') {
      if (!propIds.has(constraint.target.propId)) {
        context.addIssue({
          code: 'custom',
          path: [...basePath, 'target', 'propId'],
          message: 'Deterministic contact target must reference an owned deterministic prop.',
        });
      } else if (propTriggerMilestoneById.get(constraint.target.propId) !== constraint.milestoneId) {
        context.addIssue({
          code: 'custom',
          path: [...basePath, 'milestoneId'],
          message: 'Deterministic contact milestone must exactly match the prop trigger milestone.',
        });
      }
    } else if (
      constraint.target.objectId !== shot.hybridMotion.world.targetId
      && !generatedObjectIds.has(constraint.target.objectId)
    ) {
      context.addIssue({
        code: 'custom',
        path: [...basePath, 'target', 'objectId'],
        message: 'Generated-world contact target must match world.targetId or a declared generatedObjectId.',
      });
    }
    const milestone = milestoneById.get(constraint.milestoneId);
    if (milestone === undefined) {
      context.addIssue({code: 'custom', path: [...basePath, 'milestoneId'], message: 'Contact milestone does not exist.'});
    } else if (constraint.kind === 'release' ? milestone.kind !== 'release' : milestone.kind !== 'contact') {
      context.addIssue({code: 'custom', path: [...basePath, 'kind'], message: 'Contact kind must match a contact/release milestone.'});
    }
  });
  propIds.forEach((propId) => {
    const contacts = shot.hybridMotion.world.constraints.contact.filter(
      (constraint) => constraint.target.owner === 'deterministic-interaction' && constraint.target.propId === propId,
    );
    if (contacts.length !== 1) {
      context.addIssue({
        code: 'custom',
        path: ['hybridMotion', 'world', 'constraints', 'contact'],
        message: `Every deterministic prop requires exactly one owned, trigger-matched contact constraint: ${propId}`,
      });
    }
  });

  if (shot.occlusion.mode === 'local-matte' && shot.occlusion.subjectId !== shot.hybridMotion.actor.id) {
    context.addIssue({
      code: 'custom',
      path: ['occlusion', 'subjectId'],
      message: 'Local matte subject must be the primary generated actor.',
    });
  }
});
export type GeneratedPerformanceShot = z.infer<typeof generatedPerformanceShotSchema>;

export const productionShotSchema = z.discriminatedUnion('kind', [
  layeredCollageShotSchema,
  generatedPerformanceShotSchema,
]);
export type ProductionShot = z.infer<typeof productionShotSchema>;

const narrationSegmentSchema = z.object({
  segmentId: productionIdSchema,
  shotId: productionIdSchema,
  text: nonEmptyTextSchema,
  outputPath: safePosixRelativePathSchema,
}).strict();

export const localF5NarrationPlanSchema = z.object({
  engine: z.literal('f5-tts-local'),
  language: nonEmptyTextSchema.max(32),
  referenceAudioPath: safePosixRelativePathSchema,
  referenceText: nonEmptyTextSchema,
  speed: z.number().finite().min(0.5).max(2),
  segments: z.array(narrationSegmentSchema).min(1),
  mergedAudioPath: safePosixRelativePathSchema,
}).strict();
export type LocalF5NarrationPlan = z.infer<typeof localF5NarrationPlanSchema>;

export const productionMetadataSchema = z.object({
  title: nonEmptyTextSchema.max(200),
  locale: z.string().regex(
    /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u,
    'Locale must use a portable BCP-47 language tag such as zh-CN.',
  ),
}).strict();
export type ProductionMetadata = z.infer<typeof productionMetadataSchema>;

/** The one and only immutable v3 project contract. No v2 manifest fallback is defined here. */
export const productionPlanSchema = z.object({
  schemaVersion: z.literal(PRODUCTION_PLAN_SCHEMA_VERSION),
  projectId: productionIdSchema,
  metadata: productionMetadataSchema,
  networkPolicy: z.literal('offline-only'),
  requiredCapabilities: uniqueCapabilitiesSchema,
  delivery: deliveryContractSchema,
  narration: localF5NarrationPlanSchema,
  shots: z.array(productionShotSchema).min(1),
}).strict().superRefine((plan, context) => {
  const shotIds = new Set<string>();
  let expectedStartFrame = 0;
  plan.shots.forEach((shot, index) => {
    if (shotIds.has(shot.shotId)) {
      context.addIssue({code: 'custom', path: ['shots', index, 'shotId'], message: `Duplicate shot ID: ${shot.shotId}`});
    }
    shotIds.add(shot.shotId);
    if (shot.deliveryTimeline.startFrame !== expectedStartFrame) {
      context.addIssue({
        code: 'custom',
        path: ['shots', index, 'deliveryTimeline', 'startFrame'],
        message: 'Shots must cover the delivery timeline contiguously without gaps or overlaps.',
      });
    }
    expectedStartFrame = shot.deliveryTimeline.startFrame + shot.deliveryTimeline.durationFrames;
  });
  if (expectedStartFrame !== plan.delivery.timeline.durationFrames) {
    context.addIssue({
      code: 'custom',
      path: ['delivery', 'timeline', 'durationFrames'],
      message: 'Delivery duration must equal the contiguous shot timeline.',
    });
  }

  const segmentIds = new Set<string>();
  const narrationOutputs = new Set<string>();
  plan.narration.segments.forEach((segment, index) => {
    if (segmentIds.has(segment.segmentId)) {
      context.addIssue({code: 'custom', path: ['narration', 'segments', index, 'segmentId'], message: `Duplicate narration segment ID: ${segment.segmentId}`});
    }
    segmentIds.add(segment.segmentId);
    if (!shotIds.has(segment.shotId)) {
      context.addIssue({code: 'custom', path: ['narration', 'segments', index, 'shotId'], message: `Narration references unknown shot: ${segment.shotId}`});
    }
    if (narrationOutputs.has(segment.outputPath)) {
      context.addIssue({code: 'custom', path: ['narration', 'segments', index, 'outputPath'], message: `Duplicate narration output path: ${segment.outputPath}`});
    }
    narrationOutputs.add(segment.outputPath);
  });
  if (plan.narration.mergedAudioPath !== plan.delivery.audio.path) {
    context.addIssue({
      code: 'custom',
      path: ['narration', 'mergedAudioPath'],
      message: 'Narration mergedAudioPath must be the canonical delivery audio path.',
    });
  }
  const deliveryPaths = [plan.delivery.video.path, plan.delivery.audio.path, plan.delivery.subtitles.path];
  if (new Set(deliveryPaths).size !== deliveryPaths.length) {
    context.addIssue({code: 'custom', path: ['delivery'], message: 'Video, audio, and sidecar subtitle paths must be distinct.'});
  }

  const capabilities = new Set(plan.requiredCapabilities);
  const requireCapability = (capability: ProductionCapability, reason: string): void => {
    if (!capabilities.has(capability)) {
      context.addIssue({code: 'custom', path: ['requiredCapabilities'], message: `${capability} is required: ${reason}`});
    }
  };
  requireCapability('local-f5-tts', 'narration is rendered locally');
  requireCapability('remotion-render', 'all shots require deterministic local composition');
  requireCapability('ffmpeg', 'local media probing and muxing are mandatory');
  requireCapability('sidecar-srt', 'delivery keeps subtitles outside the video');
  if (plan.shots.some((shot) => shot.kind === 'generated-performance')) {
    requireCapability('local-i2v', 'generated-performance shots use the local WanGP runtime');
  }
  if (plan.shots.some((shot) => shot.kind === 'generated-performance' && shot.generation.conditioning.mode === 'start-end')) {
    requireCapability('local-i2v-start-end', 'this project explicitly requests start/end conditioning');
  }
  if (plan.shots.some((shot) => shot.kind === 'generated-performance' && shot.hybridMotion.deterministicProps.length > 0)) {
    requireCapability('deterministic-ballistics', 'causal props are evaluated outside the generated plate');
  }
  if (plan.shots.some((shot) => shot.kind === 'generated-performance' && shot.occlusion.mode === 'local-matte')) {
    requireCapability('local-video-matting', 'the project declares a local matte pipeline');
  }
});
export type ProductionPlan = z.infer<typeof productionPlanSchema>;

export const parseProductionPlan = (value: unknown): ProductionPlan => productionPlanSchema.parse(value);

export const generatedPerformanceShotToHybridMotionPlan = (
  value: GeneratedPerformanceShot,
): HybridMotionPlan => {
  const shot = generatedPerformanceShotSchema.parse(value);
  const plan: HybridMotionPlan = {
    version: 1,
    shotId: shot.shotId,
    durationFrames: shot.deliveryTimeline.durationFrames,
    performance: {
      owner: 'generated-performance',
      startKeyframePath: shot.generation.conditioning.startKeyframePath,
      ...(shot.generation.conditioning.mode === 'start-end'
        ? {endKeyframePath: shot.generation.conditioning.endKeyframePath}
        : {}),
      actorIds: [shot.hybridMotion.actor.id, ...shot.hybridMotion.actor.supportingActorIds],
      characterAction: shot.hybridMotion.actor.action,
      motionPrompt: shot.hybridMotion.actor.prompt,
      negativePrompt: shot.hybridMotion.actor.negativePrompt,
      generatedCamera: shot.hybridMotion.actor.generatedCamera,
      excludedCausalPropIds: [...shot.hybridMotion.actor.excludedCausalPropIds],
    },
    interactions: shot.hybridMotion.deterministicProps.map((prop) => ({
      owner: 'deterministic-interaction',
      propId: prop.propId,
      triggerMilestoneId: prop.trigger.milestoneId,
      evaluator: 'ballistic',
      renderSize: {...prop.renderSize},
    })),
    camera: {...shot.hybridMotion.editorialCamera},
    world: {
      subjectId: shot.hybridMotion.world.subjectId,
      ...(shot.hybridMotion.world.targetId === undefined ? {} : {targetId: shot.hybridMotion.world.targetId}),
      generatedObjectIds: [...shot.hybridMotion.world.generatedObjectIds],
      supportSurfaceId: shot.hybridMotion.world.supportSurfaceId,
      actionAxis: structuredClone(shot.hybridMotion.world.actionAxis),
      milestones: shot.hybridMotion.world.milestones.map((milestone) => ({...milestone})),
      constraints: structuredClone(shot.hybridMotion.world.constraints),
    },
  };
  assertHybridMotionPlan(plan);
  return plan;
};

export const productionShotToHybridMotionPlan = (
  production: ProductionPlan,
  shotId: string,
): HybridMotionPlan => {
  const plan = productionPlanSchema.parse(production);
  const shot = plan.shots.find((candidate) => candidate.shotId === shotId);
  if (shot === undefined) throw new Error(`PRODUCTION_SHOT_NOT_FOUND:${shotId}`);
  if (shot.kind !== 'generated-performance') {
    throw new Error(`PRODUCTION_SHOT_HAS_NO_HYBRID_MOTION:${shotId}`);
  }
  return generatedPerformanceShotToHybridMotionPlan(shot);
};

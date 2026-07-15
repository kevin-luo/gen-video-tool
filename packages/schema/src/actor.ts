import {z} from 'zod';
import {
  idSchema,
  relativeAssetPathSchema,
  transformSchema,
  transitionSchema,
} from './common';

export const meshActionTemplateSchema = z.enum([
  'idle-breathe',
  'look-down',
  'look-left',
  'look-right',
  'reach',
  'point',
  'small-step',
  'celebrate',
  'nod',
  'shoulder-relax',
]);
export type MeshActionTemplate = z.infer<typeof meshActionTemplateSchema>;

export const rigidMotionSchema = z.enum([
  'enter-left',
  'enter-right',
  'enter-up',
  'enter-down',
  'scale-in',
  'paper-slap',
  'shadow-settle',
  'micro-drift',
  'bounce',
]);

const actorBaseShape = {
  id: idSchema,
  layerId: idSchema.optional(),
  zIndex: z.number().int().min(-1000).max(1000).default(0),
  transform: transformSchema.optional(),
};

export const rigidActorSchema = z
  .object({
    ...actorBaseShape,
    mode: z.literal('rigid'),
    sourcePath: relativeAssetPathSchema,
    motion: z.array(rigidMotionSchema).max(4).default([]),
  })
  .strict();

export const meshActorSchema = z
  .object({
    ...actorBaseShape,
    mode: z.literal('mesh'),
    sourcePath: relativeAssetPathSchema,
    rigPath: relativeAssetPathSchema,
    actionTemplate: meshActionTemplateSchema.optional(),
    actionStrength: z.number().finite().min(0).max(1).default(0.5),
  })
  .strict();

export const fullPoseSchema = z
  .object({
    id: idSchema,
    sourcePath: relativeAssetPathSchema,
    /** This literal documents that a pose is one continuous, complete figure. */
    fullFigure: z.literal(true).default(true),
  })
  .strict();

const poseChangeSchema = z
  .object({
    frame: z.number().int().nonnegative(),
    poseId: idSchema,
  })
  .strict();

const poseCutTransitionSchema = transitionSchema.refine(
  ({type}) =>
    type === 'hard-cut' ||
    type === 'paper-cover' ||
    type === 'prop-cover' ||
    type === 'flash-frame' ||
    type === 'tear-cover' ||
    type === 'cut-shot',
  {message: 'Pose Cut transitions must fully hide the switch; crossfade, flip, and fold are forbidden.'},
);

export const poseCutActorSchema = z
  .object({
    ...actorBaseShape,
    mode: z.literal('pose-cut'),
    poses: z.array(fullPoseSchema).min(2, 'Pose Cut requires at least two complete full-figure poses.'),
    initialPoseId: idSchema.optional(),
    changes: z.array(poseChangeSchema).default([]),
    transition: poseCutTransitionSchema.default({type: 'hard-cut', durationFrames: 0}),
  })
  .strict()
  .superRefine((actor, context) => {
    const poseIds = new Set<string>();
    for (const [index, pose] of actor.poses.entries()) {
      if (poseIds.has(pose.id)) {
        context.addIssue({code: 'custom', path: ['poses', index, 'id'], message: `Duplicate pose id: ${pose.id}`});
      }
      poseIds.add(pose.id);
    }
    if (actor.initialPoseId && !poseIds.has(actor.initialPoseId)) {
      context.addIssue({
        code: 'custom',
        path: ['initialPoseId'],
        message: `Initial pose does not exist: ${actor.initialPoseId}`,
      });
    }
    let previousFrame = -1;
    for (const [index, change] of actor.changes.entries()) {
      if (!poseIds.has(change.poseId)) {
        context.addIssue({
          code: 'custom',
          path: ['changes', index, 'poseId'],
          message: `Pose change references missing pose: ${change.poseId}`,
        });
      }
      if (change.frame <= previousFrame) {
        context.addIssue({
          code: 'custom',
          path: ['changes', index, 'frame'],
          message: 'Pose changes must be in strictly increasing frame order.',
        });
      }
      previousFrame = change.frame;
    }
  });

export const actorSchema = z.discriminatedUnion('mode', [
  rigidActorSchema,
  meshActorSchema,
  poseCutActorSchema,
]);

export type RigidActor = z.infer<typeof rigidActorSchema>;
export type MeshActor = z.infer<typeof meshActorSchema>;
export type PoseCutActor = z.infer<typeof poseCutActorSchema>;
export type Actor = z.infer<typeof actorSchema>;

import {z} from 'zod';
import {actorSchema} from './actor';
import {
  energySchema,
  idSchema,
  layerRoleSchema,
  relativeAssetPathSchema,
  schemaVersionSchema,
  transformSchema,
  transitionSchema,
} from './common';

export const motionRecipeIdSchema = z.enum([
  'hero-assemble',
  'editorial-pan',
  'number-impact',
  'paper-stack',
  'timeline-travel',
  'comparison-split',
  'quiet-story',
  'detail-reveal',
]);
export type MotionRecipeId = z.infer<typeof motionRecipeIdSchema>;

export const paperAnimationSchema = z.enum([
  'paperSlap',
  'paperUnfold',
  'paperTearReveal',
  'newspaperSlide',
  'photoStack',
  'tapeAttach',
  'propRoll',
  'propPop',
  'foregroundWipe',
  'impactShake',
  'halftonePulse',
  'shadowSettle',
  'misregistrationFlash',
]);
export type PaperAnimation = z.infer<typeof paperAnimationSchema>;

export const ballisticPropMotionSchema = z.object({
  kind: z.literal('ballistic-kick'),
  contactFrame: z.number().int().nonnegative(),
  flightFrames: z.number().int().positive().max(240),
  targetX: z.number().finite(),
  targetY: z.number().finite(),
  targetScale: z.number().finite().positive().max(4),
  curveX: z.number().finite().min(-600).max(600).default(0),
  spinDegrees: z.number().finite().min(-1440).max(1440).default(360),
}).strict();
export type BallisticPropMotion = z.infer<typeof ballisticPropMotionSchema>;

export const layerSchema = z
  .object({
    id: idSchema,
    role: layerRoleSchema,
    assetPath: relativeAssetPathSchema.optional(),
    text: z.string().min(1).max(500).optional(),
    transform: transformSchema.optional(),
    physicalMotion: ballisticPropMotionSchema.optional(),
    depth: z.number().finite().min(0).max(1).default(0.5),
    visible: z.boolean().default(true),
  })
  .strict()
  .superRefine((layer, context) => {
    if (!layer.assetPath && !layer.text) {
      context.addIssue({code: 'custom', message: 'A layer must reference an asset or contain text.'});
    }
    if (layer.role === 'title' && !layer.text) {
      context.addIssue({code: 'custom', path: ['text'], message: 'Title layers must remain editable text.'});
    }
  });
export type Layer = z.infer<typeof layerSchema>;

export const cameraSchema = z
  .object({
    kind: z.enum(['locked', 'push', 'pull', 'pan-left', 'pan-right', 'pan-up', 'pan-down']).default('locked'),
    strength: z.number().finite().min(0).max(1).default(0.35),
  })
  .strict();

export const motionEventSchema = z
  .object({
    id: idSchema,
    targetRole: layerRoleSchema,
    animation: paperAnimationSchema,
    startFrame: z.number().int().nonnegative(),
    durationFrames: z.number().int().positive().max(240),
  })
  .strict()
  .superRefine((event, context) => {
    if (event.animation === 'impactShake' && (event.durationFrames < 6 || event.durationFrames > 12)) {
      context.addIssue({
        code: 'custom',
        path: ['durationFrames'],
        message: 'impactShake must last between 6 and 12 frames.',
      });
    }
  });
export type MotionEvent = z.infer<typeof motionEventSchema>;

export const titleSchema = z
  .object({
    text: z.string().min(1).max(240),
    language: z.enum(['zh-CN', 'en', 'bilingual']).default('zh-CN'),
    maxLines: z.number().int().min(1).max(6).default(3),
    safeArea: z.number().finite().min(0).max(0.25).default(0.08),
    paperBackground: z.boolean().default(true),
    rotation: z.number().finite().min(-12).max(12).default(0),
  })
  .strict();

export const shotSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: idSchema,
    name: z.string().min(1).max(120).optional(),
    durationFrames: z.number().int().positive().max(18_000),
    recipeId: motionRecipeIdSchema,
    energy: energySchema.default('balanced'),
    camera: cameraSchema.optional(),
    layers: z.array(layerSchema).min(1),
    actors: z.array(actorSchema).default([]),
    motionEvents: z.array(motionEventSchema).default([]),
    title: titleSchema.optional(),
    transition: transitionSchema.default({type: 'hard-cut', durationFrames: 0}),
  })
  .strict()
  .superRefine((shot, context) => {
    const layerIds = new Set<string>();
    for (const [index, layer] of shot.layers.entries()) {
      if (layerIds.has(layer.id)) {
        context.addIssue({code: 'custom', path: ['layers', index, 'id'], message: `Duplicate layer id: ${layer.id}`});
      }
      layerIds.add(layer.id);
    }
    const actorIds = new Set<string>();
    for (const [index, actor] of shot.actors.entries()) {
      if (actorIds.has(actor.id)) {
        context.addIssue({code: 'custom', path: ['actors', index, 'id'], message: `Duplicate actor id: ${actor.id}`});
      }
      actorIds.add(actor.id);
      if (actor.layerId && !layerIds.has(actor.layerId)) {
        context.addIssue({
          code: 'custom',
          path: ['actors', index, 'layerId'],
          message: `Actor references missing layer: ${actor.layerId}`,
        });
      }
      if (actor.mode === 'mesh') {
        const actionDuration = actor.actionDurationFrames ?? shot.durationFrames - actor.actionStartFrame;
        if (actor.actionStartFrame + actionDuration > shot.durationFrames) {
          context.addIssue({
            code: 'custom',
            path: ['actors', index, 'actionDurationFrames'],
            message: 'Mesh action extends beyond the shot duration.',
          });
        }
      }
    }
    for (const [index, event] of shot.motionEvents.entries()) {
      if (event.startFrame + event.durationFrames > shot.durationFrames) {
        context.addIssue({
          code: 'custom',
          path: ['motionEvents', index],
          message: 'Motion event extends beyond the shot duration.',
        });
      }
    }
    for (const [index, layer] of shot.layers.entries()) {
      if (layer.physicalMotion && layer.physicalMotion.contactFrame + layer.physicalMotion.flightFrames > shot.durationFrames) {
        context.addIssue({
          code: 'custom',
          path: ['layers', index, 'physicalMotion'],
          message: 'Physical prop motion extends beyond the shot duration.',
        });
      }
      if (layer.physicalMotion && layer.role !== 'prop') {
        context.addIssue({
          code: 'custom',
          path: ['layers', index, 'physicalMotion'],
          message: 'Physical prop motion can only be attached to a prop layer.',
        });
      }
    }
  });

export type ShotDocument = z.infer<typeof shotSchema>;

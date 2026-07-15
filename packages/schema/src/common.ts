import {z} from 'zod';

export const CURRENT_SCHEMA_VERSION = 2 as const;

export const schemaVersionSchema = z.literal(CURRENT_SCHEMA_VERSION);

export const idSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, 'Use letters, numbers, underscores, or hyphens.');

/**
 * Asset-pack paths are portable, project-relative POSIX paths. Keeping this
 * invariant in the schema means no renderer or importer needs to guess what
 * a leading slash, drive prefix, or traversal segment means.
 */
export const relativeAssetPathSchema = z
  .string()
  .min(1)
  .max(512)
  .superRefine((value, context) => {
    const normalized = value.replace(/\\/g, '/');
    if (value.includes('\\')) {
      context.addIssue({code: 'custom', message: 'Asset paths must use forward slashes.'});
    }
    if (normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized)) {
      context.addIssue({code: 'custom', message: 'Asset paths must be relative.'});
    }
    if (normalized.split('/').some((segment) => segment === '..' || segment === '')) {
      context.addIssue({code: 'custom', message: 'Asset paths cannot contain traversal or empty segments.'});
    }
    if (normalized.includes('\0')) {
      context.addIssue({code: 'custom', message: 'Asset paths cannot contain null bytes.'});
    }
  });

export const aspectRatioSchema = z.enum(['9:16', '16:9', '1:1', '4:5']);
export type AspectRatio = z.infer<typeof aspectRatioSchema>;

export const energySchema = z.enum(['quiet', 'balanced', 'punchy']);
export type Energy = z.infer<typeof energySchema>;

export const layerRoleSchema = z.enum([
  'background',
  'subject',
  'prop',
  'foreground',
  'title',
  'overlay',
]);
export type LayerRole = z.infer<typeof layerRoleSchema>;

export const transformSchema = z
  .object({
    x: z.number().finite().default(0),
    y: z.number().finite().default(0),
    scaleX: z.number().finite().positive().default(1),
    scaleY: z.number().finite().positive().default(1),
    rotation: z.number().finite().min(-360).max(360).default(0),
    opacity: z.number().finite().min(0).max(1).default(1),
    anchorX: z.number().finite().min(0).max(1).default(0.5),
    anchorY: z.number().finite().min(0).max(1).default(0.5),
  })
  .strict();
export type Transform = z.infer<typeof transformSchema>;

export const canvasSchema = z
  .object({
    width: z.number().int().positive().max(16384),
    height: z.number().int().positive().max(16384),
    aspectRatio: aspectRatioSchema,
  })
  .strict()
  .superRefine(({width, height, aspectRatio}, context) => {
    const expected = {
      '9:16': 9 / 16,
      '16:9': 16 / 9,
      '1:1': 1,
      '4:5': 4 / 5,
    }[aspectRatio];
    const actual = width / height;
    if (Math.abs(actual - expected) > 0.02) {
      context.addIssue({
        code: 'custom',
        path: ['aspectRatio'],
        message: `Canvas ${width}x${height} does not match ${aspectRatio}.`,
      });
    }
  });
export type Canvas = z.infer<typeof canvasSchema>;

export const transitionTypeSchema = z.enum([
  'hard-cut',
  'paper-cover',
  'prop-cover',
  'flash-frame',
  'tear-cover',
  'cut-shot',
  'foreground-wipe',
]);
export type TransitionType = z.infer<typeof transitionTypeSchema>;

export const transitionSchema = z
  .object({
    type: transitionTypeSchema.default('hard-cut'),
    durationFrames: z.number().int().min(0).max(45).default(0),
    coverLayerId: idSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.type === 'hard-cut' && value.durationFrames !== 0) {
      context.addIssue({
        code: 'custom',
        path: ['durationFrames'],
        message: 'A hard cut must have zero transition frames.',
      });
    }
    if (
      (value.type === 'paper-cover' || value.type === 'prop-cover' || value.type === 'foreground-wipe') &&
      !value.coverLayerId
    ) {
      context.addIssue({
        code: 'custom',
        path: ['coverLayerId'],
        message: `${value.type} requires a cover layer that fully hides the switch.`,
      });
    }
  });
export type Transition = z.infer<typeof transitionSchema>;

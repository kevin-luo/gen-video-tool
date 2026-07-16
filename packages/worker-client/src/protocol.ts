import {z} from 'zod';

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

export const motionWorkerRequestSchema = z.object({
  protocolVersion: z.literal(1),
  requestId: z.string().min(1),
  projectId: z.string().min(1),
  actorId: z.string().min(1),
  texturePath: z.string().min(1),
  rigPath: z.string().min(1),
  ffmpegPath: z.string().min(1).optional(),
  action: z.object({
    template: meshActionTemplateSchema,
    durationInFrames: z.number().int().min(1).max(1800),
    startFrame: z.number().int().nonnegative().default(0),
    activeDurationInFrames: z.number().int().positive().max(1800).optional(),
    fps: z.number().int().min(1).max(120),
    amplitude: z.number().min(0).max(1).default(0.35),
  }),
  output: z.object({
    directory: z.string().min(1),
    format: z.enum(['png-sequence', 'transparent-webm', 'alpha-mov']),
    width: z.number().int().positive().max(8192),
    height: z.number().int().positive().max(8192),
    cleanupFrames: z.boolean().default(true),
  }),
});

export type MotionWorkerRequest = z.infer<typeof motionWorkerRequestSchema>;

export const motionWorkerResultSchema = z.object({
  protocolVersion: z.literal(1),
  requestId: z.string().min(1),
  status: z.enum(['complete', 'failed', 'unsupported']),
  outputPath: z.string().optional(),
  frameCount: z.number().int().nonnegative().optional(),
  fps: z.number().int().positive().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  format: z.enum(['png-sequence', 'transparent-webm', 'alpha-mov']).optional(),
  hasAlpha: z.boolean().optional(),
  warnings: z.array(z.string()).default([]),
  error: z.object({code: z.string(), message: z.string()}).optional(),
});

export type MotionWorkerResult = z.infer<typeof motionWorkerResultSchema>;

export const workerCapabilitiesSchema = z.object({
  protocolVersion: z.literal(1),
  workerVersion: z.string(),
  actions: z.array(meshActionTemplateSchema),
  formats: z.array(z.enum(['png-sequence', 'transparent-webm', 'alpha-mov'])),
});

export type WorkerCapabilities = z.infer<typeof workerCapabilitiesSchema>;

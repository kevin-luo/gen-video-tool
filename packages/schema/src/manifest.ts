import {z} from 'zod';
import {
  canvasSchema,
  idSchema,
  relativeAssetPathSchema,
  schemaVersionSchema,
} from './common';

export const shotReferenceSchema = z
  .object({id: idSchema, path: relativeAssetPathSchema})
  .strict();

export const manifestSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    projectId: idSchema,
    title: z.string().min(1).max(160),
    locale: z.string().min(2).max(24).default('zh-CN'),
    canvas: canvasSchema,
    fps: z.number().int().min(12).max(120).default(30),
    shots: z.array(shotReferenceSchema).min(1),
    /** Optional legacy alias for audio.narrationPath. */
    narrationPath: relativeAssetPathSchema.optional(),
    narrationTextPath: relativeAssetPathSchema.optional(),
    subtitlesPath: relativeAssetPathSchema.optional(),
    styleReferencePath: relativeAssetPathSchema.optional(),
    audio: z
      .object({
        narrationPath: relativeAssetPathSchema,
        durationSeconds: z.number().finite().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((manifest, context) => {
    const shotIds = new Set<string>();
    const shotPaths = new Set<string>();
    for (const [index, shot] of manifest.shots.entries()) {
      if (shotIds.has(shot.id)) {
        context.addIssue({code: 'custom', path: ['shots', index, 'id'], message: `Duplicate shot id: ${shot.id}`});
      }
      if (shotPaths.has(shot.path)) {
        context.addIssue({code: 'custom', path: ['shots', index, 'path'], message: `Duplicate shot path: ${shot.path}`});
      }
      shotIds.add(shot.id);
      shotPaths.add(shot.path);
    }
    if (manifest.narrationPath && manifest.audio && manifest.narrationPath !== manifest.audio.narrationPath) {
      context.addIssue({
        code: 'custom',
        path: ['audio', 'narrationPath'],
        message: 'Top-level and audio narration paths must match.',
      });
    }
  });

export type ManifestDocument = z.infer<typeof manifestSchema>;

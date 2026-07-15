import {z} from 'zod';
import {schemaVersionSchema} from './common';
import {manifestSchema} from './manifest';
import {shotSchema} from './shot';

export const projectSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    manifest: manifestSchema,
    shots: z.array(shotSchema).min(1),
  })
  .strict()
  .superRefine((project, context) => {
    const shotsById = new Map(project.shots.map((shot) => [shot.id, shot]));
    for (const [index, reference] of project.manifest.shots.entries()) {
      if (!shotsById.has(reference.id)) {
        context.addIssue({
          code: 'custom',
          path: ['manifest', 'shots', index, 'id'],
          message: `Manifest references missing shot document: ${reference.id}`,
        });
      }
    }
    const references = new Set(project.manifest.shots.map((reference) => reference.id));
    for (const [index, shot] of project.shots.entries()) {
      if (!references.has(shot.id)) {
        context.addIssue({
          code: 'custom',
          path: ['shots', index, 'id'],
          message: `Shot document is not declared in manifest: ${shot.id}`,
        });
      }
    }
  });

export type ProjectDocument = z.infer<typeof projectSchema>;

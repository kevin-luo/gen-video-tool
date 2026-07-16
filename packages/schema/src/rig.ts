import {z} from 'zod';
import {idSchema, relativeAssetPathSchema, schemaVersionSchema} from './common';

const pointSchema = z.object({x: z.number().finite(), y: z.number().finite()}).strict();

const boneSchema = z
  .object({
    id: idSchema,
    parentId: idSchema.nullable().default(null),
    pivot: pointSchema,
    tip: pointSchema,
    rotationMin: z.number().finite().min(-180).max(180).default(-20),
    rotationMax: z.number().finite().min(-180).max(180).default(20),
  })
  .strict()
  .superRefine((bone, context) => {
    if (bone.rotationMin > bone.rotationMax) {
      context.addIssue({
        code: 'custom',
        path: ['rotationMin'],
        message: 'rotationMin cannot exceed rotationMax.',
      });
    }
    if (bone.parentId === bone.id) {
      context.addIssue({code: 'custom', path: ['parentId'], message: 'A bone cannot parent itself.'});
    }
  });

const vertexSchema = pointSchema;
const triangleSchema = z.tuple([
  z.number().int().nonnegative(),
  z.number().int().nonnegative(),
  z.number().int().nonnegative(),
]);
const weightSchema = z.object({boneId: idSchema, weight: z.number().finite().min(0).max(1)}).strict();

export const rigSchema = z
  .object({
    /** rig.json v1 remains wire-compatible with asset-pack schema v2. */
    schemaVersion: z.union([z.literal(1), schemaVersionSchema]),
    texturePath: relativeAssetPathSchema,
    canvas: z.object({width: z.number().int().positive(), height: z.number().int().positive()}).strict(),
    bones: z.array(boneSchema).min(1),
    mesh: z
      .object({
        vertices: z.array(vertexSchema).min(3),
        triangles: z.array(triangleSchema).min(1),
        /** One normalized influence list for every vertex. */
        weights: z.array(z.array(weightSchema).min(1)),
        /** Boundary vertices come first; remaining vertices are internal mesh controls. */
        boundaryVertexCount: z.number().int().min(3).optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((rig, context) => {
    const boneIds = new Set<string>();
    for (const [index, bone] of rig.bones.entries()) {
      if (boneIds.has(bone.id)) {
        context.addIssue({code: 'custom', path: ['bones', index, 'id'], message: `Duplicate bone id: ${bone.id}`});
      }
      boneIds.add(bone.id);
    }

    for (const [index, bone] of rig.bones.entries()) {
      if (bone.parentId && !boneIds.has(bone.parentId)) {
        context.addIssue({
          code: 'custom',
          path: ['bones', index, 'parentId'],
          message: `Unknown parent bone: ${bone.parentId}`,
        });
      }
    }

    if (rig.mesh.weights.length !== rig.mesh.vertices.length) {
      context.addIssue({
        code: 'custom',
        path: ['mesh', 'weights'],
        message: 'Mesh weights must contain one influence list per vertex.',
      });
    }

    if (rig.mesh.boundaryVertexCount && rig.mesh.boundaryVertexCount > rig.mesh.vertices.length) {
      context.addIssue({
        code: 'custom',
        path: ['mesh', 'boundaryVertexCount'],
        message: 'boundaryVertexCount cannot exceed the vertex count.',
      });
    }

    for (const [triangleIndex, triangle] of rig.mesh.triangles.entries()) {
      for (const vertexIndex of triangle) {
        if (vertexIndex >= rig.mesh.vertices.length) {
          context.addIssue({
            code: 'custom',
            path: ['mesh', 'triangles', triangleIndex],
            message: `Triangle references missing vertex ${vertexIndex}.`,
          });
        }
      }
      if (new Set(triangle).size !== 3) {
        context.addIssue({
          code: 'custom',
          path: ['mesh', 'triangles', triangleIndex],
          message: 'A triangle must reference three different vertices.',
        });
      }
    }

    for (const [vertexIndex, influences] of rig.mesh.weights.entries()) {
      let total = 0;
      for (const [weightIndex, influence] of influences.entries()) {
        total += influence.weight;
        if (!boneIds.has(influence.boneId)) {
          context.addIssue({
            code: 'custom',
            path: ['mesh', 'weights', vertexIndex, weightIndex, 'boneId'],
            message: `Unknown weighted bone: ${influence.boneId}`,
          });
        }
      }
      if (Math.abs(total - 1) > 0.001) {
        context.addIssue({
          code: 'custom',
          path: ['mesh', 'weights', vertexIndex],
          message: `Vertex weights must sum to 1 (received ${total}).`,
        });
      }
    }
  });

export type Rig = z.infer<typeof rigSchema>;

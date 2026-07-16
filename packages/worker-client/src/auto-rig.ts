import sharp from 'sharp';
import {rigSchema, type Rig} from '@gen-video-tool/schema';

type Point = {x: number; y: number};
type Bone = Rig['bones'][number];

const distanceToSegment = (point: Point, start: Point, end: Point): number => {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  const projection = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (start.x + projection * dx), point.y - (start.y + projection * dy));
};

const normalizedWeights = (point: Point, bones: Bone[], falloff: number) => {
  const ranked = bones
    .map((bone) => ({boneId: bone.id, score: Math.exp(-distanceToSegment(point, bone.pivot, bone.tip) / falloff)}))
    .sort((left, right) => right.score - left.score)
    .slice(0, 4);
  const total = ranked.reduce((sum, item) => sum + item.score, 0);
  const weights = ranked.map((item) => ({boneId: item.boneId, weight: Number((item.score / total).toFixed(6))}));
  const roundingError = 1 - weights.reduce((sum, item) => sum + item.weight, 0);
  if (weights[0]) weights[0].weight = Number((weights[0].weight + roundingError).toFixed(6));
  return weights;
};

const alphaBounds = async (texturePath: string) => {
  const {data, info} = await sharp(texturePath).ensureAlpha().raw().toBuffer({resolveWithObject: true});
  let minX = info.width;
  let minY = info.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      if ((data[(y * info.width + x) * 4 + 3] ?? 0) < 12) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < minX || maxY < minY) throw new Error('AUTO_RIG_EMPTY_ALPHA');
  return {canvasWidth: info.width, canvasHeight: info.height, minX, minY, maxX, maxY};
};

/**
 * Creates a deterministic humanoid first-pass rig from one complete transparent figure.
 * It intentionally returns an editable heuristic rather than pretending to infer anatomy perfectly.
 */
export const createAutoRig = async (texturePath: string, textureRelativePath: string): Promise<Rig> => {
  const bounds = await alphaBounds(texturePath);
  const width = Math.max(1, bounds.maxX - bounds.minX);
  const height = Math.max(1, bounds.maxY - bounds.minY);
  const x = (ratio: number) => Math.round(bounds.minX + width * ratio);
  const y = (ratio: number) => Math.round(bounds.minY + height * ratio);
  const bones: Bone[] = [
    {id: 'root', parentId: null, pivot: {x: x(0.5), y: y(0.61)}, tip: {x: x(0.5), y: y(0.51)}, rotationMin: -8, rotationMax: 8},
    {id: 'spine', parentId: 'root', pivot: {x: x(0.5), y: y(0.61)}, tip: {x: x(0.5), y: y(0.27)}, rotationMin: -12, rotationMax: 12},
    {id: 'head', parentId: 'spine', pivot: {x: x(0.5), y: y(0.27)}, tip: {x: x(0.5), y: y(0.07)}, rotationMin: -12, rotationMax: 12},
    {id: 'upper-arm-left', parentId: 'spine', pivot: {x: x(0.37), y: y(0.32)}, tip: {x: x(0.2), y: y(0.48)}, rotationMin: -45, rotationMax: 45},
    {id: 'lower-arm-left', parentId: 'upper-arm-left', pivot: {x: x(0.2), y: y(0.48)}, tip: {x: x(0.08), y: y(0.63)}, rotationMin: -30, rotationMax: 30},
    {id: 'upper-arm-right', parentId: 'spine', pivot: {x: x(0.63), y: y(0.32)}, tip: {x: x(0.8), y: y(0.48)}, rotationMin: -45, rotationMax: 45},
    {id: 'lower-arm-right', parentId: 'upper-arm-right', pivot: {x: x(0.8), y: y(0.48)}, tip: {x: x(0.92), y: y(0.63)}, rotationMin: -30, rotationMax: 30},
    {id: 'thigh-left', parentId: 'root', pivot: {x: x(0.43), y: y(0.61)}, tip: {x: x(0.34), y: y(0.79)}, rotationMin: -18, rotationMax: 18},
    {id: 'shin-left', parentId: 'thigh-left', pivot: {x: x(0.34), y: y(0.79)}, tip: {x: x(0.27), y: y(0.97)}, rotationMin: -18, rotationMax: 18},
    {id: 'thigh-right', parentId: 'root', pivot: {x: x(0.57), y: y(0.61)}, tip: {x: x(0.66), y: y(0.79)}, rotationMin: -18, rotationMax: 18},
    {id: 'shin-right', parentId: 'thigh-right', pivot: {x: x(0.66), y: y(0.79)}, tip: {x: x(0.73), y: y(0.97)}, rotationMin: -18, rotationMax: 18},
  ];

  const columns = 9;
  const rows = 11;
  const xs = Array.from({length: columns}, (_, index) => Math.round(bounds.minX + width * index / (columns - 1)));
  const ys = Array.from({length: rows}, (_, index) => Math.round(bounds.minY + height * index / (rows - 1)));
  const boundary: Point[] = [
    ...xs.map((value) => ({x: value, y: ys[0]!})),
    ...ys.slice(1).map((value) => ({x: xs.at(-1)!, y: value})),
    ...xs.slice(0, -1).reverse().map((value) => ({x: value, y: ys.at(-1)!})),
    ...ys.slice(1, -1).reverse().map((value) => ({x: xs[0]!, y: value})),
  ];
  const internal = ys.slice(1, -1).flatMap((row) => xs.slice(1, -1).map((column) => ({x: column, y: row})));
  const vertices = [...boundary, ...internal];
  const key = (point: Point) => `${point.x}:${point.y}`;
  const indexByPoint = new Map(vertices.map((point, index) => [key(point), index]));
  const triangles: [number, number, number][] = [];
  for (let row = 0; row < rows - 1; row += 1) {
    for (let column = 0; column < columns - 1; column += 1) {
      const a = indexByPoint.get(key({x: xs[column]!, y: ys[row]!}))!;
      const b = indexByPoint.get(key({x: xs[column + 1]!, y: ys[row]!}))!;
      const c = indexByPoint.get(key({x: xs[column]!, y: ys[row + 1]!}))!;
      const d = indexByPoint.get(key({x: xs[column + 1]!, y: ys[row + 1]!}))!;
      triangles.push([a, b, d], [a, d, c]);
    }
  }
  return rigSchema.parse({
    schemaVersion: 1,
    texturePath: textureRelativePath,
    canvas: {width: bounds.canvasWidth, height: bounds.canvasHeight},
    bones,
    mesh: {
      boundaryVertexCount: boundary.length,
      vertices,
      triangles,
      weights: vertices.map((point) => normalizedWeights(point, bones, Math.max(24, width * 0.12))),
    },
  });
};

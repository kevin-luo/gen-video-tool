import fs from 'node:fs/promises';
import path from 'node:path';

type Point = {x: number; y: number};
type Bone = {
  id: string;
  parentId: string | null;
  pivot: Point;
  tip: Point;
  rotationMin: number;
  rotationMax: number;
};

const root = path.resolve(import.meta.dirname, '..');
const width = 420;
const height = 575;
const xs = Array.from({length: 8}, (_, index) => Math.round(index * width / 7));
const ys = Array.from({length: 10}, (_, index) => Math.round(index * height / 9));
const bones: Bone[] = [
  {id: 'root', parentId: null, pivot: {x: 210, y: 350}, tip: {x: 210, y: 300}, rotationMin: -8, rotationMax: 8},
  {id: 'spine', parentId: 'root', pivot: {x: 210, y: 350}, tip: {x: 210, y: 165}, rotationMin: -12, rotationMax: 12},
  {id: 'head', parentId: 'spine', pivot: {x: 210, y: 165}, tip: {x: 210, y: 70}, rotationMin: -12, rotationMax: 12},
  {id: 'upper-arm-left', parentId: 'spine', pivot: {x: 150, y: 190}, tip: {x: 92, y: 278}, rotationMin: -45, rotationMax: 45},
  {id: 'lower-arm-left', parentId: 'upper-arm-left', pivot: {x: 92, y: 278}, tip: {x: 45, y: 342}, rotationMin: -30, rotationMax: 30},
  {id: 'upper-arm-right', parentId: 'spine', pivot: {x: 270, y: 190}, tip: {x: 328, y: 278}, rotationMin: -45, rotationMax: 45},
  {id: 'lower-arm-right', parentId: 'upper-arm-right', pivot: {x: 328, y: 278}, tip: {x: 375, y: 342}, rotationMin: -30, rotationMax: 30},
  {id: 'thigh-left', parentId: 'root', pivot: {x: 180, y: 350}, tip: {x: 130, y: 435}, rotationMin: -18, rotationMax: 18},
  {id: 'shin-left', parentId: 'thigh-left', pivot: {x: 130, y: 435}, tip: {x: 98, y: 525}, rotationMin: -18, rotationMax: 18},
  {id: 'thigh-right', parentId: 'root', pivot: {x: 240, y: 350}, tip: {x: 290, y: 435}, rotationMin: -18, rotationMax: 18},
  {id: 'shin-right', parentId: 'thigh-right', pivot: {x: 290, y: 435}, tip: {x: 322, y: 525}, rotationMin: -18, rotationMax: 18},
];

const distanceToSegment = (point: Point, start: Point, end: Point) => {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  const projection = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (start.x + projection * dx), point.y - (start.y + projection * dy));
};

const influencesFor = (point: Point) => {
  const ranked = bones
    .map((bone) => ({boneId: bone.id, score: Math.exp(-distanceToSegment(point, bone.pivot, bone.tip) / 52)}))
    .sort((left, right) => right.score - left.score)
    .slice(0, 4);
  const total = ranked.reduce((sum, item) => sum + item.score, 0);
  const normalized = ranked.map((item) => ({boneId: item.boneId, weight: Number((item.score / total).toFixed(6))}));
  const roundingError = 1 - normalized.reduce((sum, item) => sum + item.weight, 0);
  normalized[0]!.weight = Number((normalized[0]!.weight + roundingError).toFixed(6));
  return normalized;
};

const boundary: Point[] = [
  ...xs.map((x) => ({x, y: 0})),
  ...ys.slice(1).map((y) => ({x: width, y})),
  ...xs.slice(0, -1).reverse().map((x) => ({x, y: height})),
  ...ys.slice(1, -1).reverse().map((y) => ({x: 0, y})),
];
const internal: Point[] = ys.slice(1, -1).flatMap((y) => xs.slice(1, -1).map((x) => ({x, y})));
const vertices = [...boundary, ...internal];
const key = ({x, y}: Point) => `${x}:${y}`;
const indexByPoint = new Map(vertices.map((point, index) => [key(point), index]));
const triangles: [number, number, number][] = [];
for (let row = 0; row < ys.length - 1; row += 1) {
  for (let column = 0; column < xs.length - 1; column += 1) {
    const a = indexByPoint.get(key({x: xs[column]!, y: ys[row]!}))!;
    const b = indexByPoint.get(key({x: xs[column + 1]!, y: ys[row]!}))!;
    const c = indexByPoint.get(key({x: xs[column]!, y: ys[row + 1]!}))!;
    const d = indexByPoint.get(key({x: xs[column + 1]!, y: ys[row + 1]!}))!;
    triangles.push([a, b, d], [a, d, c]);
  }
}

const rig = {
  schemaVersion: 1,
  texturePath: 'assets/characters/keeper/character.png',
  canvas: {width, height},
  bones,
  mesh: {
    boundaryVertexCount: boundary.length,
    vertices,
    triangles,
    weights: vertices.map(influencesFor),
  },
};

const output = path.join(root, 'examples', 'football-history', 'assets', 'characters', 'keeper', 'rig.json');
await fs.writeFile(output, `${JSON.stringify(rig, null, 2)}\n`, 'utf8');
console.log(output);

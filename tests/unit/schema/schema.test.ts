import {describe, expect, it} from 'vitest';
import {
  actorSchema,
  manifestSchema,
  motionEventSchema,
  parseProjectDocument,
  projectSchema,
  rigSchema,
  shotSchema,
  UnsupportedSchemaVersionError,
} from '@gen-video-tool/schema';

const validLayers = [
  {id: 'plate', role: 'background' as const, assetPath: 'shots/shot-01/background.png', depth: 0.1},
  {id: 'hero', role: 'subject' as const, assetPath: 'characters/hero/character.png', depth: 0.55},
  {id: 'headline', role: 'title' as const, text: 'A human headline', depth: 0.2},
];

const validShot = {
  schemaVersion: 2 as const,
  id: 'shot-01',
  durationFrames: 150,
  recipeId: 'hero-assemble' as const,
  layers: validLayers,
  actors: [
    {
      id: 'hero-actor',
      mode: 'rigid' as const,
      layerId: 'hero',
      sourcePath: 'characters/hero/character.png',
    },
  ],
};

const validManifest = {
  schemaVersion: 2 as const,
  projectId: 'football-history',
  title: 'Football History',
  canvas: {width: 1080, height: 1920, aspectRatio: '9:16' as const},
  fps: 30,
  shots: [{id: 'shot-01', path: 'shots/shot-01/shot.json'}],
  subtitlesPath: 'subtitles.srt',
};

describe('schema v2 documents', () => {
  it('parses a complete project and applies deterministic defaults', () => {
    const project = projectSchema.parse({
      schemaVersion: 2,
      manifest: validManifest,
      shots: [validShot],
    });

    expect(project.manifest.locale).toBe('zh-CN');
    expect(project.shots[0]?.energy).toBe('balanced');
    expect(project.shots[0]?.actors[0]?.mode).toBe('rigid');
    expect(project.shots[0]?.transition).toEqual({type: 'hard-cut', durationFrames: 0});
  });

  it('keeps all three actor modes as a discriminated union', () => {
    const actors = [
      {id: 'rigid', mode: 'rigid', sourcePath: 'characters/a.png'},
      {
        id: 'mesh',
        mode: 'mesh',
        sourcePath: 'characters/b.png',
        rigPath: 'characters/b-rig.json',
        actionTemplate: 'point',
      },
      {
        id: 'cut',
        mode: 'pose-cut',
        poses: [
          {id: 'before', sourcePath: 'characters/c-before.png'},
          {id: 'after', sourcePath: 'characters/c-after.png'},
        ],
      },
    ].map((actor) => actorSchema.parse(actor));

    expect(actors.map((actor) => actor.mode)).toEqual(['rigid', 'mesh', 'pose-cut']);
    expect(actors[2]).toMatchObject({poses: [{fullFigure: true}, {fullFigure: true}]});
  });

  it('requires at least two continuous full-figure Pose Cut poses', () => {
    const result = actorSchema.safeParse({
      id: 'cut',
      mode: 'pose-cut',
      poses: [{id: 'only', sourcePath: 'characters/only.png'}],
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toContain('at least two');
  });

  it.each(['crossfade', 'flip', 'fold'])('rejects forbidden Pose Cut effect %s', (type) => {
    expect(() =>
      actorSchema.parse({
        id: 'cut',
        mode: 'pose-cut',
        poses: [
          {id: 'one', sourcePath: 'characters/one.png'},
          {id: 'two', sourcePath: 'characters/two.png'},
        ],
        transition: {type, durationFrames: 10},
      }),
    ).toThrow();
  });

  it('rejects path traversal at the schema boundary', () => {
    expect(() =>
      manifestSchema.parse({...validManifest, subtitlesPath: '../outside/subtitles.srt'}),
    ).toThrow(/traversal/i);
    expect(() =>
      manifestSchema.parse({...validManifest, styleReferencePath: 'C:/secret/style.png'}),
    ).toThrow(/relative/i);
  });

  it('rejects duplicate layer identifiers and actor references to missing layers', () => {
    const result = shotSchema.safeParse({
      ...validShot,
      layers: [validLayers[0], validLayers[0]],
      actors: [
        {id: 'lost', mode: 'rigid', layerId: 'missing', sourcePath: 'characters/lost.png'},
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message).join(' ')).toMatch(/Duplicate layer|missing layer/);
    }
  });

  it('enforces the short 6-12 frame impactShake invariant', () => {
    const base = {
      id: 'impact',
      targetRole: 'subject',
      animation: 'impactShake',
      startFrame: 20,
    };
    expect(motionEventSchema.safeParse({...base, durationFrames: 5}).success).toBe(false);
    expect(motionEventSchema.safeParse({...base, durationFrames: 6}).success).toBe(true);
    expect(motionEventSchema.safeParse({...base, durationFrames: 12}).success).toBe(true);
    expect(motionEventSchema.safeParse({...base, durationFrames: 13}).success).toBe(false);
  });
});
describe('mesh rig schema', () => {
  const rig = {
    schemaVersion: 2,
    texturePath: 'characters/hero/character.png',
    canvas: {width: 900, height: 1600},
    bones: [
      {id: 'root', parentId: null, pivot: {x: 450, y: 800}, tip: {x: 450, y: 500}},
      {id: 'arm', parentId: 'root', pivot: {x: 450, y: 600}, tip: {x: 650, y: 700}},
    ],
    mesh: {
      vertices: [{x: 0, y: 0}, {x: 900, y: 0}, {x: 450, y: 1600}],
      triangles: [[0, 1, 2]],
      weights: [
        [{boneId: 'root', weight: 1}],
        [{boneId: 'arm', weight: 1}],
        [
          {boneId: 'root', weight: 0.5},
          {boneId: 'arm', weight: 0.5},
        ],
      ],
    },
  };

  it('accepts a continuous-texture weighted mesh', () => {
    expect(rigSchema.parse(rig).texturePath).toBe('characters/hero/character.png');
  });

  it('checks bone references, triangle indices, and normalized weights', () => {
    const broken = structuredClone(rig);
    broken.mesh.triangles = [[0, 1, 99]];
    broken.mesh.weights[0] = [{boneId: 'phantom', weight: 0.3}];
    const result = rigSchema.safeParse(broken);
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((issue) => issue.message).join(' ');
      expect(messages).toMatch(/missing vertex/);
      expect(messages).toMatch(/Unknown weighted bone/);
      expect(messages).toMatch(/sum to 1/);
    }
  });
});

describe('v1 to v2 migration', () => {
  it('migrates a complete legacy project without guessing model coordinates', () => {
    const migrated = parseProjectDocument({
      schemaVersion: 1,
      manifest: {
        version: 1,
        id: 'legacy-football',
        name: 'Legacy Football',
        ratio: '9:16',
        shots: [{id: 'shot-01', file: 'shots/shot-01/shot.json'}],
        subtitles: 'subtitles.srt',
      },
      shots: [
        {
          version: 1,
          id: 'shot-01',
          frames: 120,
          template: 'editorial-pan',
          layers: [
            {id: 'plate', type: 'background', src: 'shots/shot-01/background.png'},
            {id: 'hero', type: 'subject', src: 'characters/hero.png'},
          ],
        },
      ],
    });

    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.manifest).toMatchObject({
      schemaVersion: 2,
      projectId: 'legacy-football',
      subtitlesPath: 'subtitles.srt',
    });
    expect(migrated.shots[0]).toMatchObject({
      schemaVersion: 2,
      durationFrames: 120,
      recipeId: 'editorial-pan',
    });
  });

  it('rejects a project produced by a newer incompatible schema', () => {
    expect(() => parseProjectDocument({schemaVersion: 3})).toThrow(UnsupportedSchemaVersionError);
    expect(() => parseProjectDocument({schemaVersion: 8})).toThrow(/supports up to v2/);
  });
});

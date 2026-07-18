import {describe, expect, it} from 'vitest';
import {
  DELIVERY_FPS,
  DELIVERY_HEIGHT,
  DELIVERY_WIDTH,
  generatedPerformanceShotToHybridMotionPlan,
  productionPlanSchema,
  productionShotToHybridMotionPlan,
  safePosixRelativePathSchema,
} from '../src/production/production-plan';
import {makeProductionPlan} from './production-fixture';

const ASSEMBLY_KINDS = [
  'slide-left',
  'slide-right',
  'slide-up',
  'drop',
  'rise',
  'snap',
  'slap',
  'stamp',
  'pop',
] as const;

const makeLayeredCollagePlan = (): Record<string, unknown> => {
  const raw = structuredClone(makeProductionPlan()) as unknown as Record<string, unknown>;
  raw.requiredCapabilities = ['local-f5-tts', 'remotion-render', 'ffmpeg', 'sidecar-srt'];
  raw.shots = [{
    kind: 'layered-collage',
    shotId: 'collage-01',
    deliveryTimeline: {startFrame: 0, durationFrames: 101},
    layers: [
      {
        id: 'background',
        assetPath: 'assets/shots/collage-01/background.png',
        role: 'background',
        zIndex: 0,
        transform: {x: 0, y: 0, scaleX: 1, scaleY: 1, rotationDegrees: 0, opacity: 1},
        motionPreset: 'locked',
      },
      {
        id: 'hero',
        assetPath: 'assets/shots/collage-01/hero.png',
        role: 'actor',
        zIndex: 10,
        transform: {x: 540, y: 1_080, scaleX: 1, scaleY: 1, rotationDegrees: 0, opacity: 1},
        motionPreset: 'locked',
        assembly: {
          kind: 'stamp',
          startFrame: 12,
          durationFrames: 24,
          distance: 320,
          rotationDegrees: -8,
          steps: 6,
        },
      },
    ],
    editorialCamera: {owner: 'editorial-camera', operation: 'push', strength: 0.08},
  }];
  const narration = raw.narration as Record<string, unknown>;
  const segments = narration.segments as Array<Record<string, unknown>>;
  segments[0]!.shotId = 'collage-01';
  return raw;
};

describe('canonical production project v3', () => {
  it('separates exact delivery geometry/timebase from native WanGP generation', () => {
    const plan = makeProductionPlan();

    expect(plan).toMatchObject({
      schemaVersion: 3,
      metadata: {title: '足球射门：方向与接触', locale: 'zh-CN'},
      networkPolicy: 'offline-only',
      delivery: {
        raster: {width: DELIVERY_WIDTH, height: DELIVERY_HEIGHT, pixelAspectRatio: 1},
        timeline: {fps: DELIVERY_FPS, durationFrames: 101},
        video: {path: expect.stringMatching(/\.mp4$/u)},
        audio: {path: expect.stringMatching(/\.wav$/u), sourceFormat: 'wav', muxCodec: 'aac'},
        subtitles: {path: expect.stringMatching(/\.srt$/u), burnIn: false},
        bgm: null,
      },
      narration: {engine: 'f5-tts-local'},
    });
    expect(plan.narration.mergedAudioPath).toBe(plan.delivery.audio.path);
    expect(plan.shots[0]).toMatchObject({
      kind: 'generated-performance',
      deliveryTimeline: {startFrame: 0, durationFrames: 101},
      generation: {
        engine: 'wangp-local-i2v',
        conditioning: {mode: 'start-only'},
        raster: {width: 480, height: 832},
        timeline: {fps: 24, frameCount: 81},
        conformToDelivery: {
          spatialFit: 'cover',
          focalPoint: {x: 0.5, y: 0.56},
          temporalFit: 'preserve-duration',
        },
        candidateSeeds: [42, 314159],
      },
      occlusion: {mode: 'local-matte', requirement: 'required'},
    });
  });

  it('converts delivery-time structured motion without giving the ball to I2V', () => {
    const production = makeProductionPlan();
    const shot = production.shots[0];
    if (shot?.kind !== 'generated-performance') throw new Error('fixture');

    const direct = generatedPerformanceShotToHybridMotionPlan(shot);
    const byId = productionShotToHybridMotionPlan(production, 'kick-01');

    expect(byId).toEqual(direct);
    expect(direct).toMatchObject({
      version: 1,
      durationFrames: 101,
      performance: {
        startKeyframePath: expect.stringContaining('performance-start'),
        generatedCamera: 'locked',
        excludedCausalPropIds: ['ball'],
      },
      interactions: [{
        propId: 'ball',
        triggerMilestoneId: 'foot-contact',
        evaluator: 'ballistic',
        renderSize: {width: 64, height: 64},
      }],
      camera: {owner: 'editorial-camera', operation: 'push'},
      world: {
        constraints: {
          facing: [{towardTargetId: 'goal'}],
          support: [{bodyPart: 'left-foot', mode: 'planted'}],
          contact: [{
            bodyPart: 'right-foot',
            target: {owner: 'deterministic-interaction', propId: 'ball'},
          }],
        },
      },
    });
    expect(direct.performance.endKeyframePath).toBeUndefined();
  });

  it('allows start/end only when the explicit runtime capability is declared', () => {
    const raw = structuredClone(makeProductionPlan()) as unknown as Record<string, unknown>;
    const shot = (raw.shots as Array<Record<string, unknown>>)[0]!;
    const generation = shot.generation as Record<string, unknown>;
    generation.conditioning = {
      mode: 'start-end',
      startKeyframePath: 'assets/shots/kick-01/performance-start.png',
      endKeyframePath: 'assets/shots/kick-01/performance-end.png',
    };

    expect(productionPlanSchema.safeParse(raw).success).toBe(false);
    const preset = generation.preset as Record<string, unknown>;
    preset.conditioning = 'start-end';
    expect(productionPlanSchema.safeParse(raw).success).toBe(false);
    (raw.requiredCapabilities as string[]).push('local-i2v-start-end');
    expect(productionPlanSchema.safeParse(raw).success).toBe(true);
  });

  it.each(ASSEMBLY_KINDS)('accepts %s deterministic collage assembly', (kind) => {
    const raw = makeLayeredCollagePlan();
    const shot = (raw.shots as Array<Record<string, unknown>>)[0]!;
    const layers = shot.layers as Array<Record<string, unknown>>;
    (layers[1]!.assembly as Record<string, unknown>).kind = kind;

    expect(productionPlanSchema.safeParse(raw).success).toBe(true);
  });

  it('preserves legacy layered-collage motion when assembly is omitted', () => {
    const raw = makeLayeredCollagePlan();
    const shot = (raw.shots as Array<Record<string, unknown>>)[0]!;
    const layers = shot.layers as Array<Record<string, unknown>>;
    delete layers[1]!.assembly;
    layers[1]!.motionPreset = 'paper-sway';

    expect(productionPlanSchema.safeParse(raw).success).toBe(true);
  });

  it.each([
    'bob',
    'sway',
    'gesture-left',
    'gesture-right',
    'exit-left',
    'exit-right',
  ] as const)('accepts a finite %s whole-card follow-through', (kind) => {
    const raw = makeLayeredCollagePlan();
    const shot = (raw.shots as Array<Record<string, unknown>>)[0]!;
    const layers = shot.layers as Array<Record<string, unknown>>;
    const assembly = layers[1]!.assembly as Record<string, unknown>;
    assembly.followThrough = {
      kind,
      delayFrames: 8,
      durationFrames: 30,
      distance: kind.startsWith('exit-') ? 1_200 : 36,
      rotationDegrees: kind.startsWith('exit-') ? 10 : 4,
      cadenceFps: 3,
    };

    expect(productionPlanSchema.safeParse(raw).success).toBe(true);
  });

  it('requires a finite paper follow-through to leave an exact final hold', () => {
    const raw = makeLayeredCollagePlan();
    const shot = (raw.shots as Array<Record<string, unknown>>)[0]!;
    const layers = shot.layers as Array<Record<string, unknown>>;
    const assembly = layers[1]!.assembly as Record<string, unknown>;
    assembly.followThrough = {
      kind: 'bob',
      delayFrames: 35,
      durationFrames: 25,
      distance: 24,
      rotationDegrees: 3,
      cadenceFps: 3,
    };

    const parsed = productionPlanSchema.safeParse(raw);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((issue) => issue.message)).toContain(
        'A paper follow-through must finish with at least six exact hold frames remaining.',
      );
    }
  });

  it.each([
    [{kind: 'bob', distance: 121, rotationDegrees: 4, cadenceFps: 3}, 'distance'],
    [{kind: 'sway', distance: 24, rotationDegrees: 9, cadenceFps: 3}, 'rotationDegrees'],
    [{kind: 'bob', distance: 24, rotationDegrees: 4, cadenceFps: 5}, 'cadenceFps'],
  ] as const)('rejects an unsafe non-rigid paper follow-through (%s)', (partial, _field) => {
    const raw = makeLayeredCollagePlan();
    const shot = (raw.shots as Array<Record<string, unknown>>)[0]!;
    const layers = shot.layers as Array<Record<string, unknown>>;
    const assembly = layers[1]!.assembly as Record<string, unknown>;
    assembly.followThrough = {
      delayFrames: 8,
      durationFrames: 30,
      ...partial,
    };

    expect(productionPlanSchema.safeParse(raw).success).toBe(false);
  });

  it('rejects assembly on a background layer', () => {
    const raw = makeLayeredCollagePlan();
    const shot = (raw.shots as Array<Record<string, unknown>>)[0]!;
    const layers = shot.layers as Array<Record<string, unknown>>;
    layers[0]!.assembly = structuredClone(layers[1]!.assembly);

    const parsed = productionPlanSchema.safeParse(raw);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((issue) => issue.message)).toContain(
        'Background layers cannot declare assembly motion.',
      );
    }
  });

  it('rejects assembly that finishes outside the shot-local timeline', () => {
    const raw = makeLayeredCollagePlan();
    const shot = (raw.shots as Array<Record<string, unknown>>)[0]!;
    const layers = shot.layers as Array<Record<string, unknown>>;
    const assembly = layers[1]!.assembly as Record<string, unknown>;
    assembly.startFrame = 90;
    assembly.durationFrames = 12;

    const parsed = productionPlanSchema.safeParse(raw);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((issue) => issue.message)).toContain(
        'Layer assembly must finish inside the shot-local delivery timeline.',
      );
    }
  });

  it('rejects assembly combined with a non-locked legacy motion preset', () => {
    const raw = makeLayeredCollagePlan();
    const shot = (raw.shots as Array<Record<string, unknown>>)[0]!;
    const layers = shot.layers as Array<Record<string, unknown>>;
    layers[1]!.motionPreset = 'paper-sway';

    const parsed = productionPlanSchema.safeParse(raw);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((issue) => issue.message)).toContain(
        'Layer assembly conflicts with a non-locked legacy motionPreset.',
      );
    }
  });

  it.each([
    ['durationFrames', 0],
    ['durationFrames', 3_601],
    ['distance', -1],
    ['distance', 4_001],
    ['rotationDegrees', -46],
    ['rotationDegrees', 46],
    ['steps', 1],
    ['steps', 25],
  ] as const)('rejects out-of-range collage assembly %s=%s', (field, value) => {
    const raw = makeLayeredCollagePlan();
    const shot = (raw.shots as Array<Record<string, unknown>>)[0]!;
    const layers = shot.layers as Array<Record<string, unknown>>;
    (layers[1]!.assembly as Record<string, unknown>)[field] = value;

    expect(productionPlanSchema.safeParse(raw).success).toBe(false);
  });

  it.each([
    '/absolute/file.png',
    'C:/drive/file.png',
    '../escape.png',
    'assets/../escape.png',
    'assets\\windows.png',
    'assets//empty.png',
    './assets/file.png',
    'assets/video.mp4:payload',
    'assets/NUL.png',
    'assets/trailing./file.png',
  ])('rejects an unsafe or non-POSIX path: %s', (unsafePath) => {
    expect(safePosixRelativePathSchema.safeParse(unsafePath).success).toBe(false);
  });

  it.each([
    ['duplicate candidate seeds', (raw: Record<string, unknown>) => {
      const shot = (raw.shots as Array<Record<string, unknown>>)[0]!;
      (shot.generation as Record<string, unknown>).candidateSeeds = [42, 42];
    }],
    ['mismatched native/delivery duration', (raw: Record<string, unknown>) => {
      const shot = (raw.shots as Array<Record<string, unknown>>)[0]!;
      const generation = shot.generation as Record<string, unknown>;
      (generation.timeline as Record<string, unknown>).frameCount = 70;
    }],
    ['a gap in delivery timeline', (raw: Record<string, unknown>) => {
      const shot = (raw.shots as Array<Record<string, unknown>>)[0]!;
      (shot.deliveryTimeline as Record<string, unknown>).startFrame = 1;
    }],
    ['out-of-order milestones', (raw: Record<string, unknown>) => {
      const shot = (raw.shots as Array<Record<string, unknown>>)[0]!;
      const hybrid = shot.hybridMotion as Record<string, unknown>;
      const world = hybrid.world as Record<string, unknown>;
      const milestones = world.milestones as Array<Record<string, unknown>>;
      milestones[3]!.frame = 49;
    }],
    ['missing trigger milestone', (raw: Record<string, unknown>) => {
      const shot = (raw.shots as Array<Record<string, unknown>>)[0]!;
      const hybrid = shot.hybridMotion as Record<string, unknown>;
      const props = hybrid.deterministicProps as Array<Record<string, unknown>>;
      (props[0]!.trigger as Record<string, unknown>).milestoneId = 'missing';
    }],
    ['contact frame mismatch', (raw: Record<string, unknown>) => {
      const shot = (raw.shots as Array<Record<string, unknown>>)[0]!;
      const hybrid = shot.hybridMotion as Record<string, unknown>;
      const props = hybrid.deterministicProps as Array<Record<string, unknown>>;
      (props[0]!.motion as Record<string, unknown>).contactFrame = 51;
    }],
    ['ballistic flight overrun', (raw: Record<string, unknown>) => {
      const shot = (raw.shots as Array<Record<string, unknown>>)[0]!;
      const hybrid = shot.hybridMotion as Record<string, unknown>;
      const props = hybrid.deterministicProps as Array<Record<string, unknown>>;
      (props[0]!.motion as Record<string, unknown>).flightFrames = 51;
    }],
    ['causal prop not excluded', (raw: Record<string, unknown>) => {
      const shot = (raw.shots as Array<Record<string, unknown>>)[0]!;
      const hybrid = shot.hybridMotion as Record<string, unknown>;
      (hybrid.actor as Record<string, unknown>).excludedCausalPropIds = [];
    }],
    ['unsafe nested asset path', (raw: Record<string, unknown>) => {
      const shot = (raw.shots as Array<Record<string, unknown>>)[0]!;
      const hybrid = shot.hybridMotion as Record<string, unknown>;
      const props = hybrid.deterministicProps as Array<Record<string, unknown>>;
      props[0]!.assetPath = '../ball.png';
    }],
    ['facing the wrong target', (raw: Record<string, unknown>) => {
      const shot = (raw.shots as Array<Record<string, unknown>>)[0]!;
      const hybrid = shot.hybridMotion as Record<string, unknown>;
      const world = hybrid.world as Record<string, unknown>;
      const constraints = world.constraints as Record<string, unknown>;
      const facing = constraints.facing as Array<Record<string, unknown>>;
      facing[0]!.towardTargetId = 'crowd';
    }],
    ['support interval running backwards', (raw: Record<string, unknown>) => {
      const shot = (raw.shots as Array<Record<string, unknown>>)[0]!;
      const hybrid = shot.hybridMotion as Record<string, unknown>;
      const world = hybrid.world as Record<string, unknown>;
      const constraints = world.constraints as Record<string, unknown>;
      const support = constraints.support as Array<Record<string, unknown>>;
      support[0]!.fromMilestoneId = 'follow';
    }],
    ['contact with an unowned deterministic prop', (raw: Record<string, unknown>) => {
      const shot = (raw.shots as Array<Record<string, unknown>>)[0]!;
      const hybrid = shot.hybridMotion as Record<string, unknown>;
      const world = hybrid.world as Record<string, unknown>;
      const constraints = world.constraints as Record<string, unknown>;
      const contact = constraints.contact as Array<Record<string, unknown>>;
      (contact[0]!.target as Record<string, unknown>).propId = 'imaginary-ball';
    }],
    ['deterministic contact trigger mismatch', (raw: Record<string, unknown>) => {
      const shot = (raw.shots as Array<Record<string, unknown>>)[0]!;
      const hybrid = shot.hybridMotion as Record<string, unknown>;
      const world = hybrid.world as Record<string, unknown>;
      const constraints = world.constraints as Record<string, unknown>;
      const contact = constraints.contact as Array<Record<string, unknown>>;
      contact[0]!.milestoneId = 'follow';
    }],
    ['duplicate deterministic contact owner', (raw: Record<string, unknown>) => {
      const shot = (raw.shots as Array<Record<string, unknown>>)[0]!;
      const hybrid = shot.hybridMotion as Record<string, unknown>;
      const world = hybrid.world as Record<string, unknown>;
      const constraints = world.constraints as Record<string, unknown>;
      const contact = constraints.contact as Array<Record<string, unknown>>;
      const duplicate = structuredClone(contact[0]!);
      duplicate.id = 'duplicate-ball-owner';
      contact.push(duplicate);
    }],
    ['generated-world contact with an undeclared object', (raw: Record<string, unknown>) => {
      const shot = (raw.shots as Array<Record<string, unknown>>)[0]!;
      const hybrid = shot.hybridMotion as Record<string, unknown>;
      const world = hybrid.world as Record<string, unknown>;
      const constraints = world.constraints as Record<string, unknown>;
      const contact = constraints.contact as Array<Record<string, unknown>>;
      contact.push({
        id: 'touch-phantom',
        actorId: 'kicker',
        bodyPart: 'left-hand',
        target: {owner: 'generated-world', objectId: 'phantom'},
        milestoneId: 'foot-contact',
        kind: 'touch',
        toleranceFrames: 1,
      });
    }],
    ['duplicate generated-world object declarations', (raw: Record<string, unknown>) => {
      const shot = (raw.shots as Array<Record<string, unknown>>)[0]!;
      const hybrid = shot.hybridMotion as Record<string, unknown>;
      const world = hybrid.world as Record<string, unknown>;
      world.generatedObjectIds = ['goal-net', 'goal-net'];
    }],
    ['matting the wrong subject', (raw: Record<string, unknown>) => {
      const shot = (raw.shots as Array<Record<string, unknown>>)[0]!;
      (shot.occlusion as Record<string, unknown>).subjectId = 'goalkeeper';
    }],
    ['narration path diverges from delivery audio', (raw: Record<string, unknown>) => {
      const narration = raw.narration as Record<string, unknown>;
      narration.mergedAudioPath = 'generated/audio/other.m4a';
    }],
    ['invalid project locale', (raw: Record<string, unknown>) => {
      (raw.metadata as Record<string, unknown>).locale = 'not a locale';
    }],
  ] as const)('rejects %s', (_label, mutate) => {
    const raw = structuredClone(makeProductionPlan()) as unknown as Record<string, unknown>;
    mutate(raw);

    expect(productionPlanSchema.safeParse(raw).success).toBe(false);
  });

  it('requires unique shots and all local capabilities implied by the contract', () => {
    const raw = structuredClone(makeProductionPlan());
    raw.shots.push(structuredClone(raw.shots[0]!));
    raw.requiredCapabilities = raw.requiredCapabilities.filter((capability) => capability !== 'local-video-matting');

    const parsed = productionPlanSchema.safeParse(raw);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((issue) => issue.message).join('\n')).toMatch(/Duplicate shot ID/);
      expect(parsed.error.issues.map((issue) => issue.message).join('\n')).toMatch(/local-video-matting/);
    }
  });

  it('accepts generated-world contact with the declared target or object inventory', () => {
    const targetContact = structuredClone(makeProductionPlan()) as unknown as Record<string, unknown>;
    const targetShot = (targetContact.shots as Array<Record<string, unknown>>)[0]!;
    const targetWorld = (targetShot.hybridMotion as Record<string, unknown>).world as Record<string, unknown>;
    const targetConstraints = targetWorld.constraints as Record<string, unknown>;
    (targetConstraints.contact as Array<Record<string, unknown>>).push({
      id: 'left-hand-goal-touch',
      actorId: 'kicker',
      bodyPart: 'left-hand',
      target: {owner: 'generated-world', objectId: 'goal'},
      milestoneId: 'foot-contact',
      kind: 'touch',
      toleranceFrames: 1,
    });
    expect(productionPlanSchema.safeParse(targetContact).success).toBe(true);

    targetWorld.generatedObjectIds = ['goal-net'];
    const contacts = targetConstraints.contact as Array<Record<string, unknown>>;
    contacts[1]!.target = {owner: 'generated-world', objectId: 'goal-net'};
    expect(productionPlanSchema.safeParse(targetContact).success).toBe(true);
  });
});

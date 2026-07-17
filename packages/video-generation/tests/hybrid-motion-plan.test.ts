import {describe, expect, it} from 'vitest';
import {
  buildTemporalQaSamples,
  compilePerformanceGenerationInput,
  validateHybridMotionPlan,
  type HybridMotionPlan,
} from '../src/orchestration/hybrid-motion-plan';

const makePlan = (): HybridMotionPlan => ({
  version: 1,
  shotId: 'kick-01',
  durationFrames: 81,
  performance: {
    owner: 'generated-performance',
    startKeyframePath: 'performance-start.png',
    endKeyframePath: 'performance-end.png',
    actorIds: ['kicker', 'goalkeeper'],
    characterAction: 'one right-foot instep strike and follow-through',
    motionPrompt: 'Locked camera. The kicker plants the left foot, swings the right leg and follows through.',
    negativePrompt: 'ball, camera movement, extra limbs, sliding feet',
    generatedCamera: 'locked',
    excludedCausalPropIds: ['ball'],
  },
  interactions: [{
    owner: 'deterministic-interaction',
    propId: 'ball',
    triggerMilestoneId: 'foot-contact',
    evaluator: 'ballistic',
    renderSize: {width: 64, height: 64},
  }],
  camera: {owner: 'editorial-camera', operation: 'push', strength: 0.18},
  world: {
    subjectId: 'kicker',
    targetId: 'goal',
    generatedObjectIds: [],
    supportSurfaceId: 'pitch',
    actionAxis: {from: {x: 0.48, y: 0.82}, to: {x: 0.51, y: 0.2}},
    milestones: [
      {id: 'setup', kind: 'setup', frame: 0},
      {id: 'plant', kind: 'plant', frame: 27},
      {id: 'foot-contact', kind: 'contact', frame: 40},
      {id: 'follow', kind: 'follow-through', frame: 57},
      {id: 'end', kind: 'end', frame: 80},
    ],
    constraints: {
      facing: [{
        id: 'face-goal',
        actorId: 'kicker',
        towardTargetId: 'goal',
        bodyAxis: 'torso',
        fromMilestoneId: 'setup',
        throughMilestoneId: 'follow',
        maxDeviationDegrees: 28,
      }],
      support: [{
        id: 'plant-left-foot',
        actorId: 'kicker',
        bodyPart: 'left-foot',
        surfaceId: 'pitch',
        mode: 'planted',
        fromMilestoneId: 'plant',
        throughMilestoneId: 'foot-contact',
        maxSlipPixels: 10,
      }],
      contact: [{
        id: 'right-foot-ball-contact',
        actorId: 'kicker',
        bodyPart: 'right-foot',
        target: {owner: 'deterministic-interaction', propId: 'ball'},
        milestoneId: 'foot-contact',
        kind: 'strike',
        toleranceFrames: 1,
      }],
    },
  },
});

describe('hybrid motion ownership plan', () => {
  it('compiles only the complete performance plate into provider input', () => {
    const input = compilePerformanceGenerationInput(makePlan(), {
      projectId: 'demo',
      shotId: 'kick-01',
      width: 480,
      height: 832,
      fps: 24,
      frameCount: 81,
      motionStrength: 0.8,
      presetId: 'local-i2v-fast-portrait',
    });

    expect(input).toMatchObject({
      keyframePath: 'performance-start.png',
      endKeyframePath: 'performance-end.png',
      prompt: expect.stringContaining('plants the left foot'),
      negativePrompt: expect.stringContaining('ball'),
    });
    expect(input.prompt).not.toContain('ball shoots');
  });

  it('rejects generated causal props and non-contact deterministic triggers', () => {
    const plan = makePlan();
    plan.performance.excludedCausalPropIds = [];
    plan.interactions[0] = {...plan.interactions[0]!, triggerMilestoneId: 'plant'};
    const issues = validateHybridMotionPlan(plan);

    expect(issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'PROP_NOT_EXCLUDED',
      'INVALID_TRIGGER',
    ]));
  });

  it('samples the whole shot and contact-adjacent frames for temporal QA', () => {
    const samples = buildTemporalQaSamples(makePlan());
    const frames = samples.map((sample) => sample.frame);

    expect(frames).toEqual([...frames].sort((a, b) => a - b));
    expect(frames).toEqual(expect.arrayContaining([38, 39, 40, 41, 42]));
    expect(samples.filter((sample) => sample.reasons.includes('uniform')).length).toBe(12);
    expect(samples.find((sample) => sample.frame === 39)?.reasons).toContain('contact-adjacent');
  });

  it('accepts declared generated-world contact and rejects undeclared objects', () => {
    const plan = makePlan();
    plan.world.generatedObjectIds = ['goal-net'];
    plan.world.constraints.contact.push({
      id: 'left-hand-net-touch',
      actorId: 'kicker',
      bodyPart: 'left-hand',
      target: {owner: 'generated-world', objectId: 'goal-net'},
      milestoneId: 'foot-contact',
      kind: 'touch',
      toleranceFrames: 1,
    });
    expect(validateHybridMotionPlan(plan)).toEqual([]);

    plan.world.constraints.contact[1]!.target = {owner: 'generated-world', objectId: 'crowd'};
    expect(validateHybridMotionPlan(plan).map((issue) => issue.code)).toContain('INVALID_CONSTRAINT');
  });
});

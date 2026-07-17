import type {VideoGenerationInput} from '../providers/provider.js';

export type NormalizedPoint = {x: number; y: number};

export type InteractionMilestoneKind =
  | 'setup'
  | 'anticipation'
  | 'approach'
  | 'plant'
  | 'contact'
  | 'release'
  | 'follow-through'
  | 'settle'
  | 'end';

export type InteractionMilestone = {
  id: string;
  kind: InteractionMilestoneKind;
  frame: number;
};

export type PerformancePlanePlan = {
  owner: 'generated-performance';
  /** Complete human/animal performance plate. It must not contain causal props listed below. */
  startKeyframePath: string;
  /** Optional final full-body pose used by start/end capable providers. */
  endKeyframePath?: string;
  actorIds: string[];
  characterAction: string;
  motionPrompt: string;
  negativePrompt?: string;
  generatedCamera: 'locked';
  excludedCausalPropIds: string[];
};

export type DeterministicInteractionPlan = {
  owner: 'deterministic-interaction';
  propId: string;
  /** Contact/release milestone that unlocks the deterministic evaluator. */
  triggerMilestoneId: string;
  evaluator: 'ballistic' | 'keyframed' | 'mask-reveal';
  /** Intrinsic delivery-pixel dimensions before editorial transforms. */
  renderSize: {width: number; height: number};
};

export type EditorialCameraPlan = {
  owner: 'editorial-camera';
  operation: 'locked' | 'push' | 'pull' | 'pan-left' | 'pan-right' | 'pan-up' | 'pan-down';
  /** Normalized editorial strength. Locked cameras must use 0. */
  strength: number;
};

export type FacingConstraint = {
  id: string;
  actorId: string;
  towardTargetId: string;
  bodyAxis: 'head' | 'torso' | 'hips' | 'travel';
  fromMilestoneId: string;
  throughMilestoneId: string;
  maxDeviationDegrees: number;
};

export type SupportConstraint = {
  id: string;
  actorId: string;
  bodyPart:
    | 'head'
    | 'torso'
    | 'hips'
    | 'left-hand'
    | 'right-hand'
    | 'left-foot'
    | 'right-foot'
    | 'left-knee'
    | 'right-knee'
    | 'left-elbow'
    | 'right-elbow';
  surfaceId: string;
  mode: 'planted' | 'supported' | 'sliding-allowed';
  fromMilestoneId: string;
  throughMilestoneId: string;
  maxSlipPixels: number;
};

export type ContactTarget =
  | {owner: 'deterministic-interaction'; propId: string}
  | {owner: 'generated-world'; objectId: string};

export type ContactConstraint = {
  id: string;
  actorId: string;
  bodyPart: SupportConstraint['bodyPart'];
  target: ContactTarget;
  milestoneId: string;
  kind: 'strike' | 'touch' | 'grasp' | 'release';
  toleranceFrames: number;
};

export type StructuredWorldConstraints = {
  facing: FacingConstraint[];
  support: SupportConstraint[];
  contact: ContactConstraint[];
};

export type WorldInteractionContract = {
  subjectId: string;
  targetId?: string;
  /** Generated plate objects, other than targetId, eligible for structured contact. */
  generatedObjectIds: string[];
  supportSurfaceId: string;
  /** Normalized screen-space action axis from the subject toward the target. */
  actionAxis: {from: NormalizedPoint; to: NormalizedPoint};
  milestones: InteractionMilestone[];
  /** Machine-checkable real-world orientation, support and contact rules. */
  constraints: StructuredWorldConstraints;
};

/**
 * Shot-level ownership contract for the next generation architecture.
 *
 * Natural body deformation belongs to the generated performance plane. Props,
 * collisions, masks and debris belong to frame-exact evaluators. Camera motion
 * has one owner only, so generation and editorial transforms cannot drift.
 */
export type HybridMotionPlan = {
  version: 1;
  shotId: string;
  durationFrames: number;
  performance: PerformancePlanePlan;
  interactions: DeterministicInteractionPlan[];
  camera: EditorialCameraPlan;
  world: WorldInteractionContract;
};

export type HybridMotionPlanIssue = {
  code:
    | 'INVALID_DURATION'
    | 'EMPTY_ID'
    | 'EMPTY_ACTION'
    | 'EMPTY_ACTORS'
    | 'SUBJECT_NOT_IN_PERFORMANCE'
    | 'INVALID_AXIS'
    | 'INVALID_CAMERA'
    | 'INVALID_MILESTONE'
    | 'MILESTONE_ORDER'
    | 'DUPLICATE_MILESTONE'
    | 'INVALID_WORLD_OBJECT'
    | 'DUPLICATE_WORLD_OBJECT'
    | 'DUPLICATE_PROP'
    | 'MISSING_TRIGGER'
    | 'INVALID_TRIGGER'
    | 'PROP_NOT_EXCLUDED'
    | 'INVALID_RENDER_SIZE'
    | 'INVALID_CONSTRAINT'
    | 'DUPLICATE_CONSTRAINT';
  path: string;
  message: string;
};

export class HybridMotionPlanError extends Error {
  readonly issues: readonly HybridMotionPlanIssue[];

  constructor(issues: readonly HybridMotionPlanIssue[]) {
    super(`HYBRID_MOTION_PLAN_INVALID:${issues.map((issue) => issue.code).join(',')}`);
    this.name = 'HybridMotionPlanError';
    this.issues = issues;
  }
}

const isNonEmpty = (value: string): boolean => value.trim().length > 0;
const isFrame = (value: number, durationFrames: number): boolean =>
  Number.isInteger(value) && value >= 0 && value < durationFrames;
const isNormalizedPoint = (point: NormalizedPoint): boolean =>
  Number.isFinite(point.x)
  && Number.isFinite(point.y)
  && point.x >= 0
  && point.x <= 1
  && point.y >= 0
  && point.y <= 1;

export const validateHybridMotionPlan = (plan: HybridMotionPlan): HybridMotionPlanIssue[] => {
  const issues: HybridMotionPlanIssue[] = [];
  const add = (
    code: HybridMotionPlanIssue['code'],
    path: string,
    message: string,
  ): void => { issues.push({code, path, message}); };

  if (!Number.isInteger(plan.durationFrames) || plan.durationFrames <= 0) {
    add('INVALID_DURATION', 'durationFrames', 'durationFrames must be a positive integer.');
  }
  if (!isNonEmpty(plan.shotId) || !isNonEmpty(plan.world.subjectId) || !isNonEmpty(plan.world.supportSurfaceId)) {
    add('EMPTY_ID', 'shotId/world', 'Shot, subject and support-surface IDs are required.');
  }
  if (plan.performance.actorIds.length === 0) {
    add('EMPTY_ACTORS', 'performance.actorIds', 'At least one complete performance actor is required.');
  }
  if (!plan.performance.actorIds.includes(plan.world.subjectId)) {
    add(
      'SUBJECT_NOT_IN_PERFORMANCE',
      'world.subjectId',
      'The world-interaction subject must be present in the generated performance plane.',
    );
  }
  if (!isNonEmpty(plan.performance.characterAction) || !isNonEmpty(plan.performance.motionPrompt)) {
    add('EMPTY_ACTION', 'performance', 'A single character action and motion prompt are required.');
  }
  const {from, to} = plan.world.actionAxis;
  if (
    !isNormalizedPoint(from)
    || !isNormalizedPoint(to)
    || Math.hypot(to.x - from.x, to.y - from.y) < 0.01
  ) {
    add('INVALID_AXIS', 'world.actionAxis', 'The action axis must be a non-zero normalized vector.');
  }
  if (
    !Number.isFinite(plan.camera.strength)
    || plan.camera.strength < 0
    || plan.camera.strength > 1
    || (plan.camera.operation === 'locked' && plan.camera.strength !== 0)
    || (plan.camera.operation !== 'locked' && plan.camera.strength === 0)
  ) {
    add(
      'INVALID_CAMERA',
      'camera',
      'Camera strength must be 0 when locked and between 0 and 1 for one editorial move.',
    );
  }
  const milestones = new Map<string, InteractionMilestone>();
  let previousFrame = -1;
  for (const [index, milestone] of plan.world.milestones.entries()) {
    const milestonePath = `world.milestones.${index}`;
    if (!isNonEmpty(milestone.id) || !isFrame(milestone.frame, plan.durationFrames)) {
      add('INVALID_MILESTONE', milestonePath, 'Milestone IDs and in-shot frames are required.');
    }
    if (milestones.has(milestone.id)) {
      add('DUPLICATE_MILESTONE', `${milestonePath}.id`, `Duplicate milestone: ${milestone.id}`);
    }
    if (milestone.frame < previousFrame) {
      add('MILESTONE_ORDER', `${milestonePath}.frame`, 'Milestones must be ordered by frame.');
    }
    milestones.set(milestone.id, milestone);
    previousFrame = milestone.frame;
  }

  const propIds = new Set<string>();
  const propTriggerMilestoneById = new Map<string, string>();
  const excludedPropIds = new Set(plan.performance.excludedCausalPropIds);
  for (const [index, interaction] of plan.interactions.entries()) {
    const interactionPath = `interactions.${index}`;
    if (!isNonEmpty(interaction.propId)) {
      add('EMPTY_ID', `${interactionPath}.propId`, 'A deterministic prop ID is required.');
    }
    if (propIds.has(interaction.propId)) {
      add('DUPLICATE_PROP', `${interactionPath}.propId`, `Duplicate deterministic prop: ${interaction.propId}`);
    }
    propIds.add(interaction.propId);
    propTriggerMilestoneById.set(interaction.propId, interaction.triggerMilestoneId);
    if (
      !Number.isFinite(interaction.renderSize.width)
      || interaction.renderSize.width <= 0
      || !Number.isFinite(interaction.renderSize.height)
      || interaction.renderSize.height <= 0
    ) {
      add(
        'INVALID_RENDER_SIZE',
        `${interactionPath}.renderSize`,
        'Deterministic props require a positive intrinsic delivery-pixel render size.',
      );
    }
    if (!excludedPropIds.has(interaction.propId)) {
      add(
        'PROP_NOT_EXCLUDED',
        `${interactionPath}.propId`,
        'A deterministic causal prop must be absent from the generated performance plate.',
      );
    }
    const trigger = milestones.get(interaction.triggerMilestoneId);
    if (trigger === undefined) {
      add('MISSING_TRIGGER', `${interactionPath}.triggerMilestoneId`, 'The trigger milestone does not exist.');
    } else if (trigger.kind !== 'contact' && trigger.kind !== 'release') {
      add(
        'INVALID_TRIGGER',
        `${interactionPath}.triggerMilestoneId`,
        'Deterministic motion may unlock only on a contact or release milestone.',
      );
    }
  }

  const actorIds = new Set(plan.performance.actorIds);
  const generatedObjectIds = new Set<string>();
  for (const [index, objectId] of plan.world.generatedObjectIds.entries()) {
    if (!isNonEmpty(objectId)) {
      add('INVALID_WORLD_OBJECT', `world.generatedObjectIds.${index}`, 'Generated-world object ID is required.');
    }
    if (generatedObjectIds.has(objectId)) {
      add('DUPLICATE_WORLD_OBJECT', `world.generatedObjectIds.${index}`, `Duplicate generated-world object: ${objectId}`);
    }
    generatedObjectIds.add(objectId);
  }
  const constraintIds = new Set<string>();
  const rememberConstraint = (id: string, path: string): void => {
    if (!isNonEmpty(id)) add('INVALID_CONSTRAINT', `${path}.id`, 'Constraint ID is required.');
    if (constraintIds.has(id)) add('DUPLICATE_CONSTRAINT', `${path}.id`, `Duplicate constraint: ${id}`);
    constraintIds.add(id);
  };
  const validateInterval = (from: string, through: string, path: string): void => {
    const fromMilestone = milestones.get(from);
    const throughMilestone = milestones.get(through);
    if (fromMilestone === undefined || throughMilestone === undefined || throughMilestone.frame < fromMilestone.frame) {
      add('INVALID_CONSTRAINT', path, 'Constraint milestone interval must exist and run forward in delivery time.');
    }
  };
  if (plan.world.constraints.facing.length === 0) {
    add('INVALID_CONSTRAINT', 'world.constraints.facing', 'At least one structured facing constraint is required.');
  }
  if (plan.world.constraints.support.length === 0) {
    add('INVALID_CONSTRAINT', 'world.constraints.support', 'At least one structured support constraint is required.');
  }
  for (const [index, constraint] of plan.world.constraints.facing.entries()) {
    const constraintPath = `world.constraints.facing.${index}`;
    rememberConstraint(constraint.id, constraintPath);
    validateInterval(constraint.fromMilestoneId, constraint.throughMilestoneId, constraintPath);
    if (
      !actorIds.has(constraint.actorId)
      || constraint.towardTargetId !== plan.world.targetId
      || !Number.isFinite(constraint.maxDeviationDegrees)
      || constraint.maxDeviationDegrees <= 0
      || constraint.maxDeviationDegrees > 90
    ) {
      add('INVALID_CONSTRAINT', constraintPath, 'Facing constraint must bind an actor to the declared target with a valid tolerance.');
    }
  }
  for (const [index, constraint] of plan.world.constraints.support.entries()) {
    const constraintPath = `world.constraints.support.${index}`;
    rememberConstraint(constraint.id, constraintPath);
    validateInterval(constraint.fromMilestoneId, constraint.throughMilestoneId, constraintPath);
    if (
      !actorIds.has(constraint.actorId)
      || constraint.surfaceId !== plan.world.supportSurfaceId
      || !Number.isFinite(constraint.maxSlipPixels)
      || constraint.maxSlipPixels < 0
    ) {
      add('INVALID_CONSTRAINT', constraintPath, 'Support constraint must bind an actor to the declared support surface.');
    }
  }
  for (const [index, constraint] of plan.world.constraints.contact.entries()) {
    const constraintPath = `world.constraints.contact.${index}`;
    rememberConstraint(constraint.id, constraintPath);
    const milestone = milestones.get(constraint.milestoneId);
    const expectedMilestoneKind = constraint.kind === 'release' ? 'release' : 'contact';
    const targetIsValid = constraint.target.owner === 'deterministic-interaction'
      ? propIds.has(constraint.target.propId)
        && propTriggerMilestoneById.get(constraint.target.propId) === constraint.milestoneId
      : constraint.target.objectId === plan.world.targetId
        || generatedObjectIds.has(constraint.target.objectId);
    if (
      !actorIds.has(constraint.actorId)
      || !targetIsValid
      || milestone?.kind !== expectedMilestoneKind
      || !Number.isInteger(constraint.toleranceFrames)
      || constraint.toleranceFrames < 0
      || constraint.toleranceFrames > 3
    ) {
      add('INVALID_CONSTRAINT', constraintPath, 'Contact must bind an actor to an owned deterministic prop or declared generated-world object at a matching milestone.');
    }
  }
  for (const propId of propIds) {
    const contacts = plan.world.constraints.contact.filter(
      (constraint) => constraint.target.owner === 'deterministic-interaction' && constraint.target.propId === propId,
    );
    if (contacts.length !== 1) {
      add(
        'INVALID_CONSTRAINT',
        'world.constraints.contact',
        `Deterministic prop requires exactly one owned, trigger-matched contact constraint: ${propId}`,
      );
    }
  }

  return issues;
};

export const assertHybridMotionPlan = (plan: HybridMotionPlan): void => {
  const issues = validateHybridMotionPlan(plan);
  if (issues.length > 0) throw new HybridMotionPlanError(issues);
};

export type PerformanceGenerationRequest = Omit<
  VideoGenerationInput,
  'keyframePath' | 'endKeyframePath' | 'prompt' | 'negativePrompt'
>;

/** Compile only the generated-performance plane into a provider request. */
export const compilePerformanceGenerationInput = (
  plan: HybridMotionPlan,
  request: PerformanceGenerationRequest,
): VideoGenerationInput => {
  assertHybridMotionPlan(plan);
  return {
    ...request,
    keyframePath: plan.performance.startKeyframePath,
    ...(plan.performance.endKeyframePath === undefined
      ? {}
      : {endKeyframePath: plan.performance.endKeyframePath}),
    prompt: plan.performance.motionPrompt,
    ...(plan.performance.negativePrompt === undefined
      ? {}
      : {negativePrompt: plan.performance.negativePrompt}),
  };
};

export type TemporalQaSample = {
  frame: number;
  reasons: Array<'uniform' | 'milestone' | 'contact-adjacent'>;
};

/**
 * Twelve whole-shot samples plus milestone/contact-neighbour frames. These are
 * review targets, not a claim that anatomy or physical correctness is solved by
 * pixel heuristics.
 */
export const buildTemporalQaSamples = (
  plan: HybridMotionPlan,
  uniformSampleCount = 12,
  contactRadiusFrames = 2,
): TemporalQaSample[] => {
  assertHybridMotionPlan(plan);
  if (!Number.isInteger(uniformSampleCount) || uniformSampleCount < 1) {
    throw new Error('TEMPORAL_QA_SAMPLE_COUNT_INVALID');
  }
  if (!Number.isInteger(contactRadiusFrames) || contactRadiusFrames < 0) {
    throw new Error('TEMPORAL_QA_CONTACT_RADIUS_INVALID');
  }
  const samples = new Map<number, Set<TemporalQaSample['reasons'][number]>>();
  const add = (frame: number, reason: TemporalQaSample['reasons'][number]): void => {
    if (frame < 0 || frame >= plan.durationFrames) return;
    const reasons = samples.get(frame) ?? new Set<TemporalQaSample['reasons'][number]>();
    reasons.add(reason);
    samples.set(frame, reasons);
  };
  for (let index = 0; index < uniformSampleCount; index += 1) {
    add(Math.min(
      plan.durationFrames - 1,
      Math.floor(plan.durationFrames * ((index + 0.5) / uniformSampleCount)),
    ), 'uniform');
  }
  for (const milestone of plan.world.milestones) {
    add(milestone.frame, 'milestone');
    if (milestone.kind === 'contact' || milestone.kind === 'release') {
      for (let offset = -contactRadiusFrames; offset <= contactRadiusFrames; offset += 1) {
        add(milestone.frame + offset, offset === 0 ? 'milestone' : 'contact-adjacent');
      }
    }
  }
  return [...samples.entries()]
    .sort(([a], [b]) => a - b)
    .map(([frame, reasons]) => ({frame, reasons: [...reasons]}));
};

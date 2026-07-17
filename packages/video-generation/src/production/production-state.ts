import {z} from 'zod';
import {
  PRODUCTION_PLAN_SCHEMA_VERSION,
  parseProductionPlan,
  productionIdSchema,
  safePosixRelativePathSchema,
  type ProductionPlan,
} from './production-plan.js';

const instantSchema = z.string().datetime({offset: true});
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u, 'Expected a lowercase SHA-256 digest.');

export const candidateTechnicalQaSchema = z.object({
  result: z.enum(['pass', 'fail']),
  checkedAt: instantSchema,
  probe: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().finite().positive(),
    frameCount: z.number().int().positive(),
    codec: z.string().min(1).max(64),
    pixelFormat: z.string().min(1).max(64),
    hasAudio: z.boolean(),
  }).strict(),
  issues: z.array(z.string().min(1).max(1_000)),
}).strict().superRefine((qa, context) => {
  if (qa.result === 'pass' && qa.issues.length > 0) {
    context.addIssue({code: 'custom', path: ['issues'], message: 'Passing technical QA cannot retain issues.'});
  }
  if (qa.result === 'fail' && qa.issues.length === 0) {
    context.addIssue({code: 'custom', path: ['issues'], message: 'Failed technical QA must explain at least one issue.'});
  }
});
export type CandidateTechnicalQa = z.infer<typeof candidateTechnicalQaSchema>;

export const candidateMatteStateSchema = z.object({
  status: z.enum(['not-required', 'queued', 'generating', 'complete', 'failed', 'interrupted']),
  startedAt: instantSchema.optional(),
  finishedAt: instantSchema.optional(),
  interruptedAt: instantSchema.optional(),
  relativePath: safePosixRelativePathSchema.optional(),
  sha256: sha256Schema.optional(),
  technicalQa: candidateTechnicalQaSchema.optional(),
  error: z.string().min(1).max(4_000).optional(),
}).strict().superRefine((matte, context) => {
  if (matte.status === 'generating' && matte.startedAt === undefined) {
    context.addIssue({code: 'custom', path: ['startedAt'], message: 'A generating matte requires startedAt.'});
  }
  if (matte.status === 'complete') {
    if (
      matte.finishedAt === undefined
      || matte.relativePath === undefined
      || matte.sha256 === undefined
      || matte.technicalQa === undefined
    ) {
      context.addIssue({code: 'custom', message: 'A complete matte requires output path, digest, finish time, and technical QA.'});
    }
  }
  if (matte.status === 'failed' && matte.error === undefined) {
    context.addIssue({code: 'custom', path: ['error'], message: 'A failed matte requires an error message.'});
  }
  if (matte.status === 'interrupted' && matte.interruptedAt === undefined) {
    context.addIssue({code: 'custom', path: ['interruptedAt'], message: 'An interrupted matte requires interruptedAt.'});
  }
});
export type CandidateMatteState = z.infer<typeof candidateMatteStateSchema>;

export const candidateHumanDecisionSchema = z.object({
  decision: z.enum(['accept', 'reject']),
  reviewedAt: instantSchema,
  notes: z.string().max(4_000).optional(),
}).strict();
export type CandidateHumanDecision = z.infer<typeof candidateHumanDecisionSchema>;

export const productionCandidateStateSchema = z.object({
  candidateId: productionIdSchema,
  seed: z.number().int().nonnegative().max(2_147_483_647),
  status: z.enum(['queued', 'generating', 'complete', 'failed', 'interrupted']),
  startedAt: instantSchema.optional(),
  finishedAt: instantSchema.optional(),
  interruptedAt: instantSchema.optional(),
  relativePath: safePosixRelativePathSchema.optional(),
  sha256: sha256Schema.optional(),
  technicalQa: candidateTechnicalQaSchema.optional(),
  matte: candidateMatteStateSchema,
  humanDecision: candidateHumanDecisionSchema.optional(),
  error: z.string().min(1).max(4_000).optional(),
}).strict().superRefine((candidate, context) => {
  if (candidate.status === 'generating' && candidate.startedAt === undefined) {
    context.addIssue({code: 'custom', path: ['startedAt'], message: 'A generating candidate requires startedAt.'});
  }
  if (candidate.status === 'complete') {
    if (candidate.relativePath === undefined) {
      context.addIssue({code: 'custom', path: ['relativePath'], message: 'A complete candidate requires its project-relative output path.'});
    }
    if (candidate.sha256 === undefined) {
      context.addIssue({code: 'custom', path: ['sha256'], message: 'A complete candidate requires its SHA-256 digest.'});
    }
    if (candidate.finishedAt === undefined) {
      context.addIssue({code: 'custom', path: ['finishedAt'], message: 'A complete candidate requires finishedAt.'});
    }
    if (candidate.technicalQa === undefined) {
      context.addIssue({code: 'custom', path: ['technicalQa'], message: 'A complete candidate requires recorded technical QA.'});
    }
  }
  if (candidate.status === 'interrupted' && candidate.interruptedAt === undefined) {
    context.addIssue({code: 'custom', path: ['interruptedAt'], message: 'An interrupted candidate requires interruptedAt.'});
  }
  if (candidate.status === 'failed' && candidate.error === undefined) {
    context.addIssue({code: 'custom', path: ['error'], message: 'A failed candidate requires an error message.'});
  }
});
export type ProductionCandidateState = z.infer<typeof productionCandidateStateSchema>;

export const productionShotStateSchema = z.object({
  shotId: productionIdSchema,
  shotKind: z.enum(['layered-collage', 'generated-performance']),
  occlusionRequirement: z.enum(['none', 'optional', 'required']),
  status: z.enum(['queued', 'generating', 'awaiting-review', 'selected', 'complete', 'failed', 'interrupted']),
  candidates: z.array(productionCandidateStateSchema),
  selection: z.object({
    candidateId: productionIdSchema,
    selectedAt: instantSchema,
  }).strict().optional(),
  interruptedAt: instantSchema.optional(),
  error: z.string().min(1).max(4_000).optional(),
}).strict().superRefine((shot, context) => {
  if (shot.shotKind === 'layered-collage' && shot.candidates.length !== 0) {
    context.addIssue({code: 'custom', path: ['candidates'], message: 'Layered collage shots do not have generated candidates.'});
  }
  if (shot.shotKind === 'layered-collage' && shot.occlusionRequirement !== 'none') {
    context.addIssue({code: 'custom', path: ['occlusionRequirement'], message: 'Layered collage shots cannot request generated-performance mattes.'});
  }
  if (shot.shotKind === 'generated-performance' && shot.candidates.length !== 2) {
    context.addIssue({code: 'custom', path: ['candidates'], message: 'Generated performance shots track exactly two candidates.'});
  }
  const candidateIds = new Set<string>();
  const seeds = new Set<number>();
  shot.candidates.forEach((candidate, index) => {
    if (candidateIds.has(candidate.candidateId)) {
      context.addIssue({code: 'custom', path: ['candidates', index, 'candidateId'], message: `Duplicate candidate ID: ${candidate.candidateId}`});
    }
    candidateIds.add(candidate.candidateId);
    if (seeds.has(candidate.seed)) {
      context.addIssue({code: 'custom', path: ['candidates', index, 'seed'], message: `Duplicate candidate seed: ${candidate.seed}`});
    }
    seeds.add(candidate.seed);
  });

  if (shot.selection !== undefined) {
    const selected = shot.candidates.find((candidate) => candidate.candidateId === shot.selection?.candidateId);
    if (selected === undefined) {
      context.addIssue({code: 'custom', path: ['selection', 'candidateId'], message: 'Selection must reference a candidate from this shot.'});
    } else {
      if (selected.status !== 'complete') {
        context.addIssue({code: 'custom', path: ['selection', 'candidateId'], message: 'Selected candidate must be complete.'});
      }
      if (selected.technicalQa?.result !== 'pass') {
        context.addIssue({code: 'custom', path: ['selection', 'candidateId'], message: 'Selected candidate must pass technical QA.'});
      }
      if (selected.humanDecision?.decision !== 'accept') {
        context.addIssue({code: 'custom', path: ['selection', 'candidateId'], message: 'Selected candidate requires an explicit human acceptance.'});
      }
      if (
        shot.occlusionRequirement === 'required'
        && (selected.matte.status !== 'complete' || selected.matte.technicalQa?.result !== 'pass')
      ) {
        context.addIssue({code: 'custom', path: ['selection', 'candidateId'], message: 'Required local matte must be complete and pass technical QA before selection.'});
      }
    }
    if (shot.status !== 'selected' && shot.status !== 'complete') {
      context.addIssue({code: 'custom', path: ['status'], message: 'A shot with a selection must be selected or complete.'});
    }
  } else if (shot.status === 'selected') {
    context.addIssue({code: 'custom', path: ['selection'], message: 'Selected shot status requires a recorded selection.'});
  }
  if (shot.status === 'interrupted' && shot.interruptedAt === undefined) {
    context.addIssue({code: 'custom', path: ['interruptedAt'], message: 'An interrupted shot requires interruptedAt.'});
  }
  if (shot.status === 'failed' && shot.error === undefined) {
    context.addIssue({code: 'custom', path: ['error'], message: 'A failed shot requires an error message.'});
  }
});
export type ProductionShotState = z.infer<typeof productionShotStateSchema>;

export const productionNarrationSegmentStateSchema = z.object({
  segmentId: productionIdSchema,
  outputPath: safePosixRelativePathSchema,
  startSeconds: z.number().finite().nonnegative(),
  endSeconds: z.number().finite().positive(),
  durationSeconds: z.number().finite().positive(),
}).strict().superRefine((segment, context) => {
  if (segment.endSeconds <= segment.startSeconds) {
    context.addIssue({code: 'custom', path: ['endSeconds'], message: 'Narration segment must end after it starts.'});
  }
  if (Math.abs((segment.endSeconds - segment.startSeconds) - segment.durationSeconds) > 0.01) {
    context.addIssue({code: 'custom', path: ['durationSeconds'], message: 'Narration segment duration must match its boundaries.'});
  }
});
export type ProductionNarrationSegmentState = z.infer<typeof productionNarrationSegmentStateSchema>;

export const productionNarrationStateSchema = z.object({
  status: z.enum(['queued', 'generating', 'complete', 'failed', 'interrupted']),
  startedAt: instantSchema.optional(),
  finishedAt: instantSchema.optional(),
  interruptedAt: instantSchema.optional(),
  mergedAudioPath: safePosixRelativePathSchema.optional(),
  sha256: sha256Schema.optional(),
  durationSeconds: z.number().finite().positive().optional(),
  speechDurationSeconds: z.number().finite().positive().optional(),
  tailPaddingSeconds: z.number().finite().nonnegative().optional(),
  segments: z.array(productionNarrationSegmentStateSchema).default([]),
  error: z.string().min(1).max(4_000).optional(),
}).strict().superRefine((narration, context) => {
  if (narration.status === 'generating' && narration.startedAt === undefined) {
    context.addIssue({code: 'custom', path: ['startedAt'], message: 'Generating narration requires startedAt.'});
  }
  if (narration.status === 'complete') {
    if (narration.finishedAt === undefined) {
      context.addIssue({code: 'custom', path: ['finishedAt'], message: 'Complete narration requires finishedAt.'});
    }
    if (
      narration.mergedAudioPath === undefined
      || narration.sha256 === undefined
      || narration.durationSeconds === undefined
      || narration.speechDurationSeconds === undefined
      || narration.tailPaddingSeconds === undefined
    ) {
      context.addIssue({code: 'custom', message: 'Complete narration requires output path, SHA-256, speech duration, padding, and total duration.'});
    }
    if (narration.segments.length === 0) {
      context.addIssue({code: 'custom', path: ['segments'], message: 'Complete narration requires measured segment timing.'});
    }
    let cursor = 0;
    narration.segments.forEach((segment, index) => {
      if (Math.abs(segment.startSeconds - cursor) > 0.01) {
        context.addIssue({code: 'custom', path: ['segments', index, 'startSeconds'], message: 'Narration segments must be contiguous and ordered.'});
      }
      cursor = segment.endSeconds;
    });
    if (narration.speechDurationSeconds !== undefined && Math.abs(cursor - narration.speechDurationSeconds) > 0.02) {
      context.addIssue({code: 'custom', path: ['speechDurationSeconds'], message: 'Speech duration must match the final segment end.'});
    }
    if (
      narration.durationSeconds !== undefined
      && narration.speechDurationSeconds !== undefined
      && narration.tailPaddingSeconds !== undefined
      && Math.abs(narration.speechDurationSeconds + narration.tailPaddingSeconds - narration.durationSeconds) > 0.02
    ) {
      context.addIssue({code: 'custom', path: ['durationSeconds'], message: 'Total narration duration must equal speech plus tail padding.'});
    }
  }
  if (narration.status === 'failed' && narration.error === undefined) {
    context.addIssue({code: 'custom', path: ['error'], message: 'Failed narration requires an error message.'});
  }
  if (narration.status === 'interrupted' && narration.interruptedAt === undefined) {
    context.addIssue({code: 'custom', path: ['interruptedAt'], message: 'Interrupted narration requires interruptedAt.'});
  }
});
export type ProductionNarrationState = z.infer<typeof productionNarrationStateSchema>;

export const productionStateSchema = z.object({
  schemaVersion: z.literal(PRODUCTION_PLAN_SCHEMA_VERSION),
  projectId: productionIdSchema,
  createdAt: instantSchema,
  updatedAt: instantSchema,
  narration: productionNarrationStateSchema.default({status: 'queued', segments: []}),
  shots: z.array(productionShotStateSchema),
}).strict().superRefine((state, context) => {
  const shotIds = new Set<string>();
  state.shots.forEach((shot, index) => {
    if (shotIds.has(shot.shotId)) {
      context.addIssue({code: 'custom', path: ['shots', index, 'shotId'], message: `Duplicate shot state: ${shot.shotId}`});
    }
    shotIds.add(shot.shotId);
  });
});
export type ProductionState = z.infer<typeof productionStateSchema>;

export const parseProductionState = (value: unknown): ProductionState => productionStateSchema.parse(value);

export const createProductionState = (
  productionValue: ProductionPlan,
  now = new Date().toISOString(),
): ProductionState => {
  const production = parseProductionPlan(productionValue);
  return productionStateSchema.parse({
    schemaVersion: PRODUCTION_PLAN_SCHEMA_VERSION,
    projectId: production.projectId,
    createdAt: now,
    updatedAt: now,
    narration: {status: 'queued', segments: []},
    shots: production.shots.map((shot) => ({
      shotId: shot.shotId,
      shotKind: shot.kind,
      occlusionRequirement: shot.kind === 'generated-performance' ? shot.occlusion.requirement : 'none',
      status: 'queued',
      candidates: shot.kind === 'generated-performance'
        ? shot.generation.candidateSeeds.map((seed, index) => ({
          candidateId: `${shot.shotId}-candidate-${index + 1}`,
          seed,
          status: 'queued',
          matte: {
            status: shot.occlusion.requirement === 'none' ? 'not-required' : 'queued',
          },
        }))
        : [],
    })),
  });
};

export type ProductionStateRecovery = {state: ProductionState; changed: boolean};

/** Convert in-flight work to an explicit, retryable interruption after a desktop restart. */
export const recoverInterruptedProductionState = (
  stateValue: ProductionState,
  interruptedAt = new Date().toISOString(),
): ProductionStateRecovery => {
  const state = parseProductionState(stateValue);
  let changed = false;
  const narration = state.narration.status === 'generating'
    ? {
        ...state.narration,
        status: 'interrupted' as const,
        interruptedAt,
      }
    : state.narration;
  if (state.narration.status === 'generating') changed = true;
  const shots = state.shots.map((shot) => {
    let shotChanged = shot.status === 'generating';
    const candidates = shot.candidates.map((candidate) => {
      const candidateInterrupted = candidate.status === 'generating';
      const matteInterrupted = candidate.matte.status === 'generating';
      if (!candidateInterrupted && !matteInterrupted) return candidate;
      changed = true;
      shotChanged = true;
      return {
        ...candidate,
        ...(candidateInterrupted ? {status: 'interrupted' as const, interruptedAt} : {}),
        matte: matteInterrupted
          ? {...candidate.matte, status: 'interrupted' as const, interruptedAt}
          : candidate.matte,
      };
    });
    if (!shotChanged) return shot;
    changed = true;
    return {
      ...shot,
      status: 'interrupted' as const,
      candidates,
      interruptedAt,
    };
  });
  if (!changed) return {state, changed: false};
  return {
    state: productionStateSchema.parse({...state, narration, shots, updatedAt: interruptedAt}),
    changed: true,
  };
};

/** Prove that mutable state still belongs to the immutable production contract. */
export const assertProductionStateMatchesPlan = (
  stateValue: ProductionState,
  productionValue: ProductionPlan,
): void => {
  const state = parseProductionState(stateValue);
  const production = parseProductionPlan(productionValue);
  if (state.projectId !== production.projectId) {
    throw new Error('PRODUCTION_STATE_PLAN_MISMATCH:projectId');
  }
  if (state.narration.status === 'complete') {
    if (state.narration.mergedAudioPath !== production.narration.mergedAudioPath) {
      throw new Error('PRODUCTION_STATE_PLAN_MISMATCH:narrationOutput');
    }
    const plannedSegments = production.narration.segments;
    if (
      state.narration.segments.length !== plannedSegments.length
      || state.narration.segments.some((segment, index) => {
        const planned = plannedSegments[index];
        return planned === undefined
          || segment.segmentId !== planned.segmentId
          || segment.outputPath !== planned.outputPath;
      })
    ) {
      throw new Error('PRODUCTION_STATE_PLAN_MISMATCH:narrationSegments');
    }
  }
  const stateByShot = new Map(state.shots.map((shot) => [shot.shotId, shot]));
  if (stateByShot.size !== production.shots.length) {
    throw new Error('PRODUCTION_STATE_PLAN_MISMATCH:shotCount');
  }
  for (const shot of production.shots) {
    const shotState = stateByShot.get(shot.shotId);
    if (shotState === undefined || shotState.shotKind !== shot.kind) {
      throw new Error(`PRODUCTION_STATE_PLAN_MISMATCH:shot:${shot.shotId}`);
    }
    const expectedOcclusionRequirement = shot.kind === 'generated-performance'
      ? shot.occlusion.requirement
      : 'none';
    if (shotState.occlusionRequirement !== expectedOcclusionRequirement) {
      throw new Error(`PRODUCTION_STATE_PLAN_MISMATCH:occlusion:${shot.shotId}`);
    }
    if (shot.kind === 'generated-performance') {
      const actualSeeds = shotState.candidates.map(({seed}) => seed).sort((a, b) => a - b);
      const expectedSeeds = [...shot.generation.candidateSeeds].sort((a, b) => a - b);
      if (actualSeeds.length !== 2 || actualSeeds.some((seed, index) => seed !== expectedSeeds[index])) {
        throw new Error(`PRODUCTION_STATE_PLAN_MISMATCH:seeds:${shot.shotId}`);
      }
      if (shot.occlusion.mode === 'local-matte') {
        for (const candidate of shotState.candidates) {
          if (
            candidate.matte.relativePath !== undefined
            && !candidate.matte.relativePath.startsWith(`${shot.occlusion.outputDirectory}/`)
          ) {
            throw new Error(`PRODUCTION_STATE_PLAN_MISMATCH:matteOutput:${shot.shotId}`);
          }
        }
      } else if (shotState.candidates.some((candidate) => candidate.matte.status !== 'not-required')) {
        throw new Error(`PRODUCTION_STATE_PLAN_MISMATCH:matteUnexpected:${shot.shotId}`);
      }
    }
  }
};

export const beginProductionNarration = (
  stateValue: ProductionState,
  startedAt = new Date().toISOString(),
): ProductionState => {
  const state = structuredClone(parseProductionState(stateValue));
  if (state.narration.status === 'generating') {
    throw new Error('PRODUCTION_STATE_NARRATION_ALREADY_GENERATING');
  }
  state.narration = {status: 'generating', startedAt, segments: []};
  state.updatedAt = startedAt;
  return productionStateSchema.parse(state);
};

export type CompleteProductionNarrationInput = {
  mergedAudioPath: string;
  sha256: string;
  durationSeconds: number;
  speechDurationSeconds: number;
  tailPaddingSeconds: number;
  segments: ProductionNarrationSegmentState[];
  finishedAt?: string;
};

export const completeProductionNarration = (
  stateValue: ProductionState,
  completion: CompleteProductionNarrationInput,
): ProductionState => {
  const state = structuredClone(parseProductionState(stateValue));
  if (state.narration.status !== 'generating') {
    throw new Error(`PRODUCTION_STATE_NARRATION_NOT_GENERATING:${state.narration.status}`);
  }
  const finishedAt = completion.finishedAt ?? new Date().toISOString();
  state.narration = {
    status: 'complete',
    ...(state.narration.startedAt === undefined ? {} : {startedAt: state.narration.startedAt}),
    finishedAt,
    mergedAudioPath: completion.mergedAudioPath,
    sha256: completion.sha256,
    durationSeconds: completion.durationSeconds,
    speechDurationSeconds: completion.speechDurationSeconds,
    tailPaddingSeconds: completion.tailPaddingSeconds,
    segments: completion.segments.map((segment) => ({...segment})),
  };
  state.updatedAt = finishedAt;
  return productionStateSchema.parse(state);
};

export const failProductionNarration = (
  stateValue: ProductionState,
  error: string,
  failedAt = new Date().toISOString(),
): ProductionState => {
  const state = structuredClone(parseProductionState(stateValue));
  state.narration = {
    status: 'failed',
    ...(state.narration.startedAt === undefined ? {} : {startedAt: state.narration.startedAt}),
    finishedAt: failedAt,
    segments: [],
    error: error.slice(0, 4_000),
  };
  state.updatedAt = failedAt;
  return productionStateSchema.parse(state);
};

export const interruptProductionNarration = (
  stateValue: ProductionState,
  interruptedAt = new Date().toISOString(),
): ProductionState => {
  const state = structuredClone(parseProductionState(stateValue));
  if (state.narration.status !== 'generating') return state;
  state.narration = {
    status: 'interrupted',
    ...(state.narration.startedAt === undefined ? {} : {startedAt: state.narration.startedAt}),
    interruptedAt,
    segments: [],
  };
  state.updatedAt = interruptedAt;
  return productionStateSchema.parse(state);
};

const mutableCandidate = (
  stateValue: ProductionState,
  shotId: string,
  candidateId: string,
): {state: ProductionState; shot: ProductionShotState; candidate: ProductionCandidateState} => {
  const state = structuredClone(parseProductionState(stateValue));
  const shot = state.shots.find((entry) => entry.shotId === shotId);
  if (shot === undefined) throw new Error(`PRODUCTION_STATE_SHOT_NOT_FOUND:${shotId}`);
  if (shot.shotKind !== 'generated-performance') {
    throw new Error(`PRODUCTION_STATE_SHOT_NOT_GENERATED:${shotId}`);
  }
  const candidate = shot.candidates.find((entry) => entry.candidateId === candidateId);
  if (candidate === undefined) throw new Error(`PRODUCTION_STATE_CANDIDATE_NOT_FOUND:${candidateId}`);
  return {state, shot, candidate};
};

export const beginProductionCandidate = (
  stateValue: ProductionState,
  shotId: string,
  candidateId: string,
  startedAt = new Date().toISOString(),
): ProductionState => {
  const {state, shot, candidate} = mutableCandidate(stateValue, shotId, candidateId);
  if (shot.candidates.some((entry) => entry.status === 'generating' && entry.candidateId !== candidateId)) {
    throw new Error(`PRODUCTION_STATE_SHOT_ALREADY_GENERATING:${shotId}`);
  }
  if (candidate.status !== 'queued' && candidate.status !== 'interrupted' && candidate.status !== 'failed') {
    throw new Error(`PRODUCTION_STATE_CANDIDATE_CANNOT_BEGIN:${candidateId}:${candidate.status}`);
  }
  candidate.status = 'generating';
  candidate.startedAt = startedAt;
  delete candidate.finishedAt;
  delete candidate.interruptedAt;
  delete candidate.relativePath;
  delete candidate.sha256;
  delete candidate.technicalQa;
  candidate.matte = {
    status: shot.occlusionRequirement === 'none' ? 'not-required' : 'queued',
  };
  delete candidate.humanDecision;
  delete candidate.error;
  shot.status = 'generating';
  delete shot.interruptedAt;
  delete shot.error;
  delete shot.selection;
  state.updatedAt = startedAt;
  return productionStateSchema.parse(state);
};

export const beginProductionCandidateMatte = (
  stateValue: ProductionState,
  shotId: string,
  candidateId: string,
  startedAt = new Date().toISOString(),
): ProductionState => {
  const {state, shot, candidate} = mutableCandidate(stateValue, shotId, candidateId);
  if (shot.occlusionRequirement === 'none') {
    throw new Error(`PRODUCTION_STATE_MATTE_NOT_PLANNED:${shotId}`);
  }
  if (candidate.status !== 'complete' || candidate.technicalQa?.result !== 'pass') {
    throw new Error(`PRODUCTION_STATE_MATTE_SOURCE_NOT_READY:${candidateId}`);
  }
  if (!['queued', 'failed', 'interrupted'].includes(candidate.matte.status)) {
    throw new Error(`PRODUCTION_STATE_MATTE_CANNOT_BEGIN:${candidateId}:${candidate.matte.status}`);
  }
  candidate.matte = {status: 'generating', startedAt};
  delete shot.selection;
  shot.status = 'generating';
  state.updatedAt = startedAt;
  return productionStateSchema.parse(state);
};

export type CompleteProductionCandidateMatteInput = {
  relativePath: string;
  sha256: string;
  technicalQa: CandidateTechnicalQa;
  finishedAt?: string;
};

export const completeProductionCandidateMatte = (
  stateValue: ProductionState,
  shotId: string,
  candidateId: string,
  completion: CompleteProductionCandidateMatteInput,
): ProductionState => {
  const {state, shot, candidate} = mutableCandidate(stateValue, shotId, candidateId);
  if (candidate.matte.status !== 'generating') {
    throw new Error(`PRODUCTION_STATE_MATTE_NOT_GENERATING:${candidateId}:${candidate.matte.status}`);
  }
  const finishedAt = completion.finishedAt ?? new Date().toISOString();
  candidate.matte = {
    status: 'complete',
    ...(candidate.matte.startedAt === undefined ? {} : {startedAt: candidate.matte.startedAt}),
    finishedAt,
    relativePath: completion.relativePath,
    sha256: completion.sha256,
    technicalQa: completion.technicalQa,
  };
  shot.status = 'awaiting-review';
  state.updatedAt = finishedAt;
  return productionStateSchema.parse(state);
};

export const failProductionCandidateMatte = (
  stateValue: ProductionState,
  shotId: string,
  candidateId: string,
  error: string,
  failedAt = new Date().toISOString(),
): ProductionState => {
  const {state, shot, candidate} = mutableCandidate(stateValue, shotId, candidateId);
  candidate.matte = {
    status: 'failed',
    ...(candidate.matte.startedAt === undefined ? {} : {startedAt: candidate.matte.startedAt}),
    finishedAt: failedAt,
    error: error.slice(0, 4_000),
  };
  shot.status = 'awaiting-review';
  state.updatedAt = failedAt;
  return productionStateSchema.parse(state);
};

export type CompleteProductionCandidateInput = {
  relativePath: string;
  sha256: string;
  technicalQa: CandidateTechnicalQa;
  finishedAt?: string;
};

export const completeProductionCandidate = (
  stateValue: ProductionState,
  shotId: string,
  candidateId: string,
  completion: CompleteProductionCandidateInput,
): ProductionState => {
  const {state, shot, candidate} = mutableCandidate(stateValue, shotId, candidateId);
  if (candidate.status !== 'generating') {
    throw new Error(`PRODUCTION_STATE_CANDIDATE_NOT_GENERATING:${candidateId}`);
  }
  const finishedAt = completion.finishedAt ?? new Date().toISOString();
  candidate.status = 'complete';
  candidate.finishedAt = finishedAt;
  candidate.relativePath = completion.relativePath;
  candidate.sha256 = completion.sha256;
  candidate.technicalQa = completion.technicalQa;
  delete candidate.interruptedAt;
  delete candidate.humanDecision;
  delete candidate.error;
  shot.status = 'awaiting-review';
  delete shot.interruptedAt;
  delete shot.selection;
  state.updatedAt = finishedAt;
  return productionStateSchema.parse(state);
};

export const reviewProductionCandidate = (
  stateValue: ProductionState,
  shotId: string,
  candidateId: string,
  decisionValue: CandidateHumanDecision,
): ProductionState => {
  const {state, shot, candidate} = mutableCandidate(stateValue, shotId, candidateId);
  if (candidate.status !== 'complete') {
    throw new Error(`PRODUCTION_STATE_CANDIDATE_NOT_REVIEWABLE:${candidateId}`);
  }
  const decision = candidateHumanDecisionSchema.parse(decisionValue);
  candidate.humanDecision = decision;
  shot.status = 'awaiting-review';
  delete shot.selection;
  state.updatedAt = decision.reviewedAt;
  return productionStateSchema.parse(state);
};

export const selectProductionCandidate = (
  stateValue: ProductionState,
  shotId: string,
  candidateId: string,
  selectedAt = new Date().toISOString(),
): ProductionState => {
  const {state, shot, candidate} = mutableCandidate(stateValue, shotId, candidateId);
  if (
    candidate.status !== 'complete'
    || candidate.technicalQa?.result !== 'pass'
    || candidate.humanDecision?.decision !== 'accept'
    || (
      shot.occlusionRequirement === 'required'
      && (candidate.matte.status !== 'complete' || candidate.matte.technicalQa?.result !== 'pass')
    )
  ) {
    throw new Error(`PRODUCTION_STATE_CANDIDATE_NOT_SELECTABLE:${candidateId}`);
  }
  shot.status = 'selected';
  shot.selection = {candidateId, selectedAt};
  state.updatedAt = selectedAt;
  return productionStateSchema.parse(state);
};

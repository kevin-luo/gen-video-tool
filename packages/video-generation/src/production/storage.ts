import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {parseProductionPlan, type ProductionPlan} from './production-plan.js';
import {
  parseProductionState,
  recoverInterruptedProductionState,
  type ProductionState,
} from './production-state.js';
import {
  acquireProductionRunLock,
  ProductionRunLockedError,
} from './run-lock.js';

export const PRODUCTION_PLAN_RELATIVE_PATH = 'production.json' as const;
export const PRODUCTION_STATE_RELATIVE_PATH = 'generated/production-state.json' as const;

const resolveProjectRoot = (projectRoot: string): string => {
  if (!path.isAbsolute(projectRoot)) throw new Error('PRODUCTION_PROJECT_ROOT_MUST_BE_ABSOLUTE');
  return path.resolve(projectRoot);
};

export const resolveProductionPlanPath = (projectRoot: string): string =>
  path.join(resolveProjectRoot(projectRoot), PRODUCTION_PLAN_RELATIVE_PATH);

export const resolveProductionStatePath = (projectRoot: string): string =>
  path.join(resolveProjectRoot(projectRoot), ...PRODUCTION_STATE_RELATIVE_PATH.split('/'));

const readJson = async (filePath: string): Promise<unknown> =>
  JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;

const writeJsonAtomic = async (filePath: string, value: unknown): Promise<void> => {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, {recursive: true});
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, {force: true});
  }
};

export const loadProductionPlan = async (projectRoot: string): Promise<ProductionPlan> =>
  parseProductionPlan(await readJson(resolveProductionPlanPath(projectRoot)));

export const writeProductionPlan = async (
  projectRoot: string,
  value: unknown,
): Promise<ProductionPlan> => {
  const plan = parseProductionPlan(value);
  await writeJsonAtomic(resolveProductionPlanPath(projectRoot), plan);
  return plan;
};

export type LoadProductionStateOptions = {
  /** Opt in only from application startup; ordinary UI reads must not interrupt active work. */
  recoverInterrupted?: boolean;
  interruptedAt?: string;
};

export const loadProductionState = async (
  projectRoot: string,
  options: LoadProductionStateOptions = {},
): Promise<ProductionState> => {
  const state = parseProductionState(await readJson(resolveProductionStatePath(projectRoot)));
  if (options.recoverInterrupted !== true) return state;
  const recovery = recoverInterruptedProductionState(
    state,
    options.interruptedAt ?? new Date().toISOString(),
  );
  if (recovery.changed) {
    await writeJsonAtomic(resolveProductionStatePath(projectRoot), recovery.state);
  }
  return recovery.state;
};

/**
 * Startup-only recovery. A short-lived recovery lease makes the state check and
 * mutation mutually exclusive with generation and narration in every process.
 * If another live process owns the project, startup is observational and must
 * not rewrite its `generating` state as `interrupted`.
 */
export const loadProductionStateForRestart = async (
  projectRoot: string,
  interruptedAt = new Date().toISOString(),
): Promise<ProductionState> => {
  let recoveryLock;
  try {
    recoveryLock = await acquireProductionRunLock(projectRoot, {kind: 'recovery'});
  } catch (error) {
    if (error instanceof ProductionRunLockedError) {
      return loadProductionState(projectRoot, {recoverInterrupted: false});
    }
    throw error;
  }
  try {
    return await loadProductionState(projectRoot, {
      recoverInterrupted: true,
      interruptedAt,
    });
  } finally {
    await recoveryLock.release();
  }
};

export const writeProductionState = async (
  projectRoot: string,
  value: unknown,
): Promise<ProductionState> => {
  const state = parseProductionState(value);
  await writeJsonAtomic(resolveProductionStatePath(projectRoot), state);
  return state;
};

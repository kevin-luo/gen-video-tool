import fs from 'node:fs/promises';
import path from 'node:path';
import {
  parseProductionPlan,
  type ProductionPlan,
} from '@gen-video-tool/video-generation';

const readJson = async (filePath: string): Promise<unknown> =>
  JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;

/** Load and re-validate the single immutable v3 project contract. */
export const loadProjectDirectory = async (projectRoot: string): Promise<ProductionPlan> => {
  const root = path.resolve(projectRoot);
  return parseProductionPlan(await readJson(path.join(root, 'production.json')));
};

export const projectDurationSeconds = (project: ProductionPlan): number => {
  const parsed = parseProductionPlan(project);
  return parsed.delivery.timeline.durationFrames / parsed.delivery.timeline.fps;
};

/**
 * Atomically replace production.json. Runtime state and generated outputs are deliberately
 * persisted elsewhere, leaving this file as the single project contract.
 */
export const saveProjectDirectory = async (projectRoot: string, project: ProductionPlan): Promise<void> => {
  const parsed = parseProductionPlan(project);
  const target = path.join(path.resolve(projectRoot), 'production.json');
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.mkdir(path.dirname(target), {recursive: true});
  await fs.writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, target);
};

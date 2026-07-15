import fs from 'node:fs/promises';
import path from 'node:path';
import {
  parseManifestDocument,
  parseProjectDocument,
  parseShotDocument,
  type ProjectDocument,
} from '@gen-video-tool/schema';

const readJson = async (filePath: string): Promise<unknown> =>
  JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;

/** Load and re-validate a committed project directory. */
export const loadProjectDirectory = async (projectRoot: string): Promise<ProjectDocument> => {
  const root = path.resolve(projectRoot);
  const manifest = parseManifestDocument(await readJson(path.join(root, 'manifest.json')));
  const shots = await Promise.all(manifest.shots.map(async (reference) =>
    parseShotDocument(await readJson(path.join(root, ...reference.path.split('/')))),
  ));
  return parseProjectDocument({schemaVersion: 2, manifest, shots});
};

export const projectDurationSeconds = (project: ProjectDocument): number =>
  project.shots.reduce((sum, shot) => sum + shot.durationFrames, 0) / project.manifest.fps;

/** Persist only schema-owned JSON files, using same-directory atomic replaces. */
export const saveProjectDirectory = async (projectRoot: string, project: ProjectDocument): Promise<void> => {
  const parsed = parseProjectDocument(project);
  const writeAtomic = async (target: string, value: unknown) => {
    const temporary = `${target}.${process.pid}.tmp`;
    await fs.mkdir(path.dirname(target), {recursive: true});
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, target);
  };
  await Promise.all(parsed.manifest.shots.map(async (reference) => {
    const shot = parsed.shots.find((candidate) => candidate.id === reference.id);
    if (!shot) throw new Error(`SHOT_DOCUMENT_MISSING:${reference.id}`);
    await writeAtomic(path.join(projectRoot, ...reference.path.split('/')), shot);
  }));
  await writeAtomic(path.join(projectRoot, 'manifest.json'), parsed.manifest);
}

import {mkdir, realpath, rm} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export const createStagingDirectory = async (parent: string): Promise<string> => {
  await mkdir(parent, {recursive: true});
  const resolvedParent = await realpath(parent);
  const staging = path.join(resolvedParent, `.import-${randomUUID()}.staging`);
  await mkdir(staging, {recursive: false});
  return staging;
};

export const cleanupStagingDirectory = async (staging: string): Promise<void> => {
  await rm(staging, {recursive: true, force: true, maxRetries: 3, retryDelay: 30});
};

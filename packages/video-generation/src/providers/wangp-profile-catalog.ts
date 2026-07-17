import fs from 'node:fs/promises';
import path from 'node:path';

import type {WanGPAcceleratorProfileSource} from './wangp-capabilities.js';

const MAX_PROFILE_BYTES = 256 * 1024;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isInside = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const readProfile = async (
  profileRoot: string,
  directory: string,
  filePath: string,
): Promise<WanGPAcceleratorProfileSource | null> => {
  const info = await fs.stat(filePath);
  if (!info.isFile() || info.size <= 0 || info.size > MAX_PROFILE_BYTES) return null;
  const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;
  if (!isRecord(parsed)) return null;
  const activatedLoras = parsed.activated_loras;
  const hasAcceleratorLora = Array.isArray(activatedLoras)
    ? activatedLoras.some((value) => typeof value === 'string' && /lora|accelerator/i.test(value))
    : typeof activatedLoras === 'string' && /lora|accelerator/i.test(activatedLoras);
  const label = path.basename(filePath, path.extname(filePath));
  if (!hasAcceleratorLora && !/fastwan|lightning|lightx|self.?forc|fusion/i.test(label)) return null;
  return {
    directory,
    label,
    relativePath: path.relative(profileRoot, filePath).split(path.sep).join('/'),
    settings: parsed,
    source: 'local-catalog',
  };
};

/**
 * WanGP 1.10.1 exposes profile directories through its MCP model schema but
 * does not yet expose a profile-list tool. This bounded local catalog reads
 * only those MCP-advertised directories from the trusted WanGP checkout.
 */
export const discoverLocalWanGPAcceleratorProfiles = async (
  wanGpRoot: string,
  directories: readonly string[],
): Promise<WanGPAcceleratorProfileSource[]> => {
  const root = path.resolve(wanGpRoot);
  const profileRoot = path.resolve(root, 'profiles');
  if (!isInside(root, profileRoot)) throw new Error('WANGP_PROFILE_ROOT_INVALID');
  const results: WanGPAcceleratorProfileSource[] = [];
  for (const rawDirectory of [...new Set(directories)]) {
    const normalized = rawDirectory.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
    if (!normalized) continue;
    const directoryPath = path.resolve(profileRoot, ...normalized.split('/'));
    if (!isInside(profileRoot, directoryPath)) throw new Error('WANGP_PROFILE_DIRECTORY_OUTSIDE_ROOT');
    let entries;
    try {
      entries = await fs.readdir(directoryPath, {withFileTypes: true});
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.json') continue;
      const profile = await readProfile(profileRoot, normalized, path.join(directoryPath, entry.name));
      if (profile) results.push(profile);
    }
  }
  return results.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
};


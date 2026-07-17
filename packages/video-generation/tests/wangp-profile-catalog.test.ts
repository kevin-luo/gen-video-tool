import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {afterEach, describe, expect, it} from 'vitest';

import {discoverLocalWanGPAcceleratorProfiles} from '../src/providers/wangp-profile-catalog.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, {recursive: true, force: true}))));

describe('discoverLocalWanGPAcceleratorProfiles', () => {
  it('reads only MCP-advertised profile directories', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wangp-profile-catalog-'));
    roots.push(root);
    await fs.mkdir(path.join(root, 'profiles', 'advertised'), {recursive: true});
    await fs.mkdir(path.join(root, 'profiles', 'private'), {recursive: true});
    await fs.writeFile(path.join(root, 'profiles', 'advertised', 'FastWan 3 Steps.json'), JSON.stringify({activated_loras: ['fastwan.safetensors'], num_inference_steps: 3}));
    await fs.writeFile(path.join(root, 'profiles', 'private', 'Lightning 4 Steps.json'), JSON.stringify({activated_loras: ['lightning.safetensors'], num_inference_steps: 4}));
    const profiles = await discoverLocalWanGPAcceleratorProfiles(root, ['advertised']);
    expect(profiles.map((profile) => profile.relativePath)).toEqual(['advertised/FastWan 3 Steps.json']);
  });

  it('rejects an advertised directory that escapes the trusted profile root', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wangp-profile-catalog-'));
    roots.push(root);
    await expect(discoverLocalWanGPAcceleratorProfiles(root, ['../outside'])).rejects.toThrow('WANGP_PROFILE_DIRECTORY_OUTSIDE_ROOT');
  });
});

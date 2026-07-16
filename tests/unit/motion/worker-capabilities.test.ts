import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {afterEach, describe, expect, it} from 'vitest';
import {createAutoRig, runRifeInterpolation} from '@gen-video-tool/worker-client';
import {installTemplate, loadTemplateCatalog} from '@gen-video-tool/template-market';

const temporaryRoots: string[] = [];
const temporaryRoot = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gen-video-capabilities-'));
  temporaryRoots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, {recursive: true, force: true})));
});

describe('Phase 4 worker capabilities', () => {
  it('builds a validated editable humanoid rig from one complete alpha PNG', async () => {
    const root = await temporaryRoot();
    const texture = path.join(root, 'figure.png');
    await sharp({create: {width: 100, height: 200, channels: 4, background: {r: 0, g: 0, b: 0, alpha: 0}}})
      .composite([{input: {create: {width: 60, height: 170, channels: 4, background: {r: 240, g: 210, b: 160, alpha: 1}}}, left: 20, top: 15}])
      .png()
      .toFile(texture);
    const rig = await createAutoRig(texture, 'assets/figure.png');
    expect(rig.canvas).toEqual({width: 100, height: 200});
    expect(rig.bones).toHaveLength(11);
    expect(rig.mesh.vertices.length).toBeGreaterThan(80);
    expect(rig.mesh.weights).toHaveLength(rig.mesh.vertices.length);
    for (const weights of rig.mesh.weights) {
      expect(weights.reduce((sum, influence) => sum + influence.weight, 0)).toBeCloseTo(1, 5);
    }
  });

  it('rejects a destructive in-place RIFE request before launching a worker', async () => {
    const root = await temporaryRoot();
    await expect(runRifeInterpolation(path.resolve(root, 'rife.exe'), {inputDirectory: root, outputDirectory: root})).rejects.toThrow('RIFE_OUTPUT_MUST_DIFFER');
  });

  it('loads and installs a validated local template entry', async () => {
    const root = path.resolve(import.meta.dirname, '..', '..', '..');
    const catalog = path.join(root, 'templates', 'market', 'catalog.json');
    const entries = await loadTemplateCatalog(catalog);
    expect(entries.map((entry) => entry.id)).toContain('football-last-frame');
    const installRoot = await temporaryRoot();
    const installed = await installTemplate(catalog, 'football-last-frame', installRoot);
    await expect(fs.access(path.join(installed, 'template.json'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(installed, 'install.json'))).resolves.toBeUndefined();
  });
});

import {mkdtemp, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import {afterEach, describe, expect, it} from 'vitest';
import {importAssetPack, inspectAssetPack} from '@gen-video-tool/asset-pack';

const created: string[] = [];
const temporaryDirectory = async (): Promise<string> => {
  const result = await mkdtemp(path.join(tmpdir(), 'gen-video-security-'));
  created.push(result);
  return result;
};

const writeZip = async (zip: JSZip, filePath: string): Promise<void> => {
  await writeFile(filePath, await zip.generateAsync({type: 'nodebuffer', compression: 'DEFLATE'}));
};

afterEach(async () => {
  await Promise.all(created.splice(0).map((entry) => rm(entry, {recursive: true, force: true})));
});

describe('asset pack import security', () => {
  it('rejects ZIP traversal using the original unsafe entry name', async () => {
    const zip = new JSZip();
    zip.file('../outside.txt', 'owned');
    zip.file('manifest.json', '{}');
    const filePath = path.join(await temporaryDirectory(), 'traversal.zip');
    await writeZip(zip, filePath);
    const result = await inspectAssetPack({source: {kind: 'zip', path: filePath}});
    expect(result.status).toBe('rejected');
    expect(result.diagnostics.map((item) => item.code)).toContain('PATH_TRAVERSAL');
  });

  it('rejects case-insensitive duplicate ZIP entries', async () => {
    const zip = new JSZip();
    zip.file('manifest.json', '{}');
    zip.file('Characters/Hero.png', 'a');
    zip.file('characters/hero.png', 'b');
    const filePath = path.join(await temporaryDirectory(), 'collision.zip');
    await writeZip(zip, filePath);
    const result = await inspectAssetPack({source: {kind: 'zip', path: filePath}});
    expect(result.diagnostics.map((item) => item.code)).toContain('PATH_COLLISION');
  });

  it('blocks a high-ratio ZIP before extraction', async () => {
    const zip = new JSZip();
    zip.file('manifest.json', 'A'.repeat(200_000));
    const filePath = path.join(await temporaryDirectory(), 'bomb.zip');
    await writeZip(zip, filePath);
    const result = await inspectAssetPack({
      source: {kind: 'zip', path: filePath},
      limits: {maxCompressionRatio: 3},
    });
    expect(result.diagnostics.map((item) => item.code)).toContain('ZIP_COMPRESSION_RATIO_EXCEEDED');
  });

  it('reports damaged ZIP input without throwing', async () => {
    const filePath = path.join(await temporaryDirectory(), 'damaged.zip');
    await writeFile(filePath, Buffer.from('not a zip'));
    const result = await inspectAssetPack({source: {kind: 'zip', path: filePath}});
    expect(result.status).toBe('rejected');
    expect(result.diagnostics.map((item) => item.code)).toContain('ZIP_CORRUPT');
  });

  it('rejects directory symlinks and junctions that escape the source root', async () => {
    const source = await temporaryDirectory();
    const outside = await temporaryDirectory();
    await writeFile(path.join(source, 'manifest.json'), '{}');
    await writeFile(path.join(outside, 'secret.txt'), 'secret');
    try {
      await symlink(outside, path.join(source, 'external'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }
    const result = await inspectAssetPack({source: {kind: 'directory', path: source}});
    expect(result.status).toBe('rejected');
    expect(result.diagnostics.map((item) => item.code)).toContain('SYMLINK_OUTSIDE_SOURCE');
  });

  it('rejects a projects root nested inside the directory source', async () => {
    const source = await temporaryDirectory();
    await writeFile(path.join(source, 'manifest.json'), '{}');
    const result = await importAssetPack({
      source: {kind: 'directory', path: source},
      projectsRoot: path.join(source, 'projects'),
    });
    expect(result.status).toBe('rejected');
    expect(result.diagnostics.map((item) => item.code)).toContain('SOURCE_DESTINATION_OVERLAP');
  });
});

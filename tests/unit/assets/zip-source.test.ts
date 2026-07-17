import {access, mkdtemp, open, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import {afterEach, describe, expect, it} from 'vitest';
import {
  DEFAULT_IMPORT_LIMITS,
  extractZipToStaging,
  type ImportLimits,
} from '@gen-video-tool/asset-pack';

const created: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gen-video-zip-source-'));
  created.push(directory);
  return directory;
};

const centralDirectoryOffset = (archive: Buffer): number => {
  for (let offset = 0; offset + 4 <= archive.byteLength; offset += 1) {
    if (archive.readUInt32LE(offset) === 0x02014b50) return offset;
  }
  throw new Error('test ZIP has no central directory');
};

const tightLimits = (overrides: Partial<ImportLimits> = {}): ImportLimits => ({
  ...DEFAULT_IMPORT_LIMITS,
  maxEntries: 4,
  maxEntryBytes: 1024,
  maxTotalBytes: 2048,
  maxPathLength: 64,
  maxSegmentLength: 64,
  ...overrides,
});

afterEach(async () => {
  await Promise.all(created.splice(0).map((entry) => rm(entry, {recursive: true, force: true})));
});

describe('bounded ZIP extraction', () => {
  it('rejects an oversized archive from file metadata before parsing its contents', async () => {
    const root = await temporaryDirectory();
    const staging = await temporaryDirectory();
    const archivePath = path.join(root, 'oversized.zip');
    const archive = await open(archivePath, 'w');
    await archive.truncate(1024 * 1024);
    await archive.close();

    const result = await extractZipToStaging(
      archivePath,
      staging,
      tightLimits({maxEntries: 1, maxTotalBytes: 64, maxPathLength: 16}),
    );

    expect(result.relativeFiles).toEqual([]);
    expect(result.totalBytes).toBe(0);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({code: 'ZIP_TOTAL_TOO_LARGE'}));
    expect(result.diagnostics.map((item) => item.code)).not.toContain('ZIP_CORRUPT');
    expect(await readdir(staging)).toEqual([]);
  });

  it('stops a forged high-expansion entry before writing a chunk beyond the caps', async () => {
    const root = await temporaryDirectory();
    const staging = await temporaryDirectory();
    const archivePath = path.join(root, 'forged-expansion.zip');
    const zip = new JSZip();
    zip.file('payload.bin', Buffer.alloc(256 * 1024, 0x61));
    const archive = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: {level: 9},
    });
    const centralOffset = centralDirectoryOffset(archive);
    // Lie only in the central directory. Preflight sees 32 bytes, while the
    // DEFLATE stream really expands to 256 KiB.
    archive.writeUInt32LE(32, centralOffset + 24);
    await writeFile(archivePath, archive);

    const result = await extractZipToStaging(archivePath, staging, tightLimits());

    expect(result.relativeFiles).toEqual([]);
    expect(result.totalBytes).toBe(0);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'ZIP_ENTRY_TOO_LARGE',
      assetPath: 'payload.bin',
    }));
    await expect(access(path.join(staging, 'payload.bin'))).rejects.toThrow();
  });

  it('preserves CRC validation without eagerly inflating the archive', async () => {
    const root = await temporaryDirectory();
    const staging = await temporaryDirectory();
    const archivePath = path.join(root, 'bad-crc.zip');
    const zip = new JSZip();
    zip.file('message.txt', 'bounded streaming');
    const archive = await zip.generateAsync({type: 'nodebuffer', compression: 'DEFLATE'});
    const centralOffset = centralDirectoryOffset(archive);
    archive.writeUInt32LE((archive.readUInt32LE(centralOffset + 16) ^ 0xffffffff) >>> 0, centralOffset + 16);
    await writeFile(archivePath, archive);

    const result = await extractZipToStaging(archivePath, staging, tightLimits());

    expect(result.relativeFiles).toEqual([]);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'ZIP_CORRUPT',
      assetPath: 'message.txt',
    }));
    await expect(access(path.join(staging, 'message.txt'))).rejects.toThrow();
  });

  it('still extracts a normal ZIP entry byte-for-byte', async () => {
    const root = await temporaryDirectory();
    const staging = await temporaryDirectory();
    const archivePath = path.join(root, 'normal.zip');
    const zip = new JSZip();
    zip.file('nested/message.txt', 'hello from a bounded stream');
    await writeFile(archivePath, await zip.generateAsync({type: 'nodebuffer', compression: 'DEFLATE'}));

    const result = await extractZipToStaging(archivePath, staging, tightLimits());

    expect(result.diagnostics.filter((item) => item.severity === 'error')).toEqual([]);
    expect(result.relativeFiles).toEqual(['nested/message.txt']);
    expect(await readFile(path.join(staging, 'nested', 'message.txt'), 'utf8')).toBe('hello from a bounded stream');
  });
});

import {mkdir, open, rm} from 'node:fs/promises';
import path from 'node:path';
import {Readable, Writable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import JSZip from 'jszip';
import {diagnostic} from './diagnostics';
import {normalizeAssetPath, PathCollisionTracker, PathHierarchyCollisionTracker, resolveAssetPath} from './paths';
import type {AssetPackDiagnostic, ImportLimits} from './types';

interface CentralDirectoryEntry {
  name: string;
  compressedBytes: number;
  uncompressedBytes: number;
  crc32: number;
  encrypted: boolean;
  symbolicLink: boolean;
}

interface ZipPreflight {
  entries: CentralDirectoryEntry[];
  diagnostics: AssetPackDiagnostic[];
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const MAX_EOCD_SEARCH = 65_557;
/**
 * JSZip needs a contiguous archive buffer to parse an input ZIP. Bound that
 * buffer independently of user-controlled file size so a malformed source
 * cannot exhaust the Electron main process before ZIP metadata is inspected.
 */
const MAX_ARCHIVE_READ_BYTES = 512 * 1024 * 1024;
const MAX_ARCHIVE_METADATA_ALLOWANCE = 16 * 1024 * 1024;

const archiveReadLimit = (limits: ImportLimits): number => {
  const entryMetadataAllowance = Math.max(0, limits.maxEntries) *
    (Math.max(0, limits.maxPathLength) * 2 + 256);
  const metadataAllowance = Math.min(
    MAX_ARCHIVE_METADATA_ALLOWANCE,
    MAX_EOCD_SEARCH + entryMetadataAllowance,
  );
  return Math.min(
    MAX_ARCHIVE_READ_BYTES,
    Math.max(0, limits.maxTotalBytes) + metadataAllowance,
  );
};

const readArchiveBounded = async (
  zipPath: string,
  limits: ImportLimits,
): Promise<{buffer: Buffer | null; diagnostics: AssetPackDiagnostic[]}> => {
  let file: Awaited<ReturnType<typeof open>> | null = null;
  try {
    file = await open(zipPath, 'r');
    const metadata = await file.stat();
    if (!metadata.isFile()) {
      return {buffer: null, diagnostics: [diagnostic('SOURCE_NOT_FOUND', 'error', 'ZIP 资产包不是可读取的普通文件。')]};
    }
    const byteLimit = archiveReadLimit(limits);
    if (metadata.size > byteLimit) {
      return {buffer: null, diagnostics: [diagnostic(
        'ZIP_TOTAL_TOO_LARGE',
        'error',
        `ZIP 文件本身为 ${metadata.size} 字节，超过安全读取上限 ${byteLimit} 字节。`,
        {suggestion: '请拆分资产包、删除未引用的大文件，或改为导入目录。'},
      )]};
    }

    // Read exactly the already-bounded snapshot size. If the file grows after
    // stat(), no additional memory is allocated; a truncated snapshot is later
    // reported as ZIP_CORRUPT.
    const buffer = Buffer.allocUnsafe(metadata.size);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const {bytesRead} = await file.read(buffer, offset, buffer.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return {buffer: offset === buffer.byteLength ? buffer : buffer.subarray(0, offset), diagnostics: []};
  } catch {
    return {buffer: null, diagnostics: [diagnostic('SOURCE_NOT_FOUND', 'error', '无法读取 ZIP 资产包。')]};
  } finally {
    await file?.close().catch(() => undefined);
  }
};

const CRC32_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC32_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  CRC32_TABLE[index] = value >>> 0;
}

const updateCrc32 = (previous: number, chunk: Buffer): number => {
  let value = (previous ^ 0xffffffff) >>> 0;
  for (const byte of chunk) {
    value = (CRC32_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8)) >>> 0;
  }
  return (value ^ 0xffffffff) >>> 0;
};

type ExtractionLimitCode = 'ZIP_ENTRY_TOO_LARGE' | 'ZIP_TOTAL_TOO_LARGE';

class ExtractionLimitError extends Error {
  public constructor(public readonly code: ExtractionLimitCode) {
    super(code);
  }
}

const findEndOfCentralDirectory = (buffer: Buffer): number => {
  const minimum = Math.max(0, buffer.length - MAX_EOCD_SEARCH);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  return -1;
};

const decodeEntryName = (bytes: Buffer): string => {
  try {
    return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  } catch {
    return bytes.toString('latin1');
  }
};

/** Parse only ZIP metadata so declared sizes are bounded before JSZip inflates data. */
export const preflightZipBuffer = (buffer: Buffer, limits: ImportLimits): ZipPreflight => {
  const diagnostics: AssetPackDiagnostic[] = [];
  const pathTracker = new PathCollisionTracker();
  const hierarchyTracker = new PathHierarchyCollisionTracker();
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0 || eocd + 22 > buffer.length) {
    return {entries: [], diagnostics: [diagnostic('ZIP_CORRUPT', 'error', 'ZIP 中央目录缺失或已损坏。', {
      suggestion: '请重新下载或重新导出资产包 ZIP。',
    })]};
  }

  const diskNumber = buffer.readUInt16LE(eocd + 4);
  const centralDisk = buffer.readUInt16LE(eocd + 6);
  const entriesOnDisk = buffer.readUInt16LE(eocd + 8);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
    return {entries: [], diagnostics: [diagnostic('ZIP_CORRUPT', 'error', '不支持多卷 ZIP 资产包。')]};
  }
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    return {entries: [], diagnostics: [diagnostic('ZIP64_UNSUPPORTED', 'error', '当前安全导入器不接受 ZIP64 资产包。', {
      suggestion: '请拆分资产包或使用普通 ZIP 重新压缩。',
    })]};
  }
  if (entryCount > limits.maxEntries) {
    diagnostics.push(diagnostic('ZIP_TOO_MANY_ENTRIES', 'error', `ZIP 包含 ${entryCount} 个条目，超过上限 ${limits.maxEntries}。`));
  }
  if (centralOffset + centralSize > eocd || centralOffset + centralSize > buffer.length) {
    return {entries: [], diagnostics: [...diagnostics, diagnostic('ZIP_CORRUPT', 'error', 'ZIP 中央目录边界无效。')]};
  }
  if (entryCount > limits.maxEntries) return {entries: [], diagnostics};

  let offset = centralOffset;
  let totalBytes = 0;
  const entries: CentralDirectoryEntry[] = [];
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      diagnostics.push(diagnostic('ZIP_CORRUPT', 'error', `ZIP 第 ${index + 1} 个中央目录条目无效。`));
      break;
    }
    const madeBy = buffer.readUInt16LE(offset + 4);
    const flags = buffer.readUInt16LE(offset + 8);
    const crc32 = buffer.readUInt32LE(offset + 16);
    const compressedBytes = buffer.readUInt32LE(offset + 20);
    const uncompressedBytes = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength;
    if (nextOffset > buffer.length) {
      diagnostics.push(diagnostic('ZIP_CORRUPT', 'error', `ZIP 第 ${index + 1} 个条目长度无效。`));
      break;
    }
    const name = decodeEntryName(buffer.subarray(offset + 46, offset + 46 + nameLength));
    const creatorSystem = madeBy >>> 8;
    const unixMode = externalAttributes >>> 16;
    const symbolicLink = creatorSystem === 3 && (unixMode & 0o170000) === 0o120000;
    const encrypted = (flags & 0x0001) !== 0;
    entries.push({name, compressedBytes, uncompressedBytes, crc32, encrypted, symbolicLink});
    if (!name.endsWith('/') && !name.endsWith('\\')) totalBytes += uncompressedBytes;

    if (encrypted) {
      diagnostics.push(diagnostic('ZIP_ENCRYPTED_ENTRY', 'error', '不允许加密 ZIP 条目。', {assetPath: name}));
    }
    if (symbolicLink) {
      diagnostics.push(diagnostic('ZIP_SYMLINK_ENTRY', 'error', 'ZIP 资产包不能包含符号链接。', {assetPath: name}));
    }
    const pathCandidate = name.replace(/[\\/]+$/u, '');
    if (pathCandidate) {
      const normalized = normalizeAssetPath(pathCandidate, limits);
      diagnostics.push(...normalized.diagnostics);
      if (normalized.ok) {
        const hierarchyCollision = hierarchyTracker.add(normalized.value);
        if (hierarchyCollision) diagnostics.push(hierarchyCollision);
        if (!name.endsWith('/') && !name.endsWith('\\')) {
          const pathCollision = pathTracker.add(normalized.value);
          if (pathCollision) diagnostics.push(pathCollision);
        }
      }
    }
    if (uncompressedBytes > limits.maxEntryBytes) {
      diagnostics.push(diagnostic('ZIP_ENTRY_TOO_LARGE', 'error', `条目解压后为 ${uncompressedBytes} 字节，超过单文件上限。`, {assetPath: name}));
    }
    const ratio = compressedBytes === 0
      ? (uncompressedBytes === 0 ? 1 : Number.POSITIVE_INFINITY)
      : uncompressedBytes / compressedBytes;
    if (ratio > limits.maxCompressionRatio) {
      diagnostics.push(diagnostic('ZIP_COMPRESSION_RATIO_EXCEEDED', 'error', `条目压缩比 ${ratio.toFixed(1)} 超过安全上限 ${limits.maxCompressionRatio}。`, {
        assetPath: name,
        suggestion: '请使用常规压缩级别重新打包，或导入目录。',
      }));
    }
    offset = nextOffset;
  }
  if (totalBytes > limits.maxTotalBytes) {
    diagnostics.push(diagnostic('ZIP_TOTAL_TOO_LARGE', 'error', `ZIP 声明的总解压大小 ${totalBytes} 字节超过上限。`));
  }
  return {entries, diagnostics};
};

export interface ExtractionSummary {
  relativeFiles: string[];
  totalBytes: number;
  diagnostics: AssetPackDiagnostic[];
}

export const extractZipToStaging = async (
  zipPath: string,
  stagingRoot: string,
  limits: ImportLimits,
): Promise<ExtractionSummary> => {
  const source = await readArchiveBounded(zipPath, limits);
  if (!source.buffer) {
    return {relativeFiles: [], totalBytes: 0, diagnostics: source.diagnostics};
  }
  const buffer = source.buffer;
  const preflight = preflightZipBuffer(buffer, limits);
  const diagnostics = [...preflight.diagnostics];
  if (diagnostics.some((item) => item.severity === 'error')) {
    return {relativeFiles: [], totalBytes: 0, diagnostics};
  }

  let archive: JSZip;
  try {
    // CRC is checked incrementally while each entry is streamed below. Asking
    // JSZip to check it here would eagerly inflate every file before our caps.
    archive = await JSZip.loadAsync(buffer, {checkCRC32: false, createFolders: false});
  } catch {
    return {relativeFiles: [], totalBytes: 0, diagnostics: [...diagnostics, diagnostic('ZIP_CORRUPT', 'error', 'ZIP 内容损坏、CRC 错误或使用了不支持的压缩方式。', {
      suggestion: '请重新导出 ZIP，并在本机先尝试解压确认完整性。',
    })]};
  }

  const metadataByPath = new Map<string, CentralDirectoryEntry>();
  for (const metadata of preflight.entries) {
    const pathCandidate = metadata.name.replace(/[\\/]+$/u, '');
    if (!pathCandidate) continue;
    const normalized = normalizeAssetPath(pathCandidate, limits);
    if (normalized.ok) metadataByPath.set(normalized.value.canonical, metadata);
  }

  const tracker = new PathCollisionTracker();
  const hierarchyTracker = new PathHierarchyCollisionTracker();
  const relativeFiles: string[] = [];
  let totalBytes = 0;
  for (const entry of Object.values(archive.files)) {
    const unsafeName = (entry as JSZip.JSZipObject & {unsafeOriginalName?: string}).unsafeOriginalName ?? entry.name;
    const isDirectory = entry.dir || unsafeName.endsWith('/') || unsafeName.endsWith('\\');
    const pathCandidate = isDirectory ? unsafeName.replace(/[\\/]+$/u, '') : unsafeName;
    if (!pathCandidate) continue;
    const normalized = normalizeAssetPath(pathCandidate, limits);
    diagnostics.push(...normalized.diagnostics);
    if (!normalized.ok) continue;
    const hierarchyCollision = hierarchyTracker.add(normalized.value);
    if (hierarchyCollision) {
      diagnostics.push(hierarchyCollision);
      continue;
    }
    if (isDirectory) continue;
    const collision = tracker.add(normalized.value);
    if (collision) {
      diagnostics.push(collision);
      continue;
    }
    const outputPath = resolveAssetPath(stagingRoot, normalized.value.normalized);
    if (!outputPath) {
      diagnostics.push(diagnostic('PATH_TRAVERSAL', 'error', 'ZIP 条目解析后逃逸 staging 目录。', {assetPath: unsafeName}));
      continue;
    }
    const metadata = metadataByPath.get(normalized.value.canonical);
    if (!metadata) {
      diagnostics.push(diagnostic('ZIP_CORRUPT', 'error', 'ZIP 条目与中央目录不一致。', {assetPath: normalized.value.normalized}));
      continue;
    }

    await mkdir(path.dirname(outputPath), {recursive: true});
    let output: Awaited<ReturnType<typeof open>> | null = null;
    let stream: Readable | null = null;
    let entryBytes = 0;
    let entryCrc32 = 0;
    let complete = false;
    let outputCreated = false;
    try {
      output = await open(outputPath, 'wx');
      outputCreated = true;
      stream = entry.nodeStream('nodebuffer') as Readable;
      const sink = new Writable({
        write(chunk: Buffer, _encoding, callback) {
          const nextEntryBytes = entryBytes + chunk.byteLength;
          if (nextEntryBytes > limits.maxEntryBytes) {
            callback(new ExtractionLimitError('ZIP_ENTRY_TOO_LARGE'));
            return;
          }
          if (totalBytes + nextEntryBytes > limits.maxTotalBytes) {
            callback(new ExtractionLimitError('ZIP_TOTAL_TOO_LARGE'));
            return;
          }
          if (nextEntryBytes > metadata.uncompressedBytes) {
            callback(new Error('ZIP declared uncompressed size is smaller than its stream'));
            return;
          }
          const writeChunk = async (): Promise<void> => {
            let offset = 0;
            while (offset < chunk.byteLength) {
              const result = await output!.write(chunk, offset, chunk.byteLength - offset);
              if (result.bytesWritten === 0) throw new Error('ZIP extraction made no write progress');
              offset += result.bytesWritten;
            }
            entryBytes = nextEntryBytes;
            entryCrc32 = updateCrc32(entryCrc32, chunk);
          };
          void writeChunk().then(() => callback(), callback);
        },
      });
      await pipeline(stream, sink);
      if (entryBytes !== metadata.uncompressedBytes || entryCrc32 !== metadata.crc32) {
        throw new Error('ZIP entry size or CRC mismatch');
      }
      complete = true;
    } catch (error) {
      if (error instanceof ExtractionLimitError && error.code === 'ZIP_ENTRY_TOO_LARGE') {
        diagnostics.push(diagnostic('ZIP_ENTRY_TOO_LARGE', 'error', '解压后的条目超过单文件安全上限。', {assetPath: normalized.value.normalized}));
      } else if (error instanceof ExtractionLimitError && error.code === 'ZIP_TOTAL_TOO_LARGE') {
        diagnostics.push(diagnostic('ZIP_TOTAL_TOO_LARGE', 'error', '解压总大小超过安全上限。'));
      } else {
        diagnostics.push(diagnostic('ZIP_CORRUPT', 'error', '无法安全解压 ZIP 条目，或条目大小/CRC 不匹配。', {assetPath: normalized.value.normalized}));
      }
    } finally {
      stream?.destroy();
      await output?.close().catch(() => undefined);
      if (outputCreated && !complete) await rm(outputPath, {force: true}).catch(() => undefined);
    }

    if (!complete) {
      if (diagnostics.at(-1)?.code === 'ZIP_TOTAL_TOO_LARGE') break;
      continue;
    }
    totalBytes += entryBytes;
    relativeFiles.push(normalized.value.normalized);
  }
  return {relativeFiles, totalBytes, diagnostics};
};

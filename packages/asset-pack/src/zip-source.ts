import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import {diagnostic} from './diagnostics';
import {normalizeAssetPath, PathCollisionTracker, PathHierarchyCollisionTracker, resolveAssetPath} from './paths';
import type {AssetPackDiagnostic, ImportLimits} from './types';

interface CentralDirectoryEntry {
  name: string;
  compressedBytes: number;
  uncompressedBytes: number;
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
    entries.push({name, compressedBytes, uncompressedBytes, encrypted, symbolicLink});
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
  let buffer: Buffer;
  try {
    buffer = await readFile(zipPath);
  } catch {
    return {relativeFiles: [], totalBytes: 0, diagnostics: [diagnostic('SOURCE_NOT_FOUND', 'error', '无法读取 ZIP 资产包。')]};
  }
  const preflight = preflightZipBuffer(buffer, limits);
  const diagnostics = [...preflight.diagnostics];
  if (diagnostics.some((item) => item.severity === 'error')) {
    return {relativeFiles: [], totalBytes: 0, diagnostics};
  }

  let archive: JSZip;
  try {
    archive = await JSZip.loadAsync(buffer, {checkCRC32: true, createFolders: false});
  } catch {
    return {relativeFiles: [], totalBytes: 0, diagnostics: [...diagnostics, diagnostic('ZIP_CORRUPT', 'error', 'ZIP 内容损坏、CRC 错误或使用了不支持的压缩方式。', {
      suggestion: '请重新导出 ZIP，并在本机先尝试解压确认完整性。',
    })]};
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
    let content: Buffer;
    try {
      content = await entry.async('nodebuffer');
    } catch {
      diagnostics.push(diagnostic('ZIP_CORRUPT', 'error', '无法解压 ZIP 条目。', {assetPath: normalized.value.normalized}));
      continue;
    }
    totalBytes += content.byteLength;
    if (content.byteLength > limits.maxEntryBytes) {
      diagnostics.push(diagnostic('ZIP_ENTRY_TOO_LARGE', 'error', '解压后的条目超过单文件安全上限。', {assetPath: normalized.value.normalized}));
      continue;
    }
    if (totalBytes > limits.maxTotalBytes) {
      diagnostics.push(diagnostic('ZIP_TOTAL_TOO_LARGE', 'error', '解压总大小超过安全上限。'));
      break;
    }
    await mkdir(path.dirname(outputPath), {recursive: true});
    await writeFile(outputPath, content, {flag: 'wx'});
    relativeFiles.push(normalized.value.normalized);
  }
  return {relativeFiles, totalBytes, diagnostics};
};

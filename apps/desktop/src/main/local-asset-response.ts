import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {Readable} from 'node:stream';

export type ByteRange = {start: number; end: number};

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.aac': 'audio/aac',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.srt': 'application/x-subrip; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
};

export const parseByteRange = (header: string | null, size: number): ByteRange | null | 'invalid' => {
  if (header === null) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2]) || size <= 0) return 'invalid';

  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return 'invalid';
    return {start: Math.max(0, size - suffixLength), end: size - 1};
  }

  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || start >= size || requestedEnd < start) {
    return 'invalid';
  }
  return {start, end: Math.min(size - 1, requestedEnd)};
};

const responseBody = (filePath: string, range?: ByteRange): ConstructorParameters<typeof Response>[0] => {
  const stream = fsSync.createReadStream(filePath, range);
  return Readable.toWeb(stream) as ConstructorParameters<typeof Response>[0];
};

export const createLocalAssetResponse = async (filePath: string, request: Request): Promise<Response> => {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat?.isFile()) return new Response('Not found', {status: 404});

  const size = stat.size;
  const range = parseByteRange(request.headers.get('range'), size);
  const contentType = MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  const sharedHeaders = {
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'Content-Type': contentType,
  };

  if (range === 'invalid') {
    return new Response(null, {
      status: 416,
      headers: {...sharedHeaders, 'Content-Range': `bytes */${size}`},
    });
  }

  if (range) {
    const contentLength = range.end - range.start + 1;
    return new Response(request.method === 'HEAD' ? null : responseBody(filePath, range), {
      status: 206,
      headers: {
        ...sharedHeaders,
        'Content-Length': String(contentLength),
        'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
      },
    });
  }

  return new Response(request.method === 'HEAD' ? null : responseBody(filePath), {
    status: 200,
    headers: {...sharedHeaders, 'Content-Length': String(size)},
  });
};

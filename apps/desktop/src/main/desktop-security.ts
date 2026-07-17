import path from 'node:path';
import {fileURLToPath} from 'node:url';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export type TrustedRenderer =
  | {
      kind: 'loopback-url';
      entryUrl: string;
      origin: string;
    }
  | {
      kind: 'file';
      entryUrl: string;
      filePath: string;
    };

export type TrustedRendererSelection = {
  renderer: TrustedRenderer;
  ignoredEnvironmentUrl: boolean;
};

type SelectTrustedRendererOptions = {
  isPackaged: boolean;
  environmentUrl?: string | undefined;
  fileRendererUrl: string;
};

const normalizedFilePath = (value: string): string => {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

export const parseLoopbackRendererUrl = (value: string): URL | null => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null;
  if (!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) return null;
  return parsed;
};

export const selectTrustedRenderer = ({
  isPackaged,
  environmentUrl,
  fileRendererUrl,
}: SelectTrustedRendererOptions): TrustedRendererSelection => {
  const fileUrl = new URL(fileRendererUrl);
  if (fileUrl.protocol !== 'file:') throw new Error('FILE_RENDERER_URL_INVALID');

  const candidate = environmentUrl?.trim();
  if (!isPackaged && candidate) {
    const parsed = parseLoopbackRendererUrl(candidate);
    if (parsed) {
      return {
        renderer: {
          kind: 'loopback-url',
          entryUrl: parsed.toString(),
          origin: parsed.origin,
        },
        ignoredEnvironmentUrl: false,
      };
    }
  }

  return {
    renderer: {
      kind: 'file',
      entryUrl: fileUrl.toString(),
      filePath: fileURLToPath(fileUrl),
    },
    ignoredEnvironmentUrl: Boolean(candidate),
  };
};

export const isTrustedRendererLocation = (candidate: string, renderer: TrustedRenderer): boolean => {
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return false;
  }

  if (renderer.kind === 'loopback-url') {
    return parseLoopbackRendererUrl(parsed.toString())?.origin === renderer.origin;
  }

  if (parsed.protocol !== 'file:') return false;
  try {
    return normalizedFilePath(fileURLToPath(parsed)) === normalizedFilePath(renderer.filePath);
  } catch {
    return false;
  }
};

export const isTrustedIpcSender = (
  senderUrl: string | undefined,
  isMainFrame: boolean,
  renderer: TrustedRenderer,
): boolean => {
  if (!senderUrl || !isMainFrame) return false;
  return isTrustedRendererLocation(senderUrl, renderer);
};

export const diagnosticUrl = (value: string): string => {
  try {
    const parsed = new URL(value);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return 'invalid-url';
  }
};

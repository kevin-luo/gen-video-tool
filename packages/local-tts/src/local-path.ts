import path from 'node:path';

import {LocalTtsError} from './types';

const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/;
const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const HTTP_LIKE = /^https?:/i;
const UNC_PATH = /^(?:\\\\|\/\/)/;

export function assertAbsoluteLocalPath(value: string, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new LocalTtsError('LOCAL_TTS_LOCAL_PATH_REQUIRED', `${field} must be an absolute local path`, {
      details: {field},
    });
  }
  if (URI_SCHEME.test(value) || HTTP_LIKE.test(value) || UNC_PATH.test(value)) {
    throw new LocalTtsError(
      'LOCAL_TTS_REMOTE_PATH_FORBIDDEN',
      `${field} must stay on this computer; URL and UNC paths are forbidden`,
      {details: {field}},
    );
  }
  // path.isAbsolute uses the host platform. Keep drive-path recognition explicit
  // so plans can be validated deterministically in cross-platform tooling too.
  if (!path.isAbsolute(value) && !WINDOWS_DRIVE_PATH.test(value)) {
    throw new LocalTtsError('LOCAL_TTS_LOCAL_PATH_REQUIRED', `${field} must be an absolute local path`, {
      details: {field},
    });
  }
  return path.normalize(value);
}

export function assertNonEmptyExactText(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0')) {
    throw new LocalTtsError('LOCAL_TTS_INVALID_REQUEST', `${field} must contain non-empty text`, {
      details: {field},
    });
  }
  return value;
}

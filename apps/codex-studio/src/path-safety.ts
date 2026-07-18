import path from 'node:path';

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;

export const assertSafeId = (value: string, label: string): string => {
  if (!SAFE_ID.test(value)) throw new Error(`${label}_INVALID`);
  return value;
};

export const resolveInside = (rootValue: string, relativeValue: string): string => {
  const root = path.resolve(rootValue);
  if (!relativeValue || path.isAbsolute(relativeValue) || /^[a-zA-Z]:/u.test(relativeValue)) {
    throw new Error('STUDIO_MEDIA_PATH_INVALID');
  }
  const target = path.resolve(root, ...relativeValue.replaceAll('\\', '/').split('/'));
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('STUDIO_MEDIA_PATH_OUTSIDE_ROOT');
  }
  return target;
};

import {staticFile} from 'remotion';

/** Resolve the same project-relative asset for Remotion Studio/render and Electron preview. */
export const resolveAssetSource = (assetBase: string, assetPath: string): string => {
  const joined = `${assetBase.replace(/\/$/, '')}/${assetPath}`;
  return assetBase.includes('://') ? encodeURI(joined) : staticFile(joined);
};

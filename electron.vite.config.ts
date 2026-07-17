import fs from 'node:fs';
import path from 'node:path';
import {defineConfig} from 'electron-vite';
import react from '@vitejs/plugin-react';

export const findRepositoryRoot = (startDirectory = process.cwd()): string => {
  let candidate = path.resolve(startDirectory);
  while (true) {
    if (
      fs.existsSync(path.join(candidate, 'package.json'))
      && fs.existsSync(path.join(candidate, 'apps/desktop/src/main/index.ts'))
    ) return candidate;
    const parent = path.dirname(candidate);
    if (parent === candidate) throw new Error('GEN_VIDEO_REPOSITORY_ROOT_NOT_FOUND');
    candidate = parent;
  }
};

export const createDesktopConfig = (repositoryRoot: string) => {
  const root = path.resolve(repositoryRoot);
  const aliases = {
    '@gen-video-tool/asset-pack': path.join(root, 'packages/asset-pack/src/index.ts'),
    '@gen-video-tool/motion-core': path.join(root, 'packages/motion-core/src/index.ts'),
    '@gen-video-tool/remotion-engine': path.join(root, 'packages/remotion-engine/src/index.ts'),
    '@gen-video-tool/render-service': path.join(root, 'packages/render-service/src/index.ts'),
    '@gen-video-tool/local-tts': path.join(root, 'packages/local-tts/src/index.ts'),
    '@gen-video-tool/video-generation': path.join(root, 'packages/video-generation/src/index.ts'),
  };

  return defineConfig({
    main: {
      resolve: {alias: aliases},
      build: {rollupOptions: {
        input: path.join(root, 'apps/desktop/src/main/index.ts'),
        external: ['@remotion/bundler', '@remotion/renderer'],
      }},
    },
    preload: {
      resolve: {alias: aliases},
      build: {rollupOptions: {
        input: path.join(root, 'apps/desktop/src/preload/index.ts'),
        output: {format: 'cjs', entryFileNames: 'index.cjs'},
      }},
    },
    renderer: {
      root: path.join(root, 'apps/desktop/src/renderer'),
      server: {host: '127.0.0.1', port: 32147},
      resolve: {alias: aliases},
      plugins: [react()],
      build: {rollupOptions: {input: path.join(root, 'apps/desktop/src/renderer/index.html')}},
    },
  });
};

export default createDesktopConfig(findRepositoryRoot());

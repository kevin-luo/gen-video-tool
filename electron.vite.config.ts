import path from 'node:path';
import {defineConfig} from 'electron-vite';
import react from '@vitejs/plugin-react';

const root = path.resolve(import.meta.dirname);
const aliases = {
  '@gen-video-tool/schema': path.join(root, 'packages/schema/src/index.ts'),
  '@gen-video-tool/asset-pack': path.join(root, 'packages/asset-pack/src/index.ts'),
  '@gen-video-tool/motion-core': path.join(root, 'packages/motion-core/src/index.ts'),
  '@gen-video-tool/remotion-engine': path.join(root, 'packages/remotion-engine/src/index.ts'),
  '@gen-video-tool/render-service': path.join(root, 'packages/render-service/src/index.ts'),
  '@gen-video-tool/worker-client': path.join(root, 'packages/worker-client/src/index.ts'),
  '@gen-video-tool/template-market': path.join(root, 'packages/template-market/src/index.ts'),
};

export default defineConfig({
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

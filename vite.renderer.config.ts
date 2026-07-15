import path from 'node:path';
import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';

const root = path.resolve(import.meta.dirname);

export default defineConfig({
  root: path.join(root, 'apps/desktop/src/renderer'),
  server: {host: '127.0.0.1', port: 32147, strictPort: true},
  resolve: {alias: {
    '@gen-video-tool/schema': path.join(root, 'packages/schema/src/index.ts'),
    '@gen-video-tool/asset-pack': path.join(root, 'packages/asset-pack/src/index.ts'),
    '@gen-video-tool/motion-core': path.join(root, 'packages/motion-core/src/index.ts'),
    '@gen-video-tool/remotion-engine': path.join(root, 'packages/remotion-engine/src/index.ts'),
  }},
  plugins: [react()],
});

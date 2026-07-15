import path from 'node:path';
import {defineConfig} from 'vitest/config';

const root = path.resolve(import.meta.dirname);

export default defineConfig({
  resolve: {
    alias: {
      '@gen-video-tool/schema': path.join(root, 'packages/schema/src/index.ts'),
      '@gen-video-tool/asset-pack': path.join(root, 'packages/asset-pack/src/index.ts'),
      '@gen-video-tool/motion-core': path.join(root, 'packages/motion-core/src/index.ts'),
      '@gen-video-tool/remotion-engine': path.join(root, 'packages/remotion-engine/src/index.ts'),
      '@gen-video-tool/worker-client': path.join(root, 'packages/worker-client/src/index.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    coverage: {reporter: ['text', 'html']},
  },
});

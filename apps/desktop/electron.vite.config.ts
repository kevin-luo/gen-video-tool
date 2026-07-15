import {defineConfig, externalizeDepsPlugin} from 'electron-vite';
import react from '@vitejs/plugin-react';
import {resolve} from 'node:path';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: resolve(import.meta.dirname, 'out/main'),
      rollupOptions: {
        input: resolve(import.meta.dirname, 'src/main/index.ts'),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: resolve(import.meta.dirname, 'out/preload'),
      rollupOptions: {
        input: resolve(import.meta.dirname, 'src/preload/index.ts'),
      },
    },
  },
  renderer: {
    root: resolve(import.meta.dirname, 'src/renderer'),
    plugins: [react()],
    build: {
      outDir: resolve(import.meta.dirname, 'out/renderer'),
      rollupOptions: {
        input: resolve(import.meta.dirname, 'src/renderer/index.html'),
      },
    },
  },
});

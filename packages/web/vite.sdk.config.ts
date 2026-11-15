import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'SilentMI',
      formats: ['es', 'iife'],
      fileName: (format) => (format === 'es' ? 'silent-mi.esm.js' : 'silent-mi.iife.js'),
    },
    rollupOptions: {
      external: [],
      output: {
        extend: true,
      },
    },
    target: 'es2022',
    minify: 'esbuild',
    sourcemap: true,
  },
});

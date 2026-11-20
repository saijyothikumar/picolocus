import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'Picolocus',
      formats: ['es', 'iife'],
      fileName: (format) => (format === 'es' ? 'picolocus.esm.js' : 'picolocus.iife.js'),
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

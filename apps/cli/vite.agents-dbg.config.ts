import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  root: 'src',
  base: './',
  build: {
    outDir: '../dist/agents-dbg',
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, 'src/agents-dbg.html'),
    },
  },
});

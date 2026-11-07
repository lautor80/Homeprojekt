import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const root = path.resolve(import.meta.dirname);

export default defineConfig({
  root,
  plugins: [react()],
  resolve: {
    alias: {
      '@core': path.join(root, 'src'),
      '@modules': path.join(root, '..', 'modules'),
    },
  },
  build: { outDir: path.join(root, 'dist'), emptyOutDir: true, chunkSizeWarningLimit: 4000 },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:8080' },
  },
});

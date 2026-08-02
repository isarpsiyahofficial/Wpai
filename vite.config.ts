import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: '.',
  build: {
    outDir: 'dist/web',
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: { input: 'index.html' }
  },
  resolve: {
    alias: {
      '@': new URL('./src', import.meta.url).pathname,
      '@shared': new URL('./src/shared', import.meta.url).pathname,
      '@frontend': new URL('./src/frontend', import.meta.url).pathname
    }
  },
  server: { port: 5173, proxy: { '/api': 'http://localhost:8787', '/health': 'http://localhost:8787' } }
});

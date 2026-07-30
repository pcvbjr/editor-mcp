import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'client',
  plugins: [react()],
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:3030',
      '/v1': 'http://127.0.0.1:3030',
      '/healthz': 'http://127.0.0.1:3030',
      '/mcp': 'http://127.0.0.1:3030',
    },
  },
});

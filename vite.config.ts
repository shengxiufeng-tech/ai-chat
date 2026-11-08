import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const serverPort = Number(process.env.PORT || 8787);

export default defineConfig({
  root: 'web',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': `http://127.0.0.1:${serverPort}`,
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
});

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { loadConfig } from './server/config.mjs';

export default defineConfig(() => {
  const target = `http://127.0.0.1:${loadConfig().port}`;
  return {
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: { '/api': target, '/assets/images': target },
  },
  build: { outDir: 'dist', sourcemap: false },
  };
});

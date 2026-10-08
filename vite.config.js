import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(() => {
  const target = process.env.BACKEND_URL || 'http://127.0.0.1:3210';
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

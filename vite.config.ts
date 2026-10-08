import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// base: './' 让构建产物可以部署到任意子路径（静态网站部署要求）
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    target: 'es2020',
    sourcemap: true,
    assetsInlineLimit: 8192,
  },
  server: {
    port: 5173,
    // Windows 上频繁编辑时原生 fs.watch 会 EBUSY，改用轮询
    watch: { usePolling: true, interval: 700 },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});

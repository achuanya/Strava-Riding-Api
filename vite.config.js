import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // 允许通过 IP 访问
    port: 3000, // 使用 3000 端口
    open: true // 启动后自动打开浏览器
  },
});

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Vite 配置：开启 /api 代理方便本地联调后端
export default defineConfig({
  plugins: [react()],
  build: {
    // 关闭 Vite 默认注入的 modulepreload 内联 polyfill，
    // 保证 dist/index.html 无内联脚本，生产 CSP 可用纯 'self'（无 nonce / unsafe-*）
    modulePreload: { polyfill: false },
  },
  server: {
    // 宿主机 Vite dev server 监听 8080（与 dev 后端 8001 配套；生产 nginx 容器已停用）
    port: 8080,
    // 后端容器映射到宿主机 8001（soar-backend-dev，uvicorn --reload 热重载），
    // 因此本机开发时 /api 代理须指向 8001，否则请求超时、页面加载不出数据。
    proxy: {
      // ws: true 让 /api 前缀的 WebSocket 升级请求同样走代理（通知实时推送通道）
      '/api': { target: 'http://localhost:8001', changeOrigin: true, ws: true },
    },
  },
})

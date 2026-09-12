import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  cacheDir: "node_modules/.vite-skyboard",
  optimizeDeps: {
    exclude: ["maplibre-gl"],
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || "127.0.0.1",
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: {
      // 必须忽略 src-tauri。否则 Vite 会递归监听 src-tauri/target 下的构建产物
      // （实测 16032 个路径，占启动期全部 watch 调用的 99%），
      // 而其中 debug/deps/*.dll 正被 cargo 的链接器独占，Windows 上给这种文件
      // 建 fs.watch 会抛 EBUSY。Vite 的 ignorePermissionErrors 只吞 EPERM/EACCES，
      // 不吞 EBUSY，于是它变成 FSWatcher 上的未处理 error 事件，
      // 把 dev server 直接打崩 → 表现为 "beforeDevCommand terminated"。
      // 前端只吃 src/ 与 index.html，忽略整个 src-tauri 不影响 HMR。
      // .workbuddy 是项目记忆目录，同样不会被前端引用。
      ignored: ["**/src-tauri/**", "**/.workbuddy/**"],
    },
  },
});

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;
const require = createRequire(import.meta.url);

/**
 * MapLibre GL v6 的 worker 是独立 ESM 文件（maplibre-gl-worker.mjs + maplibre-gl-shared.mjs），
 * 包内部用 `new URL(...)` 引用，Vite 打包不会把它复制进 dist，导致生产包地图空白。
 * 这里显式把两个文件同时提供给 dev server 与构建产物，src/main.tsx 里 setWorkerUrl 指过来即可。
 */
function maplibreWorker(): Plugin {
  const distDir = dirname(require.resolve("maplibre-gl/dist/maplibre-gl-worker.mjs"));
  const files = ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"];
  return {
    name: "maplibre-worker-assets",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const name = request.url?.split("?")[0].replace(/^\//, "");
        if (!name || !files.includes(name)) return next();
        try {
          response.setHeader("Content-Type", "text/javascript");
          response.end(readFileSync(resolve(distDir, name)));
        } catch {
          next();
        }
      });
    },
    generateBundle() {
      for (const name of files) {
        this.emitFile({ type: "asset", fileName: name, source: readFileSync(resolve(distDir, name), "utf-8") });
      }
    },
  };
}

/**
 * XFlySim 开放接口在请求带 Origin/Referer 时直接 403，浏览器无法直连。
 * 这里把 /xapi 反代到 api.xflysim.com，并在转发前剥掉来源头。
 */
function xflyProxy() {
  return {
    target: process.env.VITE_XFLY_TARGET?.trim() || "https://api.xflysim.com",
    changeOrigin: true,
    secure: true,
    rewrite: (path: string) => path.replace(/^\/xapi/, ""),
    configure: (proxy: { on: (event: string, handler: (proxyReq: { removeHeader: (name: string) => void }) => void) => void }) => {
      proxy.on("proxyReq", (proxyReq) => {
        proxyReq.removeHeader("origin");
        proxyReq.removeHeader("referer");
      });
    },
  };
}

/**
 * ATIS View 的 NOTAM 接口没有 CORS 头，且 Cloudflare 只放行浏览器 UA。
 * 反代时保留浏览器 UA，只把 Host 换成目标域；`/natis` 仅替换成目标前缀，
 * 因为前端拼的完整路径已经是 `/api/v1/notams?...`。
 */
function atisviewProxy() {
  return {
    target: "https://atisview.com",
    changeOrigin: true,
    secure: true,
    rewrite: (path: string) => path.replace(/^\/natis/, ""),
  };
}

/**
 * aviationweather.gov 的 TAF 接口不带 CORS 头，浏览器直连会被拦。
 * `/awc` 只作为同源前缀，转发时原样保留 `/api/data/...`。
 */
function awcProxy() {
  return {
    target: "https://aviationweather.gov",
    changeOrigin: true,
    secure: true,
    rewrite: (path: string) => path.replace(/^\/awc/, ""),
  };
}

/**
 * JeppQuery 航图服务的浏览器通道。
 *
 * 桌面端由 Rust 的 `jepp_get` / `jepp_chart_pdf` 直接转发，地址与令牌都在
 * 二进制里；这里的反代只服务于 `npm run dev` / `preview` 的浏览器调试，
 * 令牌也在转发时补上，前端代码里始终只有路径。
 * 换服务只改这里（或环境变量），正式包走 `src-tauri` 侧的同名常量。
 */
function jeppProxy() {
  const target = process.env.VITE_JEPP_TARGET?.trim() || "http://jepp.cnrpg.top:8773";
  const token = process.env.VITE_JEPP_TOKEN?.trim() ?? "admin123456";
  return {
    target,
    changeOrigin: true,
    secure: false,
    rewrite: (path: string) => {
      const stripped = path.replace(/^\/jepp/, "") || "/";
      if (!token) return stripped;
      return `${stripped}${stripped.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
    },
  };
}

/**
 * vataware 的浏览器通道。
 *
 * 该站的 `/pilots/{cid}` 与 `/flights/{id}/positions` 靠 `Accept: application/json`
 * 做内容协商（不带就回 HTML 页面），且响应没有 CORS 头，浏览器只能同源反代。
 * 桌面端走 Rust 的 `api_proxy`（自带 `Accept: application/json, ...`），不需要这里。
 */
function vatawareProxy() {
  return {
    target: "https://vataware.net",
    changeOrigin: true,
    secure: true,
    rewrite: (path: string) => path.replace(/^\/vata/, ""),
    headers: { Accept: "application/json" },
  };
}

export default defineConfig({
  plugins: [react(), maplibreWorker()],
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
    proxy: { "/xapi": xflyProxy(), "/natis": atisviewProxy(), "/awc": awcProxy(), "/jepp": jeppProxy(), "/vata": vatawareProxy() },
    watch: {
      // 必须忽略 src-tauri。否则 Vite 会递归监听 src-tauri/target 下的构建产物
      // （实测 16032 个路径，占启动期全部 watch 调用的 99%），
      // 而其中 debug/deps/*.dll 正被 cargo 的链接器独占，Windows 上给这种文件
      // 建 fs.watch 会抛 EBUSY。Vite 的 ignorePermissionErrors 只吞 EPERM/EACCES，
      // 不吞 EBUSY，于是它变成 FSWatcher 上的未处理 error 事件，
      // 把 dev server 直接打崩 → 表现为 "beforeDevCommand terminated"。
      // 前端只吃 src/ 与 index.html，忽略整个 src-tauri 不影响 HMR。
      // .workbuddy 是项目记忆目录，同样不会被前端引用。
      //
      // 这里同时给 glob 和正则：chokidar 的 anymatch 在 Windows 上对 `**/x/**`
      // 这类 glob 依赖路径分隔符归一化，给的是 `G:\...\src-tauri\...` 时可能匹配不上；
      // 正则 `[\\/]` 两种分隔符都认，压住这条差异。dist 是构建产物，一并忽略。
      ignored: ["**/src-tauri/**", "**/.workbuddy/**", "**/dist/**", /[\\/](src-tauri|\.workbuddy|dist)[\\/]/],
    },
  },
  preview: {
    port: 4173,
    strictPort: true,
    proxy: { "/xapi": xflyProxy(), "/natis": atisviewProxy(), "/awc": awcProxy(), "/jepp": jeppProxy(), "/vata": vatawareProxy() },
  },
});

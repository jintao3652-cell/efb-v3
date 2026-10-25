import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { setWorkerUrl } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./styles.css";
import App from "./App";
import { AppErrorBoundary } from "./components/common/AppErrorBoundary";
import { getNavigationDatabaseStatus, isTauri } from "./lib/tauri";

// 打包后的 worker 由 vite.config.ts 的 maplibreWorker 插件输出到根目录，
// 必须在创建任何地图实例之前指定，否则 MapLibre 会去找未打进去的相对路径。
setWorkerUrl("/maplibre-gl-worker.mjs");

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 60_000 } } });

createRoot(document.getElementById("root")!).render(
  <StrictMode><AppErrorBoundary><QueryClientProvider client={queryClient}><BrowserRouter><App /></BrowserRouter></QueryClientProvider></AppErrorBoundary></StrictMode>,
);

if (isTauri()) void queryClient.prefetchQuery({ queryKey: ["navigation-database"], queryFn: getNavigationDatabaseStatus, retry: 0 });

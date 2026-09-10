import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import "maplibre-gl/dist/maplibre-gl.css";
import "./styles.css";
import App from "./App";
import { AppErrorBoundary } from "./components/common/AppErrorBoundary";
import { getNavigationDatabaseStatus, isTauri } from "./lib/tauri";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 60_000 } } });

createRoot(document.getElementById("root")!).render(
  <StrictMode><AppErrorBoundary><QueryClientProvider client={queryClient}><BrowserRouter><App /></BrowserRouter></QueryClientProvider></AppErrorBoundary></StrictMode>,
);

if (isTauri()) void queryClient.prefetchQuery({ queryKey: ["navigation-database"], queryFn: getNavigationDatabaseStatus, retry: 0 });

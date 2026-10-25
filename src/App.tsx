import { lazy, Suspense } from "react";
import { Route, Routes } from "react-router-dom";
import { AppShell } from "./components/layout/AppShell";

const MapPage = lazy(() => import("./pages/MapPage").then((module) => ({ default: module.MapPage })));
const ChartsPage = lazy(() => import("./pages/ChartsPage").then((module) => ({ default: module.ChartsPage })));
const WeatherPage = lazy(() => import("./pages/WeatherPage").then((module) => ({ default: module.WeatherPage })));
const DispatchPage = lazy(() => import("./pages/DispatchPage").then((module) => ({ default: module.DispatchPage })));
const AirportsPage = lazy(() => import("./pages/AirportsPage").then((module) => ({ default: module.AirportsPage })));
const SettingsPage = lazy(() => import("./pages/SettingsPage").then((module) => ({ default: module.SettingsPage })));

export default function App() {
  return <Suspense fallback={<div className="app-loading">正在加载…</div>}>
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<MapPage />} />
        <Route path="charts" element={<ChartsPage />} />
        <Route path="weather" element={<WeatherPage />} />
        <Route path="dispatch" element={<DispatchPage />} />
        <Route path="airports" element={<AirportsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<MapPage />} />
      </Route>
    </Routes>
  </Suspense>;
}

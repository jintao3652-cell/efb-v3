import { lazy, Suspense } from "react";
import { Route, Routes } from "react-router-dom";
import { AppShell } from "./components/layout/AppShell";

const OverviewPage = lazy(() => import("./pages/OverviewPage").then((module) => ({ default: module.OverviewPage })));
const MapPage = lazy(() => import("./pages/MapPage").then((module) => ({ default: module.MapPage })));
const FlightPlansPage = lazy(() => import("./pages/FlightPlansPage").then((module) => ({ default: module.FlightPlansPage })));
const AirportsPage = lazy(() => import("./pages/AirportsPage").then((module) => ({ default: module.AirportsPage })));
const ChartsPage = lazy(() => import("./pages/ChartsPage").then((module) => ({ default: module.ChartsPage })));
const WeatherPage = lazy(() => import("./pages/WeatherPage").then((module) => ({ default: module.WeatherPage })));
const SettingsPage = lazy(() => import("./pages/SettingsPage").then((module) => ({ default: module.SettingsPage })));

export default function App() {
  return <Suspense fallback={<div className="app-loading">正在加载 EFB 模块…</div>}><Routes><Route element={<AppShell />}>
    <Route index element={<OverviewPage />} />
    <Route path="map" element={<MapPage />} />
    <Route path="flight-plans" element={<FlightPlansPage />} />
    <Route path="airports" element={<AirportsPage />} />
    <Route path="charts" element={<ChartsPage />} />
    <Route path="weather" element={<WeatherPage />} />
    <Route path="settings" element={<SettingsPage />} />
  </Route></Routes></Suspense>;
}

import { invoke } from "@tauri-apps/api/core";
import type { FlightPlan, FlightRoutePoint, WeatherReport } from "../types";

export interface AiracCycle {
  cycleId: string;
  cycleStartDate: string;
  provider: string;
}

export interface SimBriefFlight {
  username: string;
  callsign: string;
  departure: string;
  arrival: string;
  alternate?: string;
  route: string;
  aircraft: string;
  cruiseAltitude: string;
  scheduledOut: string;
  routePoints: FlightRoutePoint[];
}

export interface NavigationMapPoint {
  ident: string;
  name: string;
  icao: string;
  iata: string;
  kind: string;
  latitude: number;
  longitude: number;
}

export interface NavigationAirway {
  name: string;
  coordinates: Array<[number, number]>;
}

export interface NavigationMapData {
  airports: NavigationMapPoint[];
  navaids: NavigationMapPoint[];
  airways: NavigationAirway[];
}

export interface MapViewport {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface ChartFoxChart {
  id: string;
  title: string;
  chartType: string;
  url: string;
}

export interface LocalChartLibraryStatus {
  ready: boolean;
  path?: string;
  sourceType?: "folder" | "zip";
  airportCount: number;
  chartCount: number;
  message: string;
}

export interface LocalChart {
  id: string;
  airport: string;
  title: string;
  category: "机场" | "进场" | "离场" | "航路";
  revision: string;
}

export interface NavigationDatabaseStatus {
  source: "lnm" | "fenix";
  databasePath?: string;
  ready: boolean;
  airacCycle?: string;
  message: string;
}

export interface NavigationAirport {
  icao: string;
  iata: string;
  name: string;
  city: string;
  elevation: string;
  latitude: number;
  longitude: number;
}

export interface NavigationAirportDetails {
  runways: string[];
  frequencies: Array<{ name: string; value: string }>;
}

export const isTauri = () => "__TAURI_INTERNALS__" in window;

export async function listFlightPlans(): Promise<FlightPlan[]> {
  if (!isTauri()) return [];
  return invoke<FlightPlan[]>("list_flight_plans");
}

export async function saveFlightPlan(plan: FlightPlan): Promise<FlightPlan> {
  if (!isTauri()) return plan;
  return invoke<FlightPlan>("save_flight_plan", { plan });
}

export async function getWeather(station: string): Promise<WeatherReport> {
  if (!isTauri()) throw new Error("天气服务仅在桌面应用中可用");
  return invoke<WeatherReport>("get_weather", { station });
}

export async function clearCache(): Promise<void> {
  if (!isTauri()) return;
  await invoke("clear_chart_cache");
}

export async function cacheChartPdf(sourcePath: string, chartId: string): Promise<string> {
  if (!isTauri()) throw new Error("航图缓存仅在桌面应用中可用");
  return invoke<string>("cache_chart_pdf", { sourcePath, chartId });
}

export async function getCurrentAiracCycle(): Promise<AiracCycle> {
  if (!isTauri()) throw new Error("AIRAC 检测仅在桌面应用中可用");
  return invoke<AiracCycle>("get_current_airac_cycle");
}

export async function importSimBriefFlight(username: string): Promise<SimBriefFlight> {
  if (!isTauri()) throw new Error("SimBrief 导入仅在桌面应用中可用");
  return invoke<SimBriefFlight>("import_simbrief_flight", { username });
}

export async function listChartFoxCharts(icao: string): Promise<ChartFoxChart[]> {
  if (!isTauri()) throw new Error("ChartFox 查询仅在桌面应用中可用");
  return invoke<ChartFoxChart[]>("list_chartfox_charts", { icao });
}

export async function getLocalChartLibraryStatus(): Promise<LocalChartLibraryStatus> {
  if (!isTauri()) return { ready: false, airportCount: 0, chartCount: 0, message: "浏览器模式不支持本地航图库" };
  return invoke<LocalChartLibraryStatus>("get_local_chart_library_status");
}

export async function setLocalChartLibrary(path: string): Promise<LocalChartLibraryStatus> {
  if (!isTauri()) throw new Error("本地航图库仅在桌面应用中可用");
  return invoke<LocalChartLibraryStatus>("set_local_chart_library", { path });
}

export async function listLocalCharts(): Promise<LocalChart[]> {
  if (!isTauri()) return [];
  return invoke<LocalChart[]>("list_local_charts");
}

export async function openLocalChart(chartId: string): Promise<string> {
  if (!isTauri()) throw new Error("本地航图库仅在桌面应用中可用");
  return invoke<string>("open_local_chart", { chartId });
}

export async function getNavigationDatabaseStatus(): Promise<NavigationDatabaseStatus> {
  if (!isTauri()) throw new Error("导航数据库仅在桌面应用中可用");
  return invoke<NavigationDatabaseStatus>("get_navigation_database_status");
}

export async function setNavigationDatabase(source: "lnm" | "fenix", databasePath?: string): Promise<NavigationDatabaseStatus> {
  if (!isTauri()) throw new Error("导航数据库仅在桌面应用中可用");
  return invoke<NavigationDatabaseStatus>("set_navigation_database", { source, databasePath });
}

export async function searchNavigationAirports(query: string): Promise<NavigationAirport[]> {
  if (!isTauri()) return [];
  return invoke<NavigationAirport[]>("search_navigation_airports", { query });
}

export async function getNavigationAirportDetails(icao: string): Promise<NavigationAirportDetails> {
  if (!isTauri()) return { runways: [], frequencies: [] };
  return invoke<NavigationAirportDetails>("get_navigation_airport_details", { icao });
}

export async function getNavigationMapData(viewport: MapViewport): Promise<NavigationMapData> {
  if (!isTauri()) return { airports: [], navaids: [], airways: [] };
  return invoke<NavigationMapData>("get_navigation_map_data", { west: viewport.west, south: viewport.south, east: viewport.east, north: viewport.north });
}

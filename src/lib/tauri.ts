import { invoke } from "@tauri-apps/api/core";
import type { FlightPlan, FlightRoutePoint, WeatherReport } from "../types";
import { fetchJsonWithRetry } from "./network-cache";

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
  symbol?: string;
  latitude: number;
  longitude: number;
}

export interface NavigationAirway {
  name: string;
  airwayType: string;
  routeType: string;
  direction: string;
  coordinates: Array<[number, number]>;
  legs: Array<{
    coordinates: [[number, number], [number, number]];
    direction: string;
    minimumAltitude: number | null;
    maximumAltitude: number | null;
  }>;
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
  zoom: number;
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

export interface NavigationProcedureSummary {
  id: number;
  name: string;
  runways: string[];
  transitions: string[];
}

export interface NavigationAirportProcedures {
  source: "lnm" | "fenix";
  ready: boolean;
  message: string;
  sids: NavigationProcedureSummary[];
  stars: NavigationProcedureSummary[];
}

export interface XflyAirportData {
  gates: Array<{ id: number; gateRef: string; gateType: string; latitude: number; longitude: number }>;
  frequencies: Array<{ id: string; airportIdent: string; description: string; frequencyType: string; frequencyMhz: string }>;
  runways: Array<{ id: string; airportIdent: string; leIdent: string; heIdent: string; lengthFt: string; widthFt: string; surface: string; leLatitudeDeg: string; leLongitudeDeg: string; heLatitudeDeg: string; heLongitudeDeg: string; closed: string }>;
  charts: Array<{ id: string; indexNumber: string; name: string; category: string; revisionDate: string; imageDayUrl: string; imageNightUrl: string; thumbDayUrl: string; thumbNightUrl: string }>;
  source: string;
  unavailable: string[];
  cached: boolean;
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

export async function getWeather(station: string, preferCache = false): Promise<WeatherReport> {
  if (!isTauri()) throw new Error("天气服务仅在桌面应用中可用");
  return invoke<WeatherReport>("get_weather", { station, preferCache });
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

export async function getNavigationAirportProcedures(icao: string): Promise<NavigationAirportProcedures> {
  if (!isTauri()) return { source: "lnm", ready: false, message: "浏览器模式不支持本地 SID/STAR 数据", sids: [], stars: [] };
  return invoke<NavigationAirportProcedures>("get_navigation_airport_procedures", { icao });
}

export async function getNavigationProcedurePoints(procedureId: number, runway?: string, transition?: string): Promise<FlightRoutePoint[]> {
  if (!isTauri()) return [];
  return invoke<FlightRoutePoint[]>("get_navigation_procedure_points", { procedureId, runway, transition });
}

export async function getNavigationMapData(viewport: MapViewport): Promise<NavigationMapData> {
  if (!isTauri()) return { airports: [], navaids: [], airways: [] };
  return invoke<NavigationMapData>("get_navigation_map_data", { west: viewport.west, south: viewport.south, east: viewport.east, north: viewport.north, zoom: viewport.zoom });
}

export async function getXflyAirportData(icao: string, preferCache = false): Promise<XflyAirportData> {
  if (isTauri()) return invoke<XflyAirportData>("get_xfly_airport_data", { icao, preferCache });
  const endpoint = async <T,>(name: string) => (await fetchJsonWithRetry<{ data: T }>(`https://api.xflysim.com/pilot/api/efb/${name}/${icao}`, { timeoutMs: 12_000, retries: 1 })).data;
  const results = await Promise.allSettled([endpoint<XflyAirportData["gates"]>("gates"), endpoint<XflyAirportData["frequencies"]>("frequency"), endpoint<XflyAirportData["runways"]>("runway"), endpoint<XflyAirportData["charts"]>("charts")]);
  const labels = ["机位", "频率", "跑道", "航图"];
  const unavailable = results.flatMap((result, index) => result.status === "rejected" ? [labels[index]] : []);
  return {
    gates: results[0].status === "fulfilled" ? results[0].value : [],
    frequencies: results[1].status === "fulfilled" ? results[1].value : [],
    runways: results[2].status === "fulfilled" ? results[2].value : [],
    charts: results[3].status === "fulfilled" ? results[3].value : [],
    source: unavailable.length ? "XFlySim 部分在线数据" : "XFlySim 在线",
    unavailable,
    cached: false,
  };
}

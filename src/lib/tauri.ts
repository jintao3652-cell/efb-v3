import { invoke } from "@tauri-apps/api/core";
import type { FlightPlan, FlightRoutePoint, NotamReport, WeatherReport } from "../types";
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

/** 报告点类别（Jeppesen ENROUTE-7 图例键 §28）。后端接入前恒为 undefined。 */
export type ReportingPointKind = "compulsory" | "non-compulsory" | "fly-over";

export interface NavigationMapPoint {
  ident: string;
  name: string;
  icao: string;
  iata: string;
  kind: string;
  symbol?: string;
  reporting?: ReportingPointKind;
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
    /** 航段高度层：L=低空 H=高空 B=双层；LNM 数据源为空串。 */
    level: string;
    minimumAltitude: number | null;
    maximumAltitude: number | null;
  }>;
}

/** 等待航线（Jeppesen SYMBOLS-8, ROUTES & AIRWAYS — Holding Patterns）。 */
export interface NavigationHoldingPattern {
  ident: string;
  name: string;
  inboundCourse?: number | null;
  /** "L" 左转 / "R" 右转 */
  turnDirection?: string | null;
  latitude: number;
  longitude: number;
}

/** Grid MORA 网格单元（Jeppesen ENROUTE-7 §14）。altitudeFeet 为 null 表示 "Unsurveyed"。 */
export interface NavigationMoraCell {
  latitude: number;
  longitude: number;
  altitudeFeet: number | null;
  /** 精度存疑，显示时数值后加 "±" */
  doubtful?: boolean;
}

/** 特殊空域面（Jeppesen SYMBOLS-3, AIRSPACE & BOUNDARIES）。 */
export interface NavigationSpecialUseAirspace {
  id: string;
  name: string;
  airspaceType: string;
  lowerLimit?: string | null;
  upperLimit?: string | null;
  coordinates: Array<[number, number]>;
}

export interface NavigationMapData {
  airports: NavigationMapPoint[];
  navaids: NavigationMapPoint[];
  airways: NavigationAirway[];
  /** 以下三类后端在数据源接入前不返回（空集时字段缺省）。 */
  holdingPatterns?: NavigationHoldingPattern[];
  moraCells?: NavigationMoraCell[];
  specialUseAirspace?: NavigationSpecialUseAirspace[];
}

export interface MapViewport {
  west: number;
  south: number;
  east: number;
  north: number;
  zoom: number;
}

export interface OsmAirportGroundResponse {
  elements?: Array<{
    type: "node" | "way";
    id: number;
    lat?: number;
    lon?: number;
    tags?: Record<string, string>;
    geometry?: Array<{ lat: number; lon: number }>;
  }>;
}

export interface ChartFoxChart {
  id: string;
  title: string;
  chartType: string;
  url: string;
}

export interface ChartFoxAsset {
  path: string;
  mediaType: "application/pdf" | "image";
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
  /** 图号（Charts.csv 的 PAGE_NUMBER，如 0C-01） */
  revision: string;
  /** Charts.csv 的 ChartName：机场图 / RWY03 这类人读名称 */
  name?: string;
  /** Charts.csv 的 ChartTypeEx_CH：标准仪表进场图 / 仪表进近图_ILS */
  chartType?: string;
}

/** 导航数据库格式：LNM / Fenix 旧库 / Navigraph DFD v2（后端按表结构自动识别） */
export type NavigationDatabaseSource = "lnm" | "fenix" | "dfdv2";

export interface NavigationDatabaseStatus {
  source: NavigationDatabaseSource;
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
  source: NavigationDatabaseSource;
  ready: boolean;
  message: string;
  sids: NavigationProcedureSummary[];
  stars: NavigationProcedureSummary[];
  approaches: NavigationProcedureSummary[];
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

export type NavigraphChart = XflyAirportData["charts"][number];

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

export async function getNotams(station: string): Promise<NotamReport> {
  if (!isTauri()) throw new Error("NOTAM 服务仅在桌面应用中可用");
  return invoke<NotamReport>("get_notams", { station });
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

export async function openChartFoxChart(icao: string, chartId: string): Promise<ChartFoxAsset> {
  if (!isTauri()) throw new Error("ChartFox 航图缓存仅在桌面应用中可用");
  return invoke<ChartFoxAsset>("open_chartfox_chart", { icao, chartId });
}

export async function getLocalChartLibraryStatus(): Promise<LocalChartLibraryStatus> {
  if (!isTauri()) return { ready: false, airportCount: 0, chartCount: 0, message: "浏览器模式不支持本地航图库" };
  return invoke<LocalChartLibraryStatus>("get_local_chart_library_status");
}

/* ------------------------------------------------- NAIP 数据包（AD_HP / 班机航路） */

/** AD_HP.csv 的一行：坐标给的是原始度分秒串，由前端统一解析。 */
export interface NaipAirport {
  icao: string;
  name: string;
  iata: string;
  international: boolean;
  latitudeRaw: string;
  longitudeRaw: string;
  elevation: string;
}

/** FLIGHT_AIRLINE.csv 的一行：CAAC 批准的班机航路。 */
export interface NaipRoute {
  id: string;
  name: string;
  departure: string;
  arrival: string;
  /** 已去掉首尾机场码，可直接提交给 FSD。 */
  route: string;
  /** 拼进航路串的航段数；为 0 表示航段表里没这条航路的数据。 */
  legs: number;
  distanceNm: number | null;
  /** CSV 的 Routes 原文（中文描述），供用户对照。 */
  description: string;
}

export interface NaipStatus {
  root: string | null;
  airportFile: string | null;
  routeFile: string | null;
  pointFile: string | null;
  airportCount: number;
  routeCount: number;
  airportMessage: string;
  routeMessage: string;
}

/** 本地数据包里的机场（含中文名）。未配置数据包时抛错，由调用方回退内置 CSV。 */
export async function getLocalAirports(): Promise<NaipAirport[]> {
  if (!isTauri()) throw new Error("本地机场库仅在桌面应用中可用");
  return invoke<NaipAirport[]>("get_local_airports");
}

/** 按起降场查班机航路；浏览器模式没有本地数据包，返回空列表。 */
export async function searchFlightRoutes(dep: string, arr: string, limit = 24): Promise<NaipRoute[]> {
  if (!isTauri()) return [];
  return invoke<NaipRoute[]>("search_flight_routes", { dep, arr, limit });
}

/** 班机航路的航点解析结果：航点来自 FLIGHT_AIRLINE_POINT.csv，坐标查本地导航库。 */
export interface NaipRoutePoints {
  /** 航段端点总数（含起降衔接点）。 */
  total: number;
  /** 按航段顺序排好的航点（只含有坐标的）。 */
  points: FlightRoutePoint[];
  /** 导航库与机场库都没查到坐标的标识。 */
  missing: string[];
  /** 解析过程的提示（如导航库不可用）。 */
  note: string;
}

/**
 * 班机航路的航路点：**不走 XFS**——后端直接解析 FLIGHT_AIRLINE_POINT.csv 的
 * 航段端点序列，坐标查本地导航库（DFD v2 / LNM / Fenix）+ AD_HP 机场兜底。
 */
export async function getNaipRoutePoints(routeId: string): Promise<NaipRoutePoints> {
  if (!isTauri()) throw new Error("班机航路航点解析仅在应用内可用");
  return invoke<NaipRoutePoints>("get_naip_route_points", { routeId });
}

export async function getNaipStatus(): Promise<NaipStatus> {
  if (!isTauri()) {
    return {
      root: null, airportFile: null, routeFile: null, pointFile: null, airportCount: 0, routeCount: 0,
      airportMessage: "浏览器模式不读本地数据包", routeMessage: "浏览器模式不读本地数据包",
    };
  }
  return invoke<NaipStatus>("get_naip_status");
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

export async function setNavigationDatabase(source: NavigationDatabaseSource, databasePath?: string): Promise<NavigationDatabaseStatus> {
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
  if (!isTauri()) return { source: "lnm", ready: false, message: "浏览器模式不支持本地 SID/STAR 数据", sids: [], stars: [], approaches: [] };
  return invoke<NavigationAirportProcedures>("get_navigation_airport_procedures", { icao });
}

export async function getNavigationProcedurePoints(procedureId: number, runway?: string, transition?: string): Promise<FlightRoutePoint[]> {
  if (!isTauri()) return [];
  return invoke<FlightRoutePoint[]>("get_navigation_procedure_points", { procedureId, runway, transition });
}

export async function getNavigationRunwayThreshold(icao: string, runway: string): Promise<FlightRoutePoint | null> {
  if (!isTauri()) return null;
  return invoke<FlightRoutePoint | null>("get_navigation_runway_threshold", { icao, runway });
}

/** 跑道一端（DFD v2 的 tbl_pg_runways 每端一行）。 */
export interface NavigationRunwayEnd {
  ident: string;
  latitude: number;
  longitude: number;
}

/** 程序对应跑道的两端；对端缺坐标时 reciprocal 为 null，前端只标阈值。 */
export interface NavigationRunwayEnds {
  runway: string;
  primary: NavigationRunwayEnd;
  reciprocal: NavigationRunwayEnd | null;
}

/** 画出程序跑道 + 自动框选用的两端坐标。 */
export async function getNavigationRunwayEnds(icao: string, runway: string): Promise<NavigationRunwayEnds | null> {
  if (!isTauri()) return null;
  return invoke<NavigationRunwayEnds | null>("get_navigation_runway_ends", { icao, runway });
}

export async function getNavigationMapData(viewport: MapViewport): Promise<NavigationMapData> {
  if (!isTauri()) return { airports: [], navaids: [], airways: [] };
  return invoke<NavigationMapData>("get_navigation_map_data", { west: viewport.west, south: viewport.south, east: viewport.east, north: viewport.north, zoom: viewport.zoom });
}

export async function getOsmAirportGround(bounds: { west: number; south: number; east: number; north: number }): Promise<OsmAirportGroundResponse> {
  if (!isTauri()) throw new Error("OSM 桌面代理仅在桌面应用中可用");
  return invoke<OsmAirportGroundResponse>("get_osm_airport_ground", bounds);
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

export async function getXflyChartThumbnail(chartId: string, revisionDate: string, sourceUrls: string[]): Promise<string> {
  if (!isTauri()) throw new Error("航图缩略图缓存仅在桌面应用中可用");
  return invoke<string>("get_xfly_chart_thumbnail", { chartId, revisionDate, sourceUrls });
}

export async function listNavigraphCharts(icao: string): Promise<NavigraphChart[]> {
  if (isTauri()) return invoke<NavigraphChart[]>("list_navigraph_charts", { icao });
  return (await fetchJsonWithRetry<{ data: NavigraphChart[] }>(`https://api.xflysim.com/pilot/api/efb/charts/${icao}`, { timeoutMs: 12_000, retries: 1 })).data;
}

export async function getXflyChartImage(chartId: string, revisionDate: string, sourceUrls: string[]): Promise<string> {
  if (!isTauri()) throw new Error("航图图片缓存仅在桌面应用中可用");
  return invoke<string>("get_xfly_chart_image", { chartId, revisionDate, sourceUrls });
}

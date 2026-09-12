import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import * as maplibregl from "maplibre-gl";
import type { Map as MapLibreMap, StyleSpecification } from "maplibre-gl";
import { Crosshair, Layers, Map as MapIcon, Minus, PanelRightClose, PanelRightOpen, Plane, Plus, RotateCcw, Ruler, Satellite, X } from "lucide-react";
import { FlightPlanPanel } from "../components/map/FlightPlanPanel";
import { ControllerDetailPanel } from "../components/map/ControllerDetailPanel";
import { loadAdHpAirports } from "../lib/airport-data";
import { aircraftIconId, ensureAircraftIcons } from "../lib/aircraft-icons";
import { airportBarIconId, atcBarOrder, collectAirportStations, ensureAirportBarIcon, ensureAtcIcons, stationLabel, trackAtisStaleness, withVariants, type AtcIconLetter } from "../lib/atc-icons";
import { activeCallsignList, applyActiveFirControllers, applyActiveTraconControllers, applyActiveVatGlassesControllers, expandDuplicatedControllers, loadFirBoundaries, loadSectorDefinitions, loadTraconBoundaries, loadVatGlassesDataset, loadVatsimSnapshot, vatGlassesCoveredStations, type VatsimController, type VatsimPilot } from "../lib/airspace";
import { registerChartSymbols } from "../lib/chart-symbols";
import { airports } from "../lib/data";
import { loadOsmAirportGround, normalizeAirportGroundBounds } from "../lib/osm-airport";
import { useAppStore } from "../stores/app-store";
import { useFlightPlanStore, updateFlightPlan } from "../stores/flight-plan-store";
import { getNavigationAirportProcedures, getNavigationDatabaseStatus, getNavigationMapData, getNavigationProcedurePoints, getNavigationRunwayThreshold, getWeather, getXflyAirportData, listFlightPlans, saveFlightPlan, searchNavigationAirports, type MapViewport, type NavigationAirport, type NavigationMapData, type NavigationMapPoint, type NavigationProcedureSummary, type ReportingPointKind } from "../lib/tauri";
import { procedureSupportsRunway } from "../lib/route-procedures";
import type { Airport, FlightPlan, FlightPlanAirportPanelData, FlightPlanData, FlightRoutePoint } from "../types";

type LayerKey = "route" | "terminalWaypoints" | "airports" | "airportGround" | "fir" | "onlineControl" | "atcIcons" | "traffic" | "weather";
type AirwayLevel = "all" | "high" | "low";

const layerOptions: Array<{ key: LayerKey; label: string }> = [
  { key: "route", label: "航路显示" }, { key: "terminalWaypoints", label: "终端航路点" }, { key: "airports", label: "机场显示" }, { key: "airportGround", label: "机场地面设施（OSM）" }, { key: "fir", label: "FIR / UIR 边界" },
  // 「显示在线管制」= VATGlasses 高精度扇区 + SimAware 进近边界，两个数据源合并成一个开关：
  // 航路席位（CTR/FSS）与进近塔台席位（APP/DEP/TWR）都只在「有席位在线」时才画。
  { key: "onlineControl", label: "显示在线管制" },
  // VATSIM Radar 式机场站位徽标：A=ATIS D=DEL G=GND T=TWR（含多席位变体 / stale ATIS / VG 合成）。
  { key: "atcIcons", label: "ATC 站位图标" },
  { key: "traffic", label: "VATSIM 实时交通" }, { key: "weather", label: "天气雷达" },
];
const mapLayerIds: Record<LayerKey, string[]> = {
  route: ["navigation-airways", "navigation-airway-labels", "navigation-airway-directions", "navigation-airway-distances", "navigation-airway-altitudes", "navigation-navaids", "navigation-navaid-labels", "flight-airport-halo", "flight-airport-points", "flight-airport-labels"],
  terminalWaypoints: ["navigation-waypoints", "navigation-waypoint-labels"],
  airports: ["navigation-airports", "navigation-airports-always", "navigation-airport-labels"], fir: ["fir-fill", "fir-line", "fir-labels"],
  onlineControl: ["control-fill", "control-casing", "control-line", "control-labels"],
  atcIcons: ["atc-icons", "atc-icon-labels", "atc-compact-bars", "atc-compact-labels"],
  airportGround: ["osm-apron-fill", "osm-apron-line", "osm-terminal-fill", "osm-terminal-line", "osm-runway-casing", "osm-runway-line", "osm-taxiway-casing", "osm-taxiway-line", "osm-runway-name-labels", "osm-taxiway-name-labels", "osm-stand-points", "osm-stand-labels"],
  traffic: ["traffic-points", "traffic-labels"], weather: ["weather-radar"],
};
const staticFallbackAirports: NavigationMapPoint[] = airports.map((airport) => ({ ident: airport.icao, icao: airport.icao, iata: airport.iata, name: airport.name, kind: "机场", latitude: airport.latitude, longitude: airport.longitude }));
const fallbackNavaids: NavigationMapPoint[] = [
  { ident: "RENOB", name: "RENOB", icao: "", iata: "", kind: "航路点", latitude: 39.2, longitude: 117.2 },
  { ident: "POU", name: "POU", icao: "", iata: "", kind: "航路点", latitude: 37.5, longitude: 118.2 },
  { ident: "DUMET", name: "DUMET", icao: "", iata: "", kind: "航路点", latitude: 34.8, longitude: 119.6 },
];
type RoutePoint = { ident: string; name: string; latitude: number; longitude: number };
type FlightAirportPoint = RoutePoint & { role: "DEP" | "ARR" | "ALTN" };
const emptyRoutePoints: FlightRoutePoint[] = [];
const mapboxToken = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN?.trim();
const openWeatherKey = import.meta.env.VITE_OPENWEATHER_API_KEY?.trim();
const standardMapProvider = mapboxToken ? "Mapbox · OpenStreetMap" : "OpenStreetMap contributors";
const satelliteMapProvider = mapboxToken ? "Mapbox Satellite" : "Esri World Imagery";
const initialViewport: MapViewport = { west: 73, south: 18, east: 135, north: 54, zoom: 4.5 };
const airportGroundLoadZoom = 10;
let lastAutoFittedPlanKey = "";
const baseMapStyle: StyleSpecification = {
  version: 8,
  sources: {
    "base-standard": mapboxToken ? { type: "raster", tiles: [`https://api.mapbox.com/styles/v1/mapbox/navigation-night-v1/tiles/512/{z}/{x}/{y}?access_token=${mapboxToken}`], tileSize: 512, attribution: "© Mapbox © OpenStreetMap" } : { type: "raster", tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"], tileSize: 256, attribution: "© OpenStreetMap contributors" },
    "base-satellite": mapboxToken ? { type: "raster", tiles: [`https://api.mapbox.com/styles/v1/mapbox/satellite-streets-v12/tiles/512/{z}/{x}/{y}?access_token=${mapboxToken}`], tileSize: 512, attribution: "© Mapbox © OpenStreetMap" } : { type: "raster", tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"], tileSize: 256, attribution: "© Esri, Maxar, Earthstar Geographics" },
  },
  layers: [{ id: "base-standard", type: "raster", source: "base-standard" }, { id: "base-satellite", type: "raster", source: "base-satellite", layout: { visibility: "none" } }],
};

function emptyFeatures() { return { type: "FeatureCollection" as const, features: [] }; }
// Navigraph Charts overview 轨道配色：每条「程序×过渡」轨道取一色，暗底上可辨且互不混淆。
const PROCEDURE_TRACK_COLORS = ["#a62639", "#d97a2b", "#1f9e89", "#7c4bc7", "#3568d4", "#b53d7e", "#c9432e", "#2e8b57", "#8a6d1f", "#44509e", "#b0562b", "#16788c"];
// 点击扇区取席位的图层优先级：在线管制的扇区叠在 FIR 之上，所以先问它们，
// 命中即返回，避免「点某个进近扇区却选中整片 FIR」。
// control 各图层自身已按 active 过滤，fir-line 恒显（无管制时只画边界），故仍需再确认一次 active。
const sectorClickLayers = ["control-fill", "control-casing", "control-line", "fir-fill", "fir-line"];
function sectorCallsignsAt(instance: MapLibreMap, point: maplibregl.PointLike) {
  for (const layerId of sectorClickLayers) {
    if (!instance.getLayer(layerId)) continue;
    const hit = instance.queryRenderedFeatures(point, { layers: [layerId] }).find((feature) => feature.properties?.active === true);
    if (hit) return activeCallsignList(hit.properties);
  }
  return [];
}
function distinctPointLabel(ident: string, name: string, fallback = "") { const normalizedIdent = ident.trim(); const normalizedName = name.trim(); if (!normalizedIdent) return normalizedName || fallback; return normalizedName && normalizedName.toUpperCase() !== normalizedIdent.toUpperCase() ? `${normalizedIdent} · ${normalizedName}` : normalizedIdent; }
function labelForPoint(point: NavigationMapPoint) { return point.icao ? `${point.icao}${point.iata ? ` / ${point.iata}` : ""}` : distinctPointLabel(point.ident, point.name, point.kind); }
// ENROUTE-7 §28 把报告点分成「强制（screened 填充）」与「非强制（空心）」，
// SYMBOLS-8 的 Fly Over Fix 则是在定位点外再套一个圆。
// 该映射只作用于航路点（四角星）与交汇点（三角形）这两类报告点，
// 导航台符号不受影响。
function reportingSymbolVariant(symbol: string, reporting?: ReportingPointKind) {
  if (!reporting) return symbol;
  const star = symbol === "waypoint" || symbol === "waypoint-compulsory" || symbol === "waypoint-flyover";
  const fix = symbol === "intersection" || symbol === "intersection-compulsory" || symbol === "intersection-flyover";
  if (!star && !fix) return symbol;
  const root = star ? "waypoint" : "intersection";
  if (reporting === "fly-over") return `${root}-flyover`;
  if (reporting === "compulsory") return `${root}-compulsory`;
  return root;
}

function coordinateText(value: number, axis: "lat" | "lon") {
  const hemisphere = axis === "lat" ? (value >= 0 ? "N" : "S") : value >= 0 ? "E" : "W";
  const absolute = Math.abs(value);
  const degrees = Math.floor(absolute);
  const minutes = (absolute - degrees) * 60;
  return `${hemisphere}${String(degrees).padStart(axis === "lon" ? 3 : 2, "0")}°${minutes.toFixed(1).padStart(4, "0")}′`;
}
// Navigraph §4.2 步骤 8：点击航图上的要素在角部查看详情（detail view）。
type MapPointDetail = { label: string; name: string; kind: string; longitude: number; latitude: number };
// 程序预览虚线（Navigraph §4.3：未选用的建议程序以虚线显示，Visual overview 全部展开）。
type ProcedurePreviewKey = { phase: "sid" | "star" | "approach"; name: string };

function chartSymbolForPoint(point: NavigationMapPoint) {
  // 后端已按 Jeppesen/Navigraph 的 NAVAIDS 分类下发 symbol
  // （dme / tacan / vortac / vor-dme / vor / ndb / waypoint / intersection / airport-ifr / airport-vfr），
  // 这里只兜底本地静态数据：机场→IFR 齿轮，航路点→星形，NDB→点状圆，其余导航台→六边形 VOR。
  const symbol = point.symbol
    ?? (point.kind === "机场" ? "airport-ifr" : point.kind === "航路点" ? "waypoint" : point.kind === "NDB" ? "ndb" : "vor");
  return reportingSymbolVariant(symbol, point.reporting);
}
function pointsAsFeatures(points: NavigationMapPoint[], routePoints: RoutePoint[] = []) { return { type: "FeatureCollection" as const, features: points.map((point) => ({ type: "Feature" as const, properties: { label: labelForPoint(point), code: point.icao ? `${point.icao}${point.iata ? ` / ${point.iata}` : ""}` : point.ident, name: point.name || point.kind, ident: point.ident, kind: point.kind, symbol: chartSymbolForPoint(point), routePoint: routePoints.length > 0 && routeRequiresWaypoint(point, routePoints) }, geometry: { type: "Point" as const, coordinates: [point.longitude, point.latitude] } })) }; }
// 航路级别 → 高空/低空/双层。J=Jet（高空）、V=Victor（低空）是 LNM 数据源的
// 类型值；H/L/B 是 Fenix AirwayLegs.Level 的原值。对应 Jeppesen 图例
// Airway Designator 的 ENRT-H / ENRT-L / ENRT-H-L 行。
function airwayLevel(airwayType: string) { return airwayType === "J" || airwayType === "H" ? "high" : airwayType === "V" || airwayType === "L" ? "low" : airwayType === "B" ? "both" : "unknown"; }
// 设计代号按 Jeppesen 图例排布：字母前缀 + 空格 + 编号（+ 后缀），
// 如 V102 → "V 102"、J804R → "J 804R"、UA14 → "UA 14"（对应图例 V 102 / J 225R / U 571）。
function airwayDesignator(name: string) { return name.replace(/^([A-Z]+)(?=\d)/, "$1 "); }
function airwaysAsFeatures(data: NavigationMapData) { return { type: "FeatureCollection" as const, features: data.airways.map((airway) => ({ type: "Feature" as const, properties: { name: airwayDesignator(airway.name), airwayLevel: airwayLevel(airway.airwayType), routeType: airway.routeType, rnav: airway.routeType === "R" }, geometry: { type: "LineString" as const, coordinates: airway.coordinates } })) }; }
function airwayLegsAsFeatures(data: NavigationMapData) { return { type: "FeatureCollection" as const, features: data.airways.flatMap((airway) => airway.legs.map((leg) => ({ type: "Feature" as const, properties: { name: airwayDesignator(airway.name), airwayLevel: airwayLevel(leg.level || airway.airwayType), direction: leg.direction, directionMarker: leg.direction === "F" ? "▶" : leg.direction === "B" ? "◀" : "", distance: `${Math.max(1, Math.round(distanceInNm(leg.coordinates)))} NM`, minimumAltitude: leg.minimumAltitude && leg.minimumAltitude < 99_999 ? `MEA ${leg.minimumAltitude}` : "" }, geometry: { type: "LineString" as const, coordinates: leg.coordinates } }))) }; }
// 终端程序航段显示：RF（Radius to Fix）在 prev→该点之间绕 arcCenter 画圆弧（取短弧，
// 圆弧半径只有几海里，平面近似足够）；CA/CR/CD/VA/VI 等纯航向腿是 Rust 侧按航向
// 外推的展示点（courseOnly），单独成段画虚线，与真实航迹区分。
function arcIntermediateCoordinates(from: FlightRoutePoint, to: FlightRoutePoint, center: [number, number]) {
  const cosCenterLatitude = Math.cos((center[0] * Math.PI) / 180);
  const angleOf = (latitude: number, longitude: number) => Math.atan2((longitude - center[1]) * cosCenterLatitude, latitude - center[0]);
  const start = angleOf(from.latitude, from.longitude);
  let sweep = angleOf(to.latitude, to.longitude) - start;
  while (sweep > Math.PI) sweep -= 2 * Math.PI;
  while (sweep < -Math.PI) sweep += 2 * Math.PI;
  const radius = Math.hypot((from.longitude - center[1]) * cosCenterLatitude, from.latitude - center[0]);
  if (!Number.isFinite(radius) || radius <= 0 || sweep === 0) return [];
  const steps = Math.max(8, Math.ceil((Math.abs(sweep) / Math.PI) * 24));
  const coordinates: Array<[number, number]> = [];
  for (let step = 1; step < steps; step += 1) {
    const theta = start + (sweep * step) / steps;
    const latitude = center[0] + radius * Math.cos(theta);
    coordinates.push([center[1] + (radius * Math.sin(theta)) / Math.cos((latitude * Math.PI) / 180), latitude]);
  }
  return coordinates;
}
// 航线阶段：决定线色（SID 粉 / STAR 绿 / 进近 橙 / 巡航 紫）。
type RoutePhase = "sid" | "enroute" | "star" | "approach";
type PhaseRoutePoint = FlightRoutePoint & { routePhase: RoutePhase };
function simbriefRouteFeatures(points: Array<FlightRoutePoint & { routePhase?: RoutePhase }>, connectors: Array<{ from: RoutePoint; to: RoutePoint }> = []) {
  if (points.length < 2 && !connectors.length) return { type: "FeatureCollection" as const, features: [] };
  const segments: Array<{ kind: "route" | "course" | "connector"; phase: RoutePhase; coordinates: Array<[number, number]> }> = [];
  let runPhase: RoutePhase = points[0]?.routePhase ?? "enroute";
  let run: Array<[number, number]> = points.length ? [[points[0].longitude, points[0].latitude]] : [];
  const flush = () => { if (run.length > 1) segments.push({ kind: "route", phase: runPhase, coordinates: run }); run = []; };
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const phase = current.routePhase ?? "enroute";
    if (current.courseOnly) {
      flush();
      segments.push({ kind: "course", phase, coordinates: [[previous.longitude, previous.latitude], [current.longitude, current.latitude]] });
      run = [[current.longitude, current.latitude]];
      runPhase = phase;
      continue;
    }
    // 阶段切换处断开分段（保留上一点作为新段起点，保证线连续），各段独立着色。
    if (phase !== runPhase) { flush(); run = [[previous.longitude, previous.latitude]]; runPhase = phase; }
    const arc = current.arcCenter ? arcIntermediateCoordinates(previous, current, current.arcCenter) : [];
    run.push(...arc, [current.longitude, current.latitude]);
  }
  flush();
  // 无程序侧的机场连接线：单独成段，走虚线图层，不与实线航迹混接。
  for (const connector of connectors) {
    if (samePosition(connector.from, connector.to)) continue;
    segments.push({ kind: "connector", phase: "enroute", coordinates: [[connector.from.longitude, connector.from.latitude], [connector.to.longitude, connector.to.latitude]] });
  }
  return { type: "FeatureCollection" as const, features: segments.map((segment) => ({ type: "Feature" as const, properties: { kind: segment.kind, phase: segment.phase }, geometry: { type: "LineString" as const, coordinates: segment.coordinates } })) };
}
function simbriefPointFeatures(points: Array<{ ident: string; name: string; latitude: number; longitude: number }>) { return { type: "FeatureCollection" as const, features: points.map((point) => ({ type: "Feature" as const, properties: { label: distinctPointLabel(point.ident, point.name) }, geometry: { type: "Point" as const, coordinates: [point.longitude, point.latitude] } })) }; }
function flightAirportFeatures(points: FlightAirportPoint[]) { return { type: "FeatureCollection" as const, features: points.map((point) => ({ type: "Feature" as const, properties: { role: point.role, code: `${point.role} · ${point.ident}`, name: point.name && point.name.toUpperCase() !== point.ident.toUpperCase() ? point.name : "" }, geometry: { type: "Point" as const, coordinates: [point.longitude, point.latitude] } })) }; }
function samePosition(first: RoutePoint | undefined, second: RoutePoint | undefined) { return Boolean(first && second && Math.abs(first.latitude - second.latitude) < .00001 && Math.abs(first.longitude - second.longitude) < .00001); }
function appendRouteSegment<T extends RoutePoint>(points: T[], segment: T[]) { for (const point of segment) if (!samePosition(points.at(-1), point)) points.push(point); }
function mapRoutePoints(plan: FlightPlan, departureThreshold?: FlightRoutePoint, arrivalThreshold?: FlightRoutePoint): PhaseRoutePoint[] {
  const base = plan.routePoints ?? [];
  const departure = base.find((point) => point.ident.trim().toUpperCase() === plan.departure.trim().toUpperCase());
  const arrival = base.find((point) => point.ident.trim().toUpperCase() === plan.arrival.trim().toUpperCase());
  const enroute = base.filter((point) => point !== departure && point !== arrival);
  const sidPoints = plan.sid?.points ?? [];
  const starPoints = plan.star?.points ?? [];
  const approachPoints = plan.approach?.points ?? [];
  // 有程序时航迹直接从跑道门槛起终，机场标志不连进航线（连接需求交给 routeConnectors 虚线）；
  // 查不到门槛就从程序首末点开始。每点带 routePhase，供 simbriefRouteFeatures 分段着色。
  const points: PhaseRoutePoint[] = [];
  if (sidPoints.length) {
    if (departureThreshold) points.push({ ...departureThreshold, routePhase: "sid" });
    appendRouteSegment(points, sidPoints.map((point) => ({ ...point, routePhase: "sid" as const })));
  }
  appendRouteSegment(points, enroute.map((point) => ({ ...point, routePhase: "enroute" as const })));
  // 到达侧只有「完整程序」（STAR + 进近）才一路画到跑道门槛；
  // 只有 STAR（或只有进近没有衔接）时止于程序末点，机场衔接交给 routeConnectors 虚线连机场标志。
  if (approachPoints.length) {
    if (starPoints.length) appendRouteSegment(points, starPoints.map((point) => ({ ...point, routePhase: "star" as const })));
    appendRouteSegment(points, approachPoints.map((point) => ({ ...point, routePhase: "approach" as const })));
    if (arrivalThreshold) appendRouteSegment(points, [{ ...arrivalThreshold, routePhase: "approach" }]);
  } else if (starPoints.length) {
    appendRouteSegment(points, starPoints.map((point) => ({ ...point, routePhase: "star" as const })));
  }
  return points;
}
function fitRouteBounds(instance: MapLibreMap, points: RoutePoint[], duration: number) {
  if (points.length < 2) return;
  const bounds = new maplibregl.LngLatBounds();
  let previousLongitude = points[0].longitude;
  for (const point of points) {
    let longitude = point.longitude;
    while (longitude - previousLongitude > 180) longitude -= 360;
    while (longitude - previousLongitude < -180) longitude += 360;
    bounds.extend([longitude, point.latitude]);
    previousLongitude = longitude;
  }
  instance.fitBounds(bounds, { padding: { top: 70, bottom: 70, left: 70, right: 300 }, duration, maxZoom: 9 });
}
// 飞机按机型显示对应的 SVG 图标（src/ACF-ICONS，机头朝上），heading 直接作 icon-rotate（0=北，顺时针）。
function trafficAsFeatures(pilots: VatsimPilot[]) { return { type: "FeatureCollection" as const, features: pilots.filter((pilot) => Number.isFinite(pilot.latitude) && Number.isFinite(pilot.longitude)).map((pilot) => ({ type: "Feature" as const, properties: { callsign: pilot.callsign, heading: pilot.heading, icon: aircraftIconId(pilot.flight_plan?.aircraft_short) }, geometry: { type: "Point" as const, coordinates: [pilot.longitude, pilot.latitude] } })) }; }
function pilotRegistration(pilot: VatsimPilot) { return pilot.flight_plan?.remarks.match(/(?:^|\s)REG\/([A-Z0-9-]+)/i)?.[1]?.toUpperCase() ?? "未提供"; }
function flightRules(value?: string) { return value === "I" ? "IFR" : value === "V" ? "VFR" : value || "未知"; }
function storedVatGlassesDataset() { try { return localStorage.getItem("skyboard-vatglasses-dataset") || "z"; } catch { return "z"; } }
// 初始真方位角（TT）：大圆航线上从起点看向终点的方位，0-360。
function bearingInDeg(from: [number, number], to: [number, number]) { const radians = (value: number) => value * Math.PI / 180; const lat1 = radians(from[1]); const lat2 = radians(to[1]); const deltaLon = radians(to[0] - from[0]); const y = Math.sin(deltaLon) * Math.cos(lat2); const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon); return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360; }
function distanceInNm(points: Array<[number, number]>) { const radians = (value: number) => value * Math.PI / 180; return points.slice(1).reduce((total, point, index) => { const previous = points[index]; const a = Math.sin(radians(point[1] - previous[1]) / 2) ** 2 + Math.cos(radians(previous[1])) * Math.cos(radians(point[1])) * Math.sin(radians(point[0] - previous[0]) / 2) ** 2; return total + 3440.065 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)); }, 0); }
function isCoordinateWaypoint(point: NavigationMapPoint) {
  if (point.kind !== "航路点") return false;
  const normalize = (value: string) => value.trim().toUpperCase().replace(/[°'"\s()[\]]/g, "");
  const coordinatePatterns = [
    /^[NS]\d{2,6}(?:\.\d+)?[EW]\d{3,7}(?:\.\d+)?$/,
    /^\d{2,4}(?:\.\d+)?[NS]\d{3,5}(?:\.\d+)?[EW]$/,
    /^\d{2}[NS]\d{3}[EW]$/,
    /^\d{2}[NS]\d{2,3}$/,
    /^[NS]?[-+]?\d{1,2}(?:\.\d+)?[,/_-][EW]?[-+]?\d{1,3}(?:\.\d+)?$/,
    /^(?:LAT|LL|COORD)[-_:/]?[NS]?\d/,
  ];
  const isCoordinateValue = (value: string) => coordinatePatterns.some((pattern) => pattern.test(value));
  const ident = normalize(point.ident);
  const name = normalize(point.name);
  return isCoordinateValue(ident) || ((!ident || /^\d+$/.test(ident)) && isCoordinateValue(name));
}
function routeRequiresWaypoint(point: NavigationMapPoint, routePoints: Array<{ ident: string; latitude: number; longitude: number }>) {
  const ident = point.ident.trim().toUpperCase();
  return routePoints.some((routePoint) => (ident && routePoint.ident.trim().toUpperCase() === ident) || (Math.abs(routePoint.latitude - point.latitude) <= .015 && Math.abs(routePoint.longitude - point.longitude) <= .015));
}
function validAirportIcao(value?: string) { return Boolean(value && /^[A-Z0-9]{4}$/.test(value.trim().toUpperCase())); }
function exactAirport(results: NavigationAirport[] | undefined, icao: string) { return results?.find((airport) => airport.icao.trim().toUpperCase() === icao); }
function panelAirport(icao: string, databaseAirport: NavigationAirport | undefined, catalog: Map<string, Airport>, vfr: boolean): FlightPlanAirportPanelData {
  const local = catalog.get(icao);
  return { icao, iata: databaseAirport?.iata || local?.iata || "", name: databaseAirport?.name || local?.name || icao, city: databaseAirport?.city || local?.city || "", vfr, metar: "" };
}
function approachCharts(data: Awaited<ReturnType<typeof getXflyAirportData>> | undefined) {
  // 先剔除离场航图再匹配进近：「TULSI 3E & 2Q RNAV DEPS」这类离场图名字里带 RNAV，
  // 不排除会被误收进 Approaches available 列表。
  return [...new Set(data?.charts.filter((chart) => !/\bDEPS?\b|DEPARTURE|离场/i.test(`${chart.category} ${chart.name}`)).filter((chart) => /(?:APPROACH|\bAPP\b|\bIAC\b|ILS|RNP|RNAV|进近)/i.test(`${chart.category} ${chart.name}`)).map((chart) => chart.name.trim()).filter(Boolean) ?? [])];
}

type MapDataState = "idle" | "loading" | "ready" | "warning" | "error";

function MapDataRow({ label, detail, state }: { label: string; detail: string; state: MapDataState }) {
  return <div className={`map-data-row ${state}`}><i /><span><strong>{label}</strong><small>{detail}</small></span></div>;
}

function cachedSourceLabel(meta?: { source: "network" | "cache"; stale: boolean }) {
  if (!meta) return "";
  if (meta.source === "network") return "网络";
  return meta.stale ? "缓存回退" : "本地缓存";
}

function normalizeNavigationViewport(viewport: MapViewport): MapViewport {
  const step = viewport.zoom >= 10 ? 0.02 : viewport.zoom >= 7 ? 0.1 : 0.5;
  const lower = (value: number) => Number((Math.floor(value / step) * step).toFixed(3));
  const upper = (value: number) => Number((Math.ceil(value / step) * step).toFixed(3));
  return { west: lower(viewport.west), south: lower(viewport.south), east: upper(viewport.east), north: upper(viewport.north), zoom: Math.floor(viewport.zoom * 2) / 2 };
}

export function MapPage() {
  const { mapStyle, setMapStyle } = useAppStore();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const flightPlanPanel = useFlightPlanStore((state) => state.data);
  const flightPlanPanelHidden = useFlightPlanStore((state) => state.hidden);
  const setFlightPlanPanel = useFlightPlanStore((state) => state.setFlightPlan);
  const setFlightPlanPanelHidden = useFlightPlanStore((state) => state.setHidden);
  const unloadFlightPlanPanel = useFlightPlanStore((state) => state.unloadFlightPlan);
  const clearFlightPlanPanel = useFlightPlanStore((state) => state.clearFlightPlan);
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const measureModeRef = useRef(false);
  const measurePointsRef = useRef<Array<[number, number]>>([]);
  const moveTimeout = useRef<number | undefined>(undefined);
  const [layersOpen, setLayersOpen] = useState(true);
  const [mapReady, setMapReady] = useState(false);
  const [measureMode, setMeasureMode] = useState(false);
  const [measureDistance, setMeasureDistance] = useState(0);
  const [measureLive, setMeasureLive] = useState<{ bearing: number; distance: number } | null>(null);
  const [selectedCallsign, setSelectedCallsign] = useState("");
  const [selectedSectorCallsigns, setSelectedSectorCallsigns] = useState<string[]>([]);
  const [viewport, setViewport] = useState<MapViewport>(initialViewport);
  const [layers, setLayers] = useState<Record<LayerKey, boolean>>({ route: true, terminalWaypoints: false, airports: true, airportGround: true, fir: true, onlineControl: false, atcIcons: true, traffic: true, weather: false });
  const [airwayLevelFilter, setAirwayLevelFilter] = useState<AirwayLevel>("all");
  const [procedurePreview, setProcedurePreview] = useState<ProcedurePreviewKey | null>(null);
  const [selectedMapPoint, setSelectedMapPoint] = useState<MapPointDetail | null>(null);
  const procedurePointsCache = useRef(new Map<string, FlightRoutePoint[]>());
  const [vatGlassesDataset] = useState(storedVatGlassesDataset);
  const navigationLayersEnabled = layers.route || layers.terminalWaypoints || layers.airports;
  // FIR 的填充取决于「该 FIR 是否有航路席位在线」，「显示在线管制」与 ATC 站位图标
  // 也要席位快照（ATIS stale 追踪 / VG 扇区点亮推断）才能算，因此都要拉取 VATSIM 快照。
  const vatsimLayersEnabled = layers.onlineControl || layers.traffic || layers.fir || layers.atcIcons;
  const navigationViewport = useMemo(() => normalizeNavigationViewport(viewport), [viewport]);
  const airportGroundBounds = useMemo(() => normalizeAirportGroundBounds(viewport), [viewport]);
  const navigation = useQuery({ queryKey: ["navigation-database"], queryFn: getNavigationDatabaseStatus, retry: 0 });
  const navigationData = useQuery({ queryKey: ["navigation-map-data", navigation.data?.source, navigation.data?.databasePath, navigationViewport], queryFn: () => getNavigationMapData(navigationViewport), enabled: Boolean(navigation.data?.ready && navigationLayersEnabled), retry: 0, staleTime: 30_000, placeholderData: (previousData) => previousData });
  const adHp = useQuery({ queryKey: ["ad-hp-airports"], queryFn: loadAdHpAirports, staleTime: Infinity });
  const firBoundary = useQuery({ queryKey: ["vatsim-fir-boundaries"], queryFn: ({ signal }) => loadFirBoundaries(signal), enabled: layers.fir, retry: 0, staleTime: 6 * 60 * 60_000, networkMode: "always", placeholderData: (previousData) => previousData });
  const vatGlasses = useQuery({ queryKey: ["vatglasses", vatGlassesDataset], queryFn: ({ signal }) => loadVatGlassesDataset(vatGlassesDataset, undefined, signal), enabled: layers.onlineControl, retry: 0, staleTime: 24 * 60 * 60_000, networkMode: "always", placeholderData: (previousData) => previousData });
  const traconBoundary = useQuery({ queryKey: ["vatsim-tracon-boundaries"], queryFn: ({ signal }) => loadTraconBoundaries(signal), enabled: layers.onlineControl, retry: 0, staleTime: 6 * 60 * 60_000, networkMode: "always", placeholderData: (previousData) => previousData });
  const vatsim = useQuery({ queryKey: ["vatsim-live-snapshot"], queryFn: ({ signal }) => loadVatsimSnapshot(signal), enabled: vatsimLayersEnabled, retry: 0, refetchInterval: 15_000, staleTime: 12_000, networkMode: "always", placeholderData: (previousData) => previousData });
  // 扇区延长（cloning）定义表：VATPRC / 日本 / 澳新 Sectors.xml，ATIS 写了「扇区名+频率」的席位会克隆自己。
  const sectorDefinitions = useQuery({ queryKey: ["vatsim-sector-definitions"], queryFn: ({ signal }) => loadSectorDefinitions(signal), enabled: vatsimLayersEnabled, retry: 0, staleTime: 6 * 60 * 60_000, networkMode: "always", placeholderData: (previousData) => previousData });
  const airportGround = useQuery({ queryKey: ["osm-airport-ground", airportGroundBounds], queryFn: ({ signal }) => loadOsmAirportGround(airportGroundBounds, signal), enabled: layers.airportGround && viewport.zoom > airportGroundLoadZoom, retry: 0, staleTime: 30 * 60_000, networkMode: "always", placeholderData: (previousData) => previousData });
  const flightPlans = useQuery({ queryKey: ["flight-plans"], queryFn: listFlightPlans });
  const activePlan = flightPlans.data?.[0];
  const originIcao = activePlan?.departure.trim().toUpperCase() ?? "";
  const destinationIcao = activePlan?.arrival.trim().toUpperCase() ?? "";
  const alternateIcao = activePlan?.alternate?.trim().toUpperCase() ?? "";
  const originAirportSearch = useQuery({ queryKey: ["flight-panel-airport", originIcao], queryFn: () => searchNavigationAirports(originIcao), enabled: Boolean(navigation.data?.ready && validAirportIcao(originIcao)), retry: 0, staleTime: 300_000 });
  const destinationAirportSearch = useQuery({ queryKey: ["flight-panel-airport", destinationIcao], queryFn: () => searchNavigationAirports(destinationIcao), enabled: Boolean(navigation.data?.ready && validAirportIcao(destinationIcao)), retry: 0, staleTime: 300_000 });
  const alternateAirportSearch = useQuery({ queryKey: ["flight-panel-airport", alternateIcao], queryFn: () => searchNavigationAirports(alternateIcao), enabled: Boolean(navigation.data?.ready && validAirportIcao(alternateIcao)), retry: 0, staleTime: 300_000 });
  const originProcedures = useQuery({ queryKey: ["navigation-procedures", originIcao], queryFn: () => getNavigationAirportProcedures(originIcao), enabled: Boolean(navigation.data?.ready && validAirportIcao(originIcao)), retry: 0, staleTime: 300_000 });
  const destinationProcedures = useQuery({ queryKey: ["navigation-procedures", destinationIcao], queryFn: () => getNavigationAirportProcedures(destinationIcao), enabled: Boolean(navigation.data?.ready && validAirportIcao(destinationIcao)), retry: 0, staleTime: 300_000 });
  const originWeather = useQuery({ queryKey: ["weather", originIcao], queryFn: () => getWeather(originIcao), enabled: validAirportIcao(originIcao), retry: 0, staleTime: 5 * 60_000 });
  const destinationWeather = useQuery({ queryKey: ["weather", destinationIcao], queryFn: () => getWeather(destinationIcao), enabled: validAirportIcao(destinationIcao), retry: 0, staleTime: 5 * 60_000 });
  const alternateWeather = useQuery({ queryKey: ["weather", alternateIcao], queryFn: () => getWeather(alternateIcao), enabled: validAirportIcao(alternateIcao), retry: 0, staleTime: 5 * 60_000 });
  const destinationXfly = useQuery({ queryKey: ["xfly-airport", destinationIcao], queryFn: () => getXflyAirportData(destinationIcao), enabled: validAirportIcao(destinationIcao), retry: 0, staleTime: 15 * 60_000 });
  // 进近程序优先用导航库（Fenix Terminals Proc=3，可取航迹点）；导航库未就绪时退回航图标题列表。
  const navApproaches = useMemo(() => destinationProcedures.data?.approaches ?? [], [destinationProcedures.data]);
  // Navigraph §4.3 步骤 7/11：离场/进场程序建议列表（按所选跑道过滤在面板内完成）。
  const departureProcedures = useMemo(() => originProcedures.data?.ready ? originProcedures.data.sids : [], [originProcedures.data]);
  const arrivalProcedures = useMemo(() => destinationProcedures.data?.ready ? destinationProcedures.data.stars : [], [destinationProcedures.data]);
  const availableApproaches = useMemo(() => navApproaches.length ? navApproaches.map((procedure) => procedure.name) : approachCharts(destinationXfly.data), [navApproaches, destinationXfly.data]);
  const departureRunwayThreshold = useQuery({ queryKey: ["nav-runway-threshold", activePlan?.departure, activePlan?.departureRunway], queryFn: () => getNavigationRunwayThreshold(activePlan!.departure, activePlan!.departureRunway ?? ""), enabled: Boolean(activePlan?.sid && validAirportIcao(activePlan.departure) && activePlan.departureRunway), retry: 0, staleTime: 300_000 });
  const arrivalRunwayThreshold = useQuery({ queryKey: ["nav-runway-threshold", activePlan?.arrival, activePlan?.arrivalRunway], queryFn: () => getNavigationRunwayThreshold(activePlan!.arrival, activePlan!.arrivalRunway ?? ""), enabled: Boolean((activePlan?.star || activePlan?.approach) && validAirportIcao(activePlan.arrival) && activePlan.arrivalRunway), retry: 0, staleTime: 300_000 });
  const routePoints = useMemo(() => activePlan ? mapRoutePoints(activePlan, departureRunwayThreshold.data ?? undefined, arrivalRunwayThreshold.data ?? undefined) : emptyRoutePoints, [activePlan, departureRunwayThreshold.data, arrivalRunwayThreshold.data]);
  const chineseAirports = useMemo(() => new Map((adHp.data ?? []).map((airport) => [airport.icao, airport])), [adHp.data]);
  const panelAirportCatalog = useMemo(() => new Map([...airports, ...(adHp.data ?? [])].map((airport) => [airport.icao, airport])), [adHp.data]);
  const knownAirports = useMemo(() => {
    const airportLookup = new Map<string, RoutePoint>();
    const addAirport = (ident: string, name: string, latitude: number, longitude: number) => { if (ident && Number.isFinite(latitude) && Number.isFinite(longitude)) airportLookup.set(ident.trim().toUpperCase(), { ident: ident.trim().toUpperCase(), name, latitude, longitude }); };
    for (const airport of staticFallbackAirports) addAirport(airport.icao || airport.ident, airport.name, airport.latitude, airport.longitude);
    for (const airport of adHp.data ?? []) addAirport(airport.icao, airport.name, airport.latitude, airport.longitude);
    for (const airport of navigationData.data?.airports ?? []) addAirport(airport.icao || airport.ident, airport.name, airport.latitude, airport.longitude);
    return airportLookup;
  }, [adHp.data, navigationData.data?.airports]);
  const flightAirports = useMemo<FlightAirportPoint[]>(() => {
    if (!activePlan) return [];
    const resolveAirport = (ident: string, role: "DEP" | "ARR" | "ALTN") => {
      const normalized = ident.trim().toUpperCase();
      const point = activePlan.routePoints?.find((routePoint) => routePoint.ident.trim().toUpperCase() === normalized) ?? knownAirports.get(normalized);
      return point ? { ...point, ident: normalized, role } : undefined;
    };
    return [resolveAirport(activePlan.departure, "DEP"), resolveAirport(activePlan.arrival, "ARR"), resolveAirport(activePlan.alternate ?? "", "ALTN")].filter((point): point is FlightAirportPoint => Boolean(point));
  }, [activePlan, knownAirports, routePoints]);
  const completeRoutePoints = useMemo(() => {
    const points = [...routePoints];
    const departure = flightAirports.find((point) => point.role === "DEP");
    const arrival = flightAirports.find((point) => point.role === "ARR");
    if (departure && !samePosition(points[0], departure)) points.unshift(departure);
    if (arrival && !samePosition(points.at(-1), arrival)) points.push(arrival);
    return points;
  }, [flightAirports, routePoints]);
  const simbriefWaypoints = useMemo(() => routePoints.filter((point) => !point.courseOnly && !flightAirports.some((airport) => samePosition(point, airport))), [flightAirports, routePoints]);
  // 机场↔航线的连接线只在缺程序航迹的一侧补：有 SID / 进近直连跑道时航迹已从跑道门槛起终，
  // 机场标志保持独立（永远不与跑道相连）；只有 STAR 无进近等「不完整程序」的一侧，
  // 连接线连到机场标志而不是跑道门槛。
  const routeConnectors = useMemo(() => {
    const departure = flightAirports.find((point) => point.role === "DEP");
    const arrival = flightAirports.find((point) => point.role === "ARR");
    const departureThreshold = departureRunwayThreshold.data ?? undefined;
    const arrivalThreshold = arrivalRunwayThreshold.data ?? undefined;
    const first = routePoints.find((point) => !point.courseOnly);
    const last = [...routePoints].reverse().find((point) => !point.courseOnly);
    const connectors: Array<{ from: RoutePoint; to: RoutePoint }> = [];
    if (departure && first && !samePosition(first, departure) && !samePosition(first, departureThreshold)) connectors.push({ from: departure, to: first });
    if (arrival && last && !samePosition(last, arrival) && !samePosition(last, arrivalThreshold)) connectors.push({ from: last, to: arrival });
    return connectors;
  }, [arrivalRunwayThreshold.data, departureRunwayThreshold.data, flightAirports, routePoints]);
  // 「显示在线管制」把两个数据源合成一个 FeatureCollection：
  //   · VATGlasses 高精度扇区（航路 + 进近/塔台，按席位类型与站点前缀反查在线状态）
  //   · SimAware 进近边界（VATGlasses 没覆盖到的席位兜底）
  // 同一机场两边都有面时以 VATGlasses 为准，否则北京这类机场会被粗粒度大面盖住高精度分层。
  const controlCoverage = useMemo(() => {
    const controllers = expandDuplicatedControllers(vatsim.data?.controllers ?? [], sectorDefinitions.data ?? []);
    const glasses = vatGlasses.data ? applyActiveVatGlassesControllers(vatGlasses.data.features, controllers, sectorDefinitions.data ?? []) : undefined;
    const covered = vatGlassesCoveredStations(glasses);
    const simaware = traconBoundary.data ? applyActiveTraconControllers(traconBoundary.data.data, controllers) : undefined;
    const fallback = (simaware?.features ?? []).filter((feature) => {
      if (!covered.size) return true;
      const id = String(feature.properties.id ?? "").toUpperCase();
      return !covered.has(id) && !covered.has(id.split("_")[0]);
    });
    return { type: "FeatureCollection" as const, features: [...(glasses?.features ?? []), ...fallback] };
  }, [sectorDefinitions.data, traconBoundary.data, vatGlasses.data, vatsim.data?.controllers]);
  const onlineControlSectors = controlCoverage.features.filter((feature) => feature.properties.active === true).length;
  // VATSIM Radar 的 VG 模式：TWR/GND/DEL 扇区被点亮但没有对应呼号登录时，机场仍显示该类站位徽标。
  // 这里把已点亮扇区的 matchType → 机场前缀 归组，交给 collectAirportStations 合成徽标。
  const vgActiveStations = useMemo(() => {
    const byType: Partial<Record<AtcIconLetter, string[]>> = {};
    for (const feature of controlCoverage.features) {
      if (feature.properties?.active !== true) continue;
      const type = String(feature.properties.matchType ?? "").toUpperCase();
      const letter = type === "TWR" ? "T" : type === "GND" ? "G" : type === "DEL" ? "D" : undefined;
      if (!letter) continue;
      const bucket = byType[letter] ?? (byType[letter] = []);
      for (const prefix of (feature.properties.matchPrefixes as string[] | undefined) ?? []) {
        const icao = String(prefix).trim().toUpperCase();
        if (icao && !bucket.includes(icao)) bucket.push(icao);
      }
    }
    return byType;
  }, [controlCoverage]);
  // FIR 的填充只用于标示「有航路管制」，故同样需要按 VATSIM 席位打上 active 标记；
  // 边界线本身始终绘制，不随管制状态显隐。
  const firCoverage = useMemo(() => firBoundary.data ? applyActiveFirControllers(firBoundary.data.data, expandDuplicatedControllers(vatsim.data?.controllers ?? [], sectorDefinitions.data ?? [])) : undefined, [firBoundary.data, sectorDefinitions.data, vatsim.data?.controllers]);
  // 席位查找表含克隆席位（呼号不在实时快照里），点击扇区卡片才能取到详情。
  const controllersLookup = useMemo(() => {
    const expanded = expandDuplicatedControllers(vatsim.data?.controllers ?? [], sectorDefinitions.data ?? []);
    return new Map(expanded.map((controller) => [controller.callsign, controller]));
  }, [sectorDefinitions.data, vatsim.data?.controllers]);
  const selectedPilot = useMemo(() => (vatsim.data?.pilots ?? []).find((pilot) => pilot.callsign === selectedCallsign), [vatsim.data?.pilots, selectedCallsign]);
  // Stale ATIS 追踪（在线时刷新 lastSeen，下线 10 分钟内仍显示灰显徽标）。
  useEffect(() => { if (vatsim.data) trackAtisStaleness(vatsim.data.controllers); }, [vatsim.data?.controllers]);
  // ATC 站位徽标（VATSIM 在线席位 + VG 合成 + stale ATIS），落到机场坐标上。
  const atcStations = useMemo(() => {
    if (!layers.atcIcons) return [];
    const positioned = withVariants(collectAirportStations(vatsim.data?.controllers ?? [], vgActiveStations)).flatMap((station) => {
      const airport = knownAirports.get(station.icao);
      return airport ? [{ ...station, longitude: airport.longitude, latitude: airport.latitude }] : [];
    });
    return positioned;
  }, [knownAirports, layers.atcIcons, vgActiveStations, vatsim.data?.controllers]);
  // 低缩放（<8）紧凑显示（VATSIM Radar 样式）：同机场全部站位聚合成「ICAO + 颜色条」，
  // 颜色条按 T/G/D/A 顺序每类站位一段；全部为 stale 时整条半透明。
  const atcCompact = useMemo(() => {
    type CompactGroup = { longitude: number; latitude: number; letters: Set<AtcIconLetter>; callsign: string; virtual: boolean; stale: boolean };
    const groups = new Map<string, CompactGroup>();
    for (const station of atcStations) {
      const group = groups.get(station.icao) ?? { longitude: station.longitude, latitude: station.latitude, letters: new Set<AtcIconLetter>(), callsign: "", virtual: true, stale: true };
      group.letters.add(station.letter);
      // 点击目标优先真实席位（可打开管制详情卡）；全合成时才落到 VG 详情。
      const wasVirtual = group.virtual;
      if (!station.virtual) { group.virtual = false; if (!wasVirtual && group.callsign) { /* 已有真实席位目标，保留 */ } else group.callsign = station.callsign; }
      else if (!group.callsign) group.callsign = station.callsign;
      if (!station.stale) group.stale = false;
      groups.set(station.icao, group);
    }
    return [...groups.entries()].map(([icao, group]) => {
      const letters = [...group.letters].sort((first, second) => atcBarOrder.indexOf(first) - atcBarOrder.indexOf(second));
      return { icao, longitude: group.longitude, latitude: group.latitude, letters, barIcon: airportBarIconId(letters), callsign: group.callsign, virtual: group.virtual, stale: group.stale };
    });
  }, [atcStations]);
  // 被点击扇区名下的席位详情：按呼号回查实时快照（含克隆席位），取不到（已下线）就丢掉。
  const selectedSectorControllers = useMemo(() => selectedSectorCallsigns.flatMap((callsign) => { const found = controllersLookup.get(callsign); return found ? [found] : []; }), [controllersLookup, selectedSectorCallsigns]);
  const nextFlightPlanPanel = useMemo<FlightPlanData | null>(() => {
    if (!activePlan) return null;
    const approachesCount = availableApproaches.length;
    const origin = panelAirport(originIcao, exactAirport(originAirportSearch.data, originIcao), panelAirportCatalog, Boolean(originProcedures.data?.ready && originProcedures.data.sids.length === 0));
    const destination = panelAirport(destinationIcao, exactAirport(destinationAirportSearch.data, destinationIcao), panelAirportCatalog, Boolean(destinationProcedures.data?.ready && destinationProcedures.data.stars.length === 0 && approachesCount === 0));
    const alternate = alternateIcao ? { ...panelAirport(alternateIcao, exactAirport(alternateAirportSearch.data, alternateIcao), panelAirportCatalog, false), metar: alternateWeather.data?.raw ?? "" } : null;
    return {
      planId: `${activePlan.id}:${activePlan.importedAt}`,
      callsign: activePlan.callsign,
      origin: { ...origin, metar: originWeather.data?.raw ?? "", runway: activePlan.departureRunway ?? "", wind: originWeather.data?.wind ?? "", sid: activePlan.sid?.name ?? "", transition: activePlan.sid?.transition ?? "" },
      destination: { ...destination, metar: destinationWeather.data?.raw ?? "", runway: activePlan.arrivalRunway ?? "", wind: destinationWeather.data?.wind ?? "", star: activePlan.star?.name ?? "", transition: activePlan.star?.transition ?? "", approach: activePlan.approach?.name ?? "", approachesCount },
      alternate,
    };
  }, [activePlan, alternateAirportSearch.data, alternateIcao, alternateWeather.data?.raw, availableApproaches.length, destinationAirportSearch.data, destinationIcao, destinationProcedures.data, destinationWeather.data?.raw, destinationWeather.data?.wind, originAirportSearch.data, originIcao, originProcedures.data, originWeather.data?.raw, originWeather.data?.wind, panelAirportCatalog]);
  const fallbackMapData = useMemo<NavigationMapData>(() => ({ airports: (adHp.data?.length ? adHp.data : airports).map((airport) => ({ ident: airport.icao, icao: airport.icao, iata: airport.iata, name: airport.name, kind: "机场", latitude: airport.latitude, longitude: airport.longitude })), navaids: fallbackNavaids, airways: [] }), [adHp.data]);

  useEffect(() => { if (nextFlightPlanPanel) setFlightPlanPanel(nextFlightPlanPanel); else clearFlightPlanPanel(); }, [clearFlightPlanPanel, nextFlightPlanPanel, setFlightPlanPanel]);
  useEffect(() => { const frame = window.requestAnimationFrame(() => map.current?.resize()); return () => window.cancelAnimationFrame(frame); }, [flightPlanPanelHidden, flightPlanPanel?.planId]);
  // 席位下线后（快照刷新）自动收起管制卡片，避免留下一个查不到数据、只剩占位的空壳。
  useEffect(() => {
    if (!selectedSectorCallsigns.length || !vatsim.data) return;
    if (!selectedSectorCallsigns.some((callsign) => controllersLookup.has(callsign))) setSelectedSectorCallsigns([]);
  }, [controllersLookup, selectedSectorCallsigns, vatsim.data]);

  useEffect(() => {
    if (!container.current || map.current) return;
    const instance = new maplibregl.Map({ container: container.current, center: [114.8, 34.5], zoom: 4.5, style: baseMapStyle });
    // 测量 source 同时承载两类要素：折线（measurement-line 渲染）与每段中点的
    // 「方位° 距离NM」标签点（measurement-labels 渲染），line 图层会自动忽略 point 要素。
    const measurementFeatures = (points: Array<[number, number]>) => { const features: Array<GeoJSON.Feature<GeoJSON.Geometry>> = []; if (points.length > 1) features.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: points } }); for (let index = 1; index < points.length; index += 1) { const previous = points[index - 1]; const current = points[index]; features.push({ type: "Feature", properties: { label: `${String(Math.round(bearingInDeg(previous, current))).padStart(3, "0")}° ${(distanceInNm([previous, current])).toFixed(1)}NM` }, geometry: { type: "Point", coordinates: [(previous[0] + current[0]) / 2, (previous[1] + current[1]) / 2] } }); } return features; };
    const updateMeasurement = (points: Array<[number, number]>) => (instance.getSource("measurement") as maplibregl.GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: measurementFeatures(points) });
    const setPreviewGeometry = (points: Array<[number, number]> | null) => (instance.getSource("measurement-preview") as maplibregl.GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: points ? [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: points } }] : [] });
    const updateViewport = () => { const bounds = instance.getBounds(); setViewport({ west: Number(bounds.getWest().toFixed(3)), south: Number(bounds.getSouth().toFixed(3)), east: Number(bounds.getEast().toFixed(3)), north: Number(bounds.getNorth().toFixed(3)), zoom: Number(instance.getZoom().toFixed(1)) }); };
    instance.on("load", () => {
      instance.addSource("navigation-airways", { type: "geojson", data: emptyFeatures() }); instance.addSource("navigation-airway-legs", { type: "geojson", data: emptyFeatures() }); instance.addSource("navigation-airports", { type: "geojson", data: pointsAsFeatures(staticFallbackAirports) }); instance.addSource("navigation-navaids", { type: "geojson", data: pointsAsFeatures(fallbackNavaids) }); instance.addSource("simbrief-route", { type: "geojson", data: emptyFeatures() }); instance.addSource("simbrief-points", { type: "geojson", data: emptyFeatures() }); instance.addSource("flight-airports", { type: "geojson", data: emptyFeatures() }); instance.addSource("fir", { type: "geojson", data: emptyFeatures() }); instance.addSource("control", { type: "geojson", data: emptyFeatures() }); instance.addSource("osm-airport-ground", { type: "geojson", data: emptyFeatures() }); instance.addSource("traffic", { type: "geojson", data: emptyFeatures() }); instance.addSource("measurement", { type: "geojson", data: emptyFeatures() }); instance.addSource("measurement-preview", { type: "geojson", data: emptyFeatures() }); instance.addSource("procedure-preview", { type: "geojson", data: emptyFeatures() }); instance.addSource("atc-icons", { type: "geojson", data: emptyFeatures() });
      registerChartSymbols(instance);
      // FIR 填充仅在「有航路管制」时绘制；无管制时只保留 fir-line 的边界线。
      instance.addLayer({ id: "fir-fill", type: "fill", source: "fir", filter: ["==", ["get", "active"], true], paint: { "fill-color": "#ffffff", "fill-opacity": .018 } }); instance.addLayer({ id: "fir-line", type: "line", source: "fir", paint: { "line-color": "#f4f6f8", "line-width": 1.35, "line-opacity": .92 } }); instance.addLayer({ id: "fir-labels", type: "symbol", source: "fir", minzoom: 3, layout: { "text-field": ["get", "id"], "text-size": 11, "text-allow-overlap": false }, paint: { "text-color": "#ffffff", "text-halo-color": "#071827", "text-halo-width": 1.7 } });
      // 「显示在线管制」的四个图层共用一条 active 过滤：没有席位在线的扇区一律不画 ——
      // 既不出填充也不出边界线，无管制区域的边界线交给恒显的 fir-line 表达。
      // 填充与边线统一取「浅绿」一套配色（航路席位 CTR/FSS 与进近塔台 APP/DEP/TWR 同色）：
      //   fill #def1d7 —— 从参考扇区图逐像素取样，占该图填充像素 74.7%
      //   line #74bd57 —— 同一张图上边线抗锯齿后的核心色
      // 深色底图上浅绿会被压低；浅色/卫星底图上过实又会盖住地形与机场 ——
      // 透明度取 .3：底图可辨，扇区叠嵌套处自然加深。
      // 席位归属仍由 control-labels 的呼号（ZBAA_CTR / ZBAA_APP）区分，不再靠颜色区分。
      instance.addLayer({ id: "control-fill", type: "fill", source: "control", minzoom: 4, filter: ["==", ["get", "active"], true], layout: { visibility: "none" }, paint: { "fill-color": "#def1d7", "fill-opacity": .3 } });
      instance.addLayer({ id: "control-casing", type: "line", source: "control", minzoom: 4, filter: ["==", ["get", "active"], true], layout: { visibility: "none" }, paint: { "line-color": "#3d7a2a", "line-width": ["interpolate", ["linear"], ["zoom"], 4, 2.4, 9, 4.4], "line-opacity": .9 } });
      instance.addLayer({ id: "control-line", type: "line", source: "control", minzoom: 4, filter: ["==", ["get", "active"], true], layout: { visibility: "none" }, paint: { "line-color": "#74bd57", "line-width": ["interpolate", ["linear"], ["zoom"], 4, 1.4, 9, 2.6], "line-opacity": .96 } });
      instance.addLayer({ id: "control-labels", type: "symbol", source: "control", minzoom: 4.5, filter: ["==", ["get", "active"], true], layout: { visibility: "none", "text-field": ["concat", ["get", "activeCallsign"], "\n", ["get", "label"]], "text-size": ["interpolate", ["linear"], ["zoom"], 4.5, 10, 8, 13], "text-line-height": 1.25, "text-allow-overlap": false, "text-optional": true }, paint: { "text-color": ["match", ["get", "band"], "enroute", "#eaf7ff", "#e8ffdd"], "text-halo-color": "#06131d", "text-halo-width": 2 } });
      instance.addLayer({ id: "osm-apron-fill", type: "fill", source: "osm-airport-ground", minzoom: 12, filter: ["==", ["get", "kind"], "apron"], layout: { visibility: "none" }, paint: { "fill-color": "#627482", "fill-opacity": .72 } }); instance.addLayer({ id: "osm-apron-line", type: "line", source: "osm-airport-ground", minzoom: 12, filter: ["==", ["get", "kind"], "apron"], layout: { visibility: "none" }, paint: { "line-color": "#a7bbc7", "line-width": 1.2 } }); instance.addLayer({ id: "osm-terminal-fill", type: "fill", source: "osm-airport-ground", minzoom: 12, filter: ["==", ["get", "kind"], "terminal"], layout: { visibility: "none" }, paint: { "fill-color": "#263d50", "fill-opacity": .9 } }); instance.addLayer({ id: "osm-terminal-line", type: "line", source: "osm-airport-ground", minzoom: 12, filter: ["==", ["get", "kind"], "terminal"], layout: { visibility: "none" }, paint: { "line-color": "#9fc5d8", "line-width": 1.5 } }); instance.addLayer({ id: "osm-runway-casing", type: "line", source: "osm-airport-ground", minzoom: 12, filter: ["==", ["get", "kind"], "runway"], layout: { visibility: "none" }, paint: { "line-color": "#111a21", "line-width": ["interpolate", ["linear"], ["zoom"], 12, 8, 16, 28] } }); instance.addLayer({ id: "osm-runway-line", type: "line", source: "osm-airport-ground", minzoom: 12, filter: ["==", ["get", "kind"], "runway"], layout: { visibility: "none" }, paint: { "line-color": "#cbd4d9", "line-width": ["interpolate", ["linear"], ["zoom"], 12, 5, 16, 22] } }); instance.addLayer({ id: "osm-taxiway-casing", type: "line", source: "osm-airport-ground", minzoom: 12, filter: ["==", ["get", "kind"], "taxiway"], layout: { visibility: "none" }, paint: { "line-color": "#3d3011", "line-width": ["interpolate", ["linear"], ["zoom"], 12, 3, 17, 12] } }); instance.addLayer({ id: "osm-taxiway-line", type: "line", source: "osm-airport-ground", minzoom: 12, filter: ["==", ["get", "kind"], "taxiway"], layout: { visibility: "none" }, paint: { "line-color": "#f0c44e", "line-width": ["interpolate", ["linear"], ["zoom"], 12, 1.4, 17, 6] } }); instance.addLayer({ id: "osm-runway-labels", type: "symbol", source: "osm-airport-ground", minzoom: 13, filter: ["all", ["==", ["get", "kind"], "runway"], ["has", "label"]], layout: { visibility: "none", "symbol-placement": "line", "text-field": ["get", "label"], "text-size": 12, "symbol-spacing": 500 }, paint: { "text-color": "#f4f8fa", "text-halo-color": "#18242c", "text-halo-width": 2 } }); instance.addLayer({ id: "osm-taxiway-labels", type: "symbol", source: "osm-airport-ground", minzoom: 14, filter: ["all", ["==", ["get", "kind"], "taxiway"], ["has", "label"]], layout: { visibility: "none", "symbol-placement": "line", "text-field": ["get", "label"], "text-size": 11, "symbol-spacing": 220, "text-allow-overlap": false }, paint: { "text-color": "#ffe48a", "text-halo-color": "#241d0d", "text-halo-width": 2 } }); instance.addLayer({ id: "osm-stand-points", type: "circle", source: "osm-airport-ground", minzoom: 15, filter: ["in", ["get", "kind"], ["literal", ["parking_position", "gate"]]], layout: { visibility: "none" }, paint: { "circle-radius": 4, "circle-color": "#64d7ff", "circle-stroke-color": "#092334", "circle-stroke-width": 1.5 } }); instance.addLayer({ id: "osm-stand-labels", type: "symbol", source: "osm-airport-ground", minzoom: 16, filter: ["in", ["get", "kind"], ["literal", ["parking_position", "gate"]]], layout: { visibility: "none", "text-field": ["get", "label"], "text-size": 10, "text-offset": [0, 1], "text-anchor": "top" }, paint: { "text-color": "#ccefff", "text-halo-color": "#092334", "text-halo-width": 1.5 } });
      instance.addLayer({ id: "osm-runway-name-labels", type: "symbol", source: "osm-airport-ground", minzoom: 12.5, filter: ["==", ["get", "kind"], "runway-end"], layout: { visibility: "none", "text-field": ["get", "label"], "text-size": ["interpolate", ["linear"], ["zoom"], 12.5, 12, 16, 17], "text-letter-spacing": .08, "text-allow-overlap": true, "text-ignore-placement": true }, paint: { "text-color": "#58f3ff", "text-halo-color": "#071015", "text-halo-width": 2.6 } });
      instance.addLayer({ id: "osm-taxiway-name-labels", type: "symbol", source: "osm-airport-ground", minzoom: 13.2, filter: ["all", ["in", ["get", "kind"], ["literal", ["taxiway", "taxilane"]]], ["!=", ["get", "label"], ""]], layout: { visibility: "none", "symbol-placement": "line", "text-field": ["get", "label"], "text-size": ["interpolate", ["linear"], ["zoom"], 13.2, 10, 17, 15], "symbol-spacing": 125, "text-max-angle": 45, "text-rotation-alignment": "map", "text-pitch-alignment": "map", "text-keep-upright": true, "text-allow-overlap": false }, paint: { "text-color": "#f7fbff", "text-halo-color": "#071015", "text-halo-width": 2.4 } });
      for (const layerId of ["osm-apron-fill", "osm-apron-line", "osm-terminal-fill", "osm-terminal-line", "osm-runway-casing", "osm-runway-line", "osm-taxiway-casing", "osm-taxiway-line", "osm-stand-points"]) instance.setLayerZoomRange(layerId, airportGroundLoadZoom, 24);
      instance.setLayerZoomRange("osm-stand-labels", 14, 24);
      instance.setPaintProperty("osm-stand-points", "circle-radius", ["interpolate", ["linear"], ["zoom"], airportGroundLoadZoom, 3, 14, 5, 18, 7]);
      instance.setPaintProperty("osm-stand-points", "circle-color", "#12d99b");
      instance.setPaintProperty("osm-stand-points", "circle-stroke-color", "#f1fff9");
      instance.setPaintProperty("osm-stand-points", "circle-stroke-width", ["interpolate", ["linear"], ["zoom"], airportGroundLoadZoom, 1.2, 16, 2]);
      instance.setPaintProperty("osm-stand-labels", "text-color", "#12d99b");
      instance.setPaintProperty("osm-stand-labels", "text-halo-color", "#061a13");
      instance.setPaintProperty("osm-stand-labels", "text-halo-width", 1.8);
      instance.addLayer({ id: "navigation-airways", type: "line", source: "navigation-airways", paint: { "line-color": ["match", ["get", "airwayLevel"], "high", "#7ab3ff", "low", "#4a86ff", "#5f9dff"], "line-width": ["interpolate", ["linear"], ["zoom"], 4, 1, 8, 2.4], "line-opacity": .88 } });
      // 航路名按 Jeppesen 规范：低空（V/J，Negative）黑底白字、高空（U，Positive）白底黑字，
      // 用粗 halo 模拟框底。
      instance.addLayer({ id: "navigation-airway-labels", type: "symbol", source: "navigation-airways", layout: { "symbol-placement": "line", "symbol-spacing": 260, "text-field": ["get", "name"], "text-size": ["interpolate", ["linear"], ["zoom"], 3, 9, 7, 11, 11, 13], "text-letter-spacing": .08, "text-max-angle": 28, "text-rotation-alignment": "map", "text-pitch-alignment": "map", "text-keep-upright": true, "text-padding": 5, "text-allow-overlap": false, "text-ignore-placement": false, "text-optional": true }, paint: { "text-color": ["match", ["get", "airwayLevel"], "high", "#101318", "#ffffff"], "text-halo-color": ["match", ["get", "airwayLevel"], "high", "#ffffff", "#000000"], "text-halo-width": 3 } });
      instance.addLayer({ id: "navigation-airway-directions", type: "symbol", source: "navigation-airway-legs", minzoom: 6, filter: ["!=", ["get", "directionMarker"], ""], layout: { "symbol-placement": "line", "symbol-spacing": 180, "text-field": ["get", "directionMarker"], "text-size": 8, "text-rotation-alignment": "map", "text-pitch-alignment": "map", "text-keep-upright": false, "text-padding": 3, "text-allow-overlap": false, "text-ignore-placement": false, "text-optional": true }, paint: { "text-color": "#d6f5ff", "text-halo-color": "#071827", "text-halo-width": 1.3 } });
      instance.addLayer({ id: "navigation-airway-distances", type: "symbol", source: "navigation-airway-legs", minzoom: 7, layout: { "symbol-placement": "line-center", "text-field": ["get", "distance"], "text-size": 9, "text-offset": [0, 1.15], "text-rotation-alignment": "map", "text-pitch-alignment": "map", "text-keep-upright": true, "text-padding": 3, "text-allow-overlap": false, "text-ignore-placement": false, "text-optional": true }, paint: { "text-color": "#8baec1", "text-halo-color": "#071827", "text-halo-width": 1.5 } });
      instance.addLayer({ id: "navigation-airway-altitudes", type: "symbol", source: "navigation-airway-legs", minzoom: 8.5, filter: ["!=", ["get", "minimumAltitude"], ""], layout: { "symbol-placement": "line-center", "text-field": ["get", "minimumAltitude"], "text-size": 9, "text-offset": [0, -1.15], "text-rotation-alignment": "map", "text-pitch-alignment": "map", "text-keep-upright": true, "text-padding": 3, "text-allow-overlap": false, "text-ignore-placement": false, "text-optional": true }, paint: { "text-color": "#e4c987", "text-halo-color": "#071827", "text-halo-width": 1.5 } });
      instance.addLayer({ id: "navigation-waypoints", type: "symbol", source: "navigation-navaids", minzoom: 8, layout: { visibility: "none", "icon-image": ["get", "symbol"], "icon-size": ["interpolate", ["linear"], ["zoom"], 8, .58, 12, .82], "icon-allow-overlap": false, "icon-ignore-placement": false, "icon-padding": 2 }, filter: ["==", ["get", "kind"], "航路点"] });
      instance.addLayer({ id: "navigation-navaids", type: "symbol", source: "navigation-navaids", minzoom: 5, layout: { "icon-image": ["get", "symbol"], "icon-size": ["interpolate", ["linear"], ["zoom"], 5, .56, 10, .8], "icon-allow-overlap": false, "icon-ignore-placement": false, "icon-padding": 3 }, filter: ["!=", ["get", "kind"], "航路点"] });
      instance.addLayer({ id: "navigation-waypoint-labels", type: "symbol", source: "navigation-navaids", minzoom: 8.4, filter: ["all", ["==", ["get", "kind"], "航路点"], ["!=", ["get", "routePoint"], true]], layout: { visibility: "none", "text-field": ["get", "label"], "text-size": ["interpolate", ["linear"], ["zoom"], 8.4, 10, 11, 14], "text-offset": [0, 1], "text-anchor": "top", "text-allow-overlap": false, "text-optional": true }, paint: { "text-color": "#d9f3ff", "text-halo-color": "#071827", "text-halo-width": 1.4 } });
      instance.addLayer({ id: "navigation-navaid-labels", type: "symbol", source: "navigation-navaids", minzoom: 5.5, filter: ["all", ["!=", ["get", "kind"], "航路点"], ["!=", ["get", "routePoint"], true]], layout: { "text-field": ["get", "label"], "text-size": 11, "text-offset": [0, 1.15], "text-anchor": "top", "text-allow-overlap": false, "text-optional": true }, paint: { "text-color": "#bceaff", "text-halo-color": "#071827", "text-halo-width": 1.5 } });
      // 机场齿轮符号（Jeppesen：蓝 IFR / 绿 VFR）：zoom≥5 恒显（icon-allow-overlap），
      // 对齐 Navigraph——符号不参与碰撞剔除，标签自行避让；zoom<5 保持避让以免世界视图糊成一片。
      instance.addLayer({ id: "navigation-airports", type: "symbol", source: "navigation-airports", maxzoom: 5, layout: { "icon-image": ["get", "symbol"], "icon-size": ["interpolate", ["linear"], ["zoom"], 4, .55, 9, .82], "icon-allow-overlap": false, "icon-ignore-placement": false, "icon-padding": 4 } });
      instance.addLayer({ id: "navigation-airports-always", type: "symbol", source: "navigation-airports", minzoom: 5, layout: { "icon-image": ["get", "symbol"], "icon-size": ["interpolate", ["linear"], ["zoom"], 5, .6, 9, .82], "icon-allow-overlap": true, "icon-ignore-placement": true, "icon-padding": 4 } });
      // text-ignore-placement：恒显的符号不再把标签挤掉，标签之间仍互相避让。
      instance.addLayer({ id: "navigation-airport-labels", type: "symbol", source: "navigation-airports", minzoom: 5, filter: ["!=", ["get", "routePoint"], true], layout: { "text-field": ["concat", ["get", "code"], "\n", ["get", "name"]], "text-size": ["interpolate", ["linear"], ["zoom"], 5, 10, 9, 14], "text-offset": [0, 1.15], "text-anchor": "top", "text-allow-overlap": false, "text-ignore-placement": true, "text-optional": true }, paint: { "text-color": "#fff0d8", "text-halo-color": "#071827", "text-halo-width": 1.5 } });
      // 航线分段配色：SID 粉、STAR 绿、进近 橙、巡航/连接 紫。
      const routePhaseColor = ["match", ["get", "phase"], "sid", "#ff6ec7", "star", "#3ddc84", "approach", "#ffa53d", "#b07aff"] as never;
      instance.addLayer({ id: "simbrief-route-casing", type: "line", source: "simbrief-route", filter: ["==", ["get", "kind"], "route"], paint: { "line-color": "#16091c", "line-width": ["interpolate", ["linear"], ["zoom"], 4, 5, 9, 9], "line-opacity": .92 } }); instance.addLayer({ id: "simbrief-route", type: "line", source: "simbrief-route", filter: ["==", ["get", "kind"], "route"], paint: { "line-color": routePhaseColor, "line-width": ["interpolate", ["linear"], ["zoom"], 4, 2.5, 9, 4.5] } }); instance.addLayer({ id: "simbrief-route-course", type: "line", source: "simbrief-route", filter: ["in", ["get", "kind"], ["literal", ["course", "connector"]]], paint: { "line-color": routePhaseColor, "line-width": ["interpolate", ["linear"], ["zoom"], 4, 1.6, 9, 2.8], "line-dasharray": [1.2, 2.2], "line-opacity": .8 } }); instance.addLayer({ id: "simbrief-route-points", type: "circle", source: "simbrief-points", paint: { "circle-radius": 4.5, "circle-color": "#ffcf77", "circle-stroke-width": 1.5, "circle-stroke-color": "#6e1c38" } }); instance.addLayer({ id: "simbrief-route-labels", type: "symbol", source: "simbrief-points", minzoom: 5.5, layout: { "text-field": ["get", "label"], "text-size": 11, "text-offset": [0, -1.1], "text-anchor": "bottom", "text-allow-overlap": false, "text-optional": true }, paint: { "text-color": "#ffd5de", "text-halo-color": "#381020", "text-halo-width": 1.5 } });
      // DEP/ARR/ALTN 机场高亮（对齐航图截图风格）：teal 光环 + teal 实心点 + 白描边高亮环 + teal 色块白字标签。
      instance.addLayer({ id: "flight-airport-halo", type: "circle", source: "flight-airports", paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 9, 9, 14], "circle-color": "#17b3c2", "circle-opacity": .28, "circle-blur": .3 } });
      instance.addLayer({ id: "flight-airport-points", type: "circle", source: "flight-airports", paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 5.5, 9, 8.5], "circle-color": "#17b3c2", "circle-stroke-color": "#e9fdff", "circle-stroke-width": 1.8 } });
      instance.addLayer({ id: "flight-airport-ring", type: "circle", source: "flight-airports", paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 11, 9, 17], "circle-opacity": 0, "circle-stroke-color": "#5fe3ef", "circle-stroke-width": 2 } });
      instance.addLayer({ id: "flight-airport-labels", type: "symbol", source: "flight-airports", layout: { "text-field": ["format", ["get", "code"], { "font-scale": 1, "text-color": "#8ee9f4" }, ["case", ["!=", ["get", "name"], ""], ["concat", "\n", ["get", "name"]], ""], { "font-scale": .82, "text-color": "#c6dde2" }], "text-size": ["interpolate", ["linear"], ["zoom"], 3, 11, 9, 13], "text-line-height": 1.3, "text-letter-spacing": .03, "text-variable-anchor": ["top", "bottom", "left", "right"], "text-radial-offset": 1.2, "text-justify": "auto", "text-padding": 6, "text-allow-overlap": false, "text-ignore-placement": false, "text-optional": true }, paint: { "text-halo-color": "#082125", "text-halo-width": 1.6, "text-halo-blur": .4 } });
      // Navigraph §4.3 Visual overview：每条候选程序的每个过渡各画一条实线，
      // 颜色取 Navigraph 风格调色板，轨道端点挂「过渡.程序名」色底标签
      // （对齐 Charts 的 Set arrival / Set departure 视图）；
      // 点选程序名时该程序整体高亮为紫色（the procedure is highlighted as a purple line）。
      instance.addLayer({ id: "procedure-preview-line", type: "line", source: "procedure-preview", filter: ["all", ["==", ["get", "kind"], "line"], ["!=", ["get", "highlighted"], true]], layout: { "line-cap": "round" }, paint: { "line-color": ["get", "color"], "line-width": ["interpolate", ["linear"], ["zoom"], 4, 1.8, 9, 3.2], "line-opacity": .9 } });
      instance.addLayer({ id: "procedure-preview-highlight", type: "line", source: "procedure-preview", filter: ["all", ["==", ["get", "kind"], "line"], ["==", ["get", "highlighted"], true]], layout: { "line-cap": "round" }, paint: { "line-color": "#b07aff", "line-width": ["interpolate", ["linear"], ["zoom"], 4, 2.8, 9, 5] } });
      instance.addLayer({ id: "procedure-preview-labels", type: "symbol", source: "procedure-preview", filter: ["==", ["get", "kind"], "label"], minzoom: 4.5, layout: { "text-field": ["get", "name"], "text-size": 11, "text-letter-spacing": .05, "text-allow-overlap": true, "text-ignore-placement": true, "text-optional": true }, paint: { "text-color": "#ffffff", "text-halo-color": ["case", ["==", ["get", "highlighted"], true], "#8a3cf0", ["get", "color"]], "text-halo-width": 2.6, "text-halo-blur": .3 } });
      // ATC 站位徽标（A/D/G/T，VATSIM Radar 风格）：stale ATIS 半透明灰显，
      // 标签显示呼号（灰=stale、黄=真实在线）。
      instance.addLayer({ id: "atc-icons", type: "symbol", source: "atc-icons", minzoom: 8, layout: { "icon-image": ["get", "icon"], "icon-size": ["interpolate", ["linear"], ["zoom"], 8, .8, 12, 1], "icon-allow-overlap": false, "icon-ignore-placement": false, "icon-padding": 2 }, paint: { "icon-opacity": ["match", ["get", "stale"], 1, .45, 1] } });
      instance.addLayer({ id: "atc-icon-labels", type: "symbol", source: "atc-icons", minzoom: 9.5, layout: { "text-field": ["get", "label"], "text-size": 10, "text-offset": [0, 1.1], "text-anchor": "top", "text-allow-overlap": false, "text-optional": true }, paint: { "text-color": ["match", ["get", "stale"], 1, "#9fb0bd", "#ffe08a"], "text-halo-color": "#1c1403", "text-halo-width": 1.6 } });
      // 低缩放紧凑样式：ICAO 代码 + 其下颜色条（每类在线席位一段），与高缩放徽标在 zoom 8 互斥切换。
      instance.addSource("atc-compact", { type: "geojson", data: emptyFeatures() });
      instance.addLayer({ id: "atc-compact-labels", type: "symbol", source: "atc-compact", minzoom: 3, maxzoom: 8, layout: { "text-field": ["get", "icao"], "text-size": 13, "text-letter-spacing": .09, "text-anchor": "bottom", "text-offset": [0, -.5], "text-allow-overlap": true, "text-ignore-placement": true, "text-optional": true }, paint: { "text-color": "#cfd6dd", "text-halo-color": "#242a31", "text-halo-width": 1.8 } });
      instance.addLayer({ id: "atc-compact-bars", type: "symbol", source: "atc-compact", minzoom: 3, maxzoom: 8, layout: { "icon-image": ["get", "barIcon"], "icon-allow-overlap": true, "icon-ignore-placement": true, "icon-padding": 1 }, paint: { "icon-opacity": ["match", ["get", "stale"], 1, .5, 1] } });
      // 飞机按机型 SVG 顶视图渲染，机头朝上（=北），heading 直接作 icon-rotate（顺时针，与地图对齐）。
      // allow-overlap 保持旧 circle 的恒显行为；未注册的机型图标等 ensureAircraftIcons 加载完成后自动出现。
      instance.addLayer({ id: "traffic-points", type: "symbol", source: "traffic", minzoom: 3, layout: { "icon-image": ["get", "icon"], "icon-size": ["interpolate", ["linear"], ["zoom"], 3, .4, 8, .68], "icon-rotate": ["get", "heading"], "icon-rotation-alignment": "map", "icon-pitch-alignment": "map", "icon-allow-overlap": true, "icon-ignore-placement": true } }); instance.addLayer({ id: "traffic-labels", type: "symbol", source: "traffic", minzoom: 6, layout: { "text-field": ["get", "callsign"], "text-size": 10, "text-offset": [0, 1.15], "text-anchor": "top", "text-allow-overlap": false }, paint: { "text-color": "#d7ffea", "text-halo-color": "#082417", "text-halo-width": 1.5 } });
      if (openWeatherKey) { instance.addSource("weather-radar", { type: "raster", tiles: [`https://tile.openweathermap.org/map/precipitation_new/{z}/{x}/{y}.png?appid=${openWeatherKey}`], tileSize: 256, attribution: "© OpenWeather" }); instance.addLayer({ id: "weather-radar", type: "raster", source: "weather-radar", layout: { visibility: "none" }, paint: { "raster-opacity": .65, "raster-fade-duration": 0 } }); }
      instance.addLayer({ id: "measurement-line", type: "line", source: "measurement", paint: { "line-color": "#ffdc70", "line-width": 3 } });
      // 实时预览：鼠标移动时「最后一点 → 光标」的橡皮筋虚线，与已落定的实线区分。
      instance.addLayer({ id: "measurement-preview", type: "line", source: "measurement-preview", paint: { "line-color": "#ffdc70", "line-width": 2.5, "line-dasharray": [1.2, 1.8], "line-opacity": .8 } });
      // 每段中点的「方位° 距离NM」标签（真方位 TT）。
      instance.addLayer({ id: "measurement-labels", type: "symbol", source: "measurement", layout: { "text-field": ["get", "label"], "text-size": 11, "text-offset": [0, -1.05], "text-anchor": "bottom", "text-allow-overlap": true, "text-ignore-placement": true }, paint: { "text-color": "#ffdc70", "text-halo-color": "#231a02", "text-halo-width": 1.7 } });
      updateViewport(); setMapReady(true);
    });
    instance.on("click", "traffic-points", (event) => { const callsign = event.features?.[0]?.properties?.callsign; if (callsign) setSelectedCallsign(String(callsign)); });
    instance.on("mouseenter", "traffic-points", () => { instance.getCanvas().style.cursor = "pointer"; });
    instance.on("mouseleave", "traffic-points", () => { instance.getCanvas().style.cursor = measureModeRef.current ? "crosshair" : ""; });
    // Navigraph §4.2 步骤 8：点击航路点 / 导航台 / 机场图标，在角部详情卡查看该要素。
    const mapObjectLayers = ["navigation-waypoints", "navigation-navaids", "navigation-airports", "navigation-airports-always"];
    const clickablePointLayers = [...mapObjectLayers, "atc-icons", "atc-compact-bars", "atc-compact-labels"];
    // ATC 徽标点击 → 真实席位打开管制详情卡；VG 合成徽标没有呼号实体，走要素详情卡。
    // 紧凑样式（低缩放）与徽标（高缩放）共用同一套点击行为。
    const atcStationClick = (event: maplibregl.MapLayerMouseEvent) => {
      const feature = event.features?.[0];
      if (!feature) return;
      setSelectedMapPoint(null);
      if (feature.properties?.virtual === 1) {
        const geometry = feature.geometry as GeoJSON.Point;
        setSelectedSectorCallsigns([]);
        setSelectedMapPoint({ label: String(feature.properties?.callsign ?? feature.properties?.icao ?? ""), name: "VATGlasses 扇区激活，无席位登录", kind: "ATC 站位", longitude: Number(geometry.coordinates[0]), latitude: Number(geometry.coordinates[1]) });
        return;
      }
      const callsign = feature.properties?.callsign;
      if (callsign) setSelectedSectorCallsigns([String(callsign)]);
    };
    for (const layerId of ["atc-icons", "atc-compact-bars", "atc-compact-labels"]) {
      instance.on("click", layerId, atcStationClick);
      instance.on("mouseenter", layerId, () => { instance.getCanvas().style.cursor = "pointer"; });
      instance.on("mouseleave", layerId, () => { instance.getCanvas().style.cursor = measureModeRef.current ? "crosshair" : ""; });
    }
    for (const layerId of mapObjectLayers) {
      instance.on("click", layerId, (event) => {
        const feature = event.features?.[0];
        if (!feature) return;
        const geometry = feature.geometry as GeoJSON.Point;
        setSelectedSectorCallsigns([]);
        setSelectedMapPoint({ label: String(feature.properties?.label ?? feature.properties?.ident ?? ""), name: String(feature.properties?.name ?? ""), kind: String(feature.properties?.kind ?? ""), longitude: Number(geometry.coordinates[0]), latitude: Number(geometry.coordinates[1]) });
      });
      instance.on("mouseenter", layerId, () => { instance.getCanvas().style.cursor = "pointer"; });
      instance.on("mouseleave", layerId, () => { instance.getCanvas().style.cursor = measureModeRef.current ? "crosshair" : ""; });
    }
    // 点击「有管制」的 FIR / APP 扇区 → 右侧打开管制详情；点到空白处则收起。
    instance.on("click", (event) => {
      if (measureModeRef.current) return;
      // 点在航班 / 导航要素点上时交给各自的图层点击处理，避免顺手把详情卡片关掉。
      const occupiedLayers = ["traffic-points", ...clickablePointLayers].filter((layerId) => instance.getLayer(layerId));
      if (occupiedLayers.length && instance.queryRenderedFeatures(event.point, { layers: occupiedLayers }).length) return;
      setSelectedMapPoint(null);
      setSelectedSectorCallsigns(sectorCallsignsAt(instance, event.point));
    });
    // 可点击的扇区给出手型光标提示；fir-line 恒显不参与，避免无管制边界也变成可点。
    for (const layerId of ["control-fill", "control-line", "fir-fill"]) {
      instance.on("mouseenter", layerId, () => { instance.getCanvas().style.cursor = "pointer"; });
      instance.on("mouseleave", layerId, () => { instance.getCanvas().style.cursor = measureModeRef.current ? "crosshair" : ""; });
    }
    instance.on("moveend", () => { window.clearTimeout(moveTimeout.current); moveTimeout.current = window.setTimeout(updateViewport, 650); });
    instance.on("click", (event) => { if (!measureModeRef.current) return; const nextPoints: Array<[number, number]> = [...measurePointsRef.current, [event.lngLat.lng, event.lngLat.lat]]; measurePointsRef.current = nextPoints; updateMeasurement(nextPoints); setMeasureDistance(distanceInNm(nextPoints)); });
    // 测量模式下的实时橡皮筋：最后一点连到光标，卡片同步显示当前段的方位与距离。
    instance.on("mousemove", (event) => {
      if (!measureModeRef.current) return;
      const points = measurePointsRef.current;
      if (!points.length) return;
      const last = points[points.length - 1];
      const cursor: [number, number] = [event.lngLat.lng, event.lngLat.lat];
      setPreviewGeometry([last, cursor]);
      setMeasureLive({ bearing: bearingInDeg(last, cursor), distance: distanceInNm([last, cursor]) });
    });
    instance.on("mouseout", () => { if (!measureModeRef.current) return; setPreviewGeometry(null); setMeasureLive(null); });
    map.current = instance;
    return () => { window.clearTimeout(moveTimeout.current); instance.remove(); map.current = null; };
  }, []);

  useEffect(() => { measureModeRef.current = measureMode; if (map.current) map.current.getCanvas().style.cursor = measureMode ? "crosshair" : ""; }, [measureMode]);
  useEffect(() => { if (!mapReady || !map.current) return; map.current.setLayoutProperty("base-standard", "visibility", mapStyle === "standard" ? "visible" : "none"); map.current.setLayoutProperty("base-satellite", "visibility", mapStyle === "satellite" ? "visible" : "none"); }, [mapReady, mapStyle]);
  useEffect(() => { if (!mapReady || !map.current) return; for (const [key, layerIds] of Object.entries(mapLayerIds) as Array<[LayerKey, string[]]>) for (const layerId of layerIds) if (map.current.getLayer(layerId)) map.current.setLayoutProperty(layerId, "visibility", layers[key] ? "visible" : "none"); }, [layers, mapReady]);
  useEffect(() => {
    if (!mapReady || !map.current) return;
    const filter = airwayLevelFilter === "all" ? null : ["in", ["get", "airwayLevel"], ["literal", [airwayLevelFilter, "both", "unknown"]]] as never;
    for (const layerId of ["navigation-airways", "navigation-airway-labels", "navigation-airway-distances"]) map.current.setFilter(layerId, filter);
    map.current.setFilter("navigation-airway-directions", filter ? ["all", filter, ["!=", ["get", "directionMarker"], ""]] as never : ["!=", ["get", "directionMarker"], ""]);
    map.current.setFilter("navigation-airway-altitudes", filter ? ["all", filter, ["!=", ["get", "minimumAltitude"], ""]] as never : ["!=", ["get", "minimumAltitude"], ""]);
  }, [airwayLevelFilter, mapReady]);
  useEffect(() => {
    if (!mapReady || !map.current) return;
    const raw = navigation.data?.ready ? navigationData.data : fallbackMapData;
    if (!raw) return;
    const navaids = navigation.data?.source === "fenix" ? raw.navaids.filter((point) => !isCoordinateWaypoint(point) || routeRequiresWaypoint(point, routePoints)) : raw.navaids;
    const data = { ...raw, navaids, airports: raw.airports.map((airport) => { const chinese = airport.icao.startsWith("Z") ? chineseAirports.get(airport.icao) : undefined; return chinese ? { ...airport, name: chinese.name, iata: chinese.iata || airport.iata } : airport; }) };
    (map.current.getSource("navigation-airways") as maplibregl.GeoJSONSource).setData(airwaysAsFeatures(data));
    (map.current.getSource("navigation-airway-legs") as maplibregl.GeoJSONSource).setData(airwayLegsAsFeatures(data));
    (map.current.getSource("navigation-airports") as maplibregl.GeoJSONSource).setData(pointsAsFeatures(data.airports, completeRoutePoints));
    (map.current.getSource("navigation-navaids") as maplibregl.GeoJSONSource).setData(pointsAsFeatures(data.navaids, routePoints));
  }, [mapReady, navigation.data?.ready, navigation.data?.source, navigationData.data, fallbackMapData, chineseAirports, routePoints, completeRoutePoints]);
  useEffect(() => { if (!mapReady || !map.current || !firCoverage) return; (map.current.getSource("fir") as maplibregl.GeoJSONSource).setData(firCoverage as never); }, [mapReady, firCoverage]);
  useEffect(() => { if (!mapReady || !map.current) return; (map.current.getSource("control") as maplibregl.GeoJSONSource).setData(controlCoverage as never); }, [mapReady, controlCoverage]);
  useEffect(() => { if (!mapReady || !map.current) return; (map.current.getSource("osm-airport-ground") as maplibregl.GeoJSONSource).setData((airportGround.data ?? emptyFeatures()) as never); }, [mapReady, airportGround.data]);
  useEffect(() => {
    if (!mapReady || !map.current) return;
    const pilots = vatsim.data?.pilots ?? [];
    // 图标异步注册：features 先行 setData，引用未注册 icon 的点暂不渲染，注册完成 MapLibre 自动重绘。
    void ensureAircraftIcons(map.current, pilots.map((pilot) => pilot.flight_plan?.aircraft_short));
    (map.current.getSource("traffic") as maplibregl.GeoJSONSource).setData(trafficAsFeatures(pilots));
  }, [mapReady, vatsim.data?.pilots]);
  // ATC 站位徽标数据：图标一次性注册（含 booked 变体），features 随席位快照 / VG 推断刷新；
  // 低缩放紧凑样式（ICAO + 颜色条）的条形图标按需注册后写入独立 source。
  useEffect(() => {
    if (!mapReady || !map.current) return;
    void ensureAtcIcons(map.current);
    const features = atcStations.map((station) => ({ type: "Feature" as const, properties: { icon: station.icon, callsign: station.callsign, stale: station.stale ? 1 : 0, virtual: station.virtual ? 1 : 0, letter: station.letter, frequency: station.frequency, label: stationLabel(station) }, geometry: { type: "Point" as const, coordinates: [station.longitude, station.latitude] } }));
    (map.current.getSource("atc-icons") as maplibregl.GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features });
    const compactFeatures = atcCompact.map((group) => ({ type: "Feature" as const, properties: { icao: group.icao, barIcon: group.barIcon, callsign: group.callsign, stale: group.stale ? 1 : 0, virtual: group.virtual ? 1 : 0 }, geometry: { type: "Point" as const, coordinates: [group.longitude, group.latitude] } }));
    void Promise.all(atcCompact.map((group) => ensureAirportBarIcon(map.current!, group.letters)))
      .then(() => { if (map.current) (map.current.getSource("atc-compact") as maplibregl.GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: compactFeatures }); })
      .catch(() => {});
  }, [mapReady, atcStations, atcCompact]);
  useEffect(() => {
    if (!mapReady || !map.current) return;
    (map.current.getSource("simbrief-route") as maplibregl.GeoJSONSource).setData(simbriefRouteFeatures(routePoints, routeConnectors));
    (map.current.getSource("simbrief-points") as maplibregl.GeoJSONSource).setData(simbriefPointFeatures(simbriefWaypoints));
    (map.current.getSource("flight-airports") as maplibregl.GeoJSONSource).setData(flightAirportFeatures(flightAirports));
    const fitKey = activePlan ? `${activePlan.id}:${activePlan.importedAt}` : "";
    const hasDeparture = flightAirports.some((point) => point.role === "DEP");
    const hasArrival = flightAirports.some((point) => point.role === "ARR");
    if (!fitKey || lastAutoFittedPlanKey === fitKey || !hasDeparture || !hasArrival || completeRoutePoints.length < 2) return;
    lastAutoFittedPlanKey = fitKey;
    fitRouteBounds(map.current, completeRoutePoints, 900);
  }, [mapReady, routePoints, completeRoutePoints, routeConnectors, simbriefWaypoints, flightAirports, activePlan]);
  // Navigraph §4.3 程序预览：Visual overview **固定开启**——始终铺画**当前跑道**的候选程序，
  // 每条程序的每个过渡各画一条独立配色的实线，轨道过渡端挂「过渡.程序名」色底标签
  // （对齐 Charts 的 Set arrival 视图）；点程序名（步骤 7/13）把该程序整体高亮为紫色。
  // 已选用的程序由 simbrief-route 实线渲染，不重复画。
  useEffect(() => {
    if (!mapReady || !map.current) return;
    const source = map.current.getSource("procedure-preview") as maplibregl.GeoJSONSource | undefined;
    if (!source) return;
    const departureRunway = activePlan?.departureRunway ?? "";
    const arrivalRunway = activePlan?.arrivalRunway ?? "";
    const wanted: Array<{ phase: "sid" | "star" | "approach"; procedure: NavigationProcedureSummary }> = [];
    const consider = (phase: "sid" | "star" | "approach", procedure: NavigationProcedureSummary, runway: string) => {
      if (procedurePreview?.phase === phase && procedurePreview.name === procedure.name) { wanted.push({ phase, procedure }); return; }
      // 只画支持当前跑道的程序；跑道未设置时不铺线，避免全量画成蜘蛛网。
      if (!runway || !procedureSupportsRunway(procedure, runway)) return;
      wanted.push({ phase, procedure });
    };
    for (const procedure of departureProcedures) consider("sid", procedure, departureRunway);
    for (const procedure of arrivalProcedures) consider("star", procedure, arrivalRunway);
    for (const procedure of navApproaches) consider("approach", procedure, arrivalRunway);
    if (!wanted.length) { source.setData(emptyFeatures()); return; }
    // 每个「程序 × 过渡」一条轨道；程序没有过渡时退化为公共段一条（label 不带过渡前缀）。
    const combos = wanted.flatMap(({ phase, procedure }) => {
      const transitions = procedure.transitions.length ? procedure.transitions : [""];
      return transitions.map((transition) => ({ phase, procedure, transition }));
    });
    const airportAt = (phase: "sid" | "star" | "approach") => flightAirports.find((item) => item.role === (phase === "sid" ? "DEP" : "ARR"));
    let cancelled = false;
    void Promise.all(combos.map(async ({ phase, procedure, transition }, index) => {
      const runway = phase === "sid" ? departureRunway : arrivalRunway;
      const cacheKey = `${procedure.id}:${runway}:${transition}`;
      let points = procedurePointsCache.current.get(cacheKey);
      if (!points) {
        points = await getNavigationProcedurePoints(procedure.id, runway, transition).catch(() => [] as FlightRoutePoint[]);
        procedurePointsCache.current.set(cacheKey, points);
      }
      // 标签挂在轨道离机场最远的一端：STAR 的过渡入口在航路侧、SID 的在离场末端，与 Charts 一致。
      let labelPoint: FlightRoutePoint | null = points.length ? points[points.length - 1] : null;
      const airport = airportAt(phase);
      if (airport && points.length) {
        let bestDistance = -1;
        for (const point of points) {
          const distance = (point.latitude - airport.latitude) ** 2 + (point.longitude - airport.longitude) ** 2;
          if (distance > bestDistance) { bestDistance = distance; labelPoint = point; }
        }
      }
      return {
        phase,
        name: procedure.name,
        transition,
        points,
        labelPoint,
        highlighted: procedurePreview?.phase === phase && procedurePreview.name === procedure.name,
        color: PROCEDURE_TRACK_COLORS[index % PROCEDURE_TRACK_COLORS.length],
      };
    })).then((results) => {
      if (cancelled) return;
      const features = results.flatMap(({ name, transition, points, labelPoint, highlighted, color }) => {
        if (points.length < 2) return [];
        const line = { type: "Feature" as const, properties: { kind: "line", color, highlighted }, geometry: { type: "LineString" as const, coordinates: points.map((point) => [point.longitude, point.latitude] as [number, number]) } };
        if (!labelPoint) return [line];
        const label = { type: "Feature" as const, properties: { kind: "label", color, highlighted, name: transition ? `${transition}.${name}` : name }, geometry: { type: "Point" as const, coordinates: [labelPoint.longitude, labelPoint.latitude] } };
        return [line, label];
      });
      source.setData({ type: "FeatureCollection", features });
    });
    return () => { cancelled = true; };
  }, [mapReady, activePlan?.departureRunway, activePlan?.arrivalRunway, departureProcedures, arrivalProcedures, navApproaches, procedurePreview, flightAirports]);

  const zoom = (amount: number) => map.current?.zoomTo(map.current.getZoom() + amount);
  const resetMeasurement = () => { measurePointsRef.current = []; (map.current?.getSource("measurement") as maplibregl.GeoJSONSource | undefined)?.setData(emptyFeatures()); (map.current?.getSource("measurement-preview") as maplibregl.GeoJSONSource | undefined)?.setData(emptyFeatures()); setMeasureDistance(0); setMeasureLive(null); };
  const toggleMeasurement = () => { setMeasureMode((active) => !active); if (!measureMode) resetMeasurement(); else { (map.current?.getSource("measurement-preview") as maplibregl.GeoJSONSource | undefined)?.setData(emptyFeatures()); setMeasureLive(null); } };
  const persistActivePlan = async (plan: FlightPlan) => {
    const saved = await saveFlightPlan({ ...plan, updatedAt: new Date().toISOString() });
    const plans = flightPlans.data ?? [];
    queryClient.setQueryData(["flight-plans"], [saved, ...plans.filter((item) => item.id !== saved.id)]);
  };
  const removeAlternate = async () => {
    updateFlightPlan({ alternate: null });
    if (!activePlan) return;
    try { await persistActivePlan({ ...activePlan, alternate: undefined }); } catch { await queryClient.invalidateQueries({ queryKey: ["flight-plans"] }); }
  };
  const selectApproach = async (approach: string) => {
    updateFlightPlan({ destination: { approach } });
    if (!activePlan) return;
    try {
      if (!approach) { await persistActivePlan({ ...activePlan, approach: undefined }); return; }
      // 导航库里的进近程序：同步落地跑道并取回航迹点（STAR leg 按跑道编码，进近同理），
      // 这样航路终点才能落到进近跑道入口而不是机场参考点。
      const definition = navApproaches.find((item) => item.name.trim().toUpperCase() === approach.trim().toUpperCase());
      if (!definition) { await persistActivePlan({ ...activePlan, approach: { name: approach, transition: "", points: [] } }); return; }
      const runway = activePlan.arrivalRunway && procedureSupportsRunway(definition, activePlan.arrivalRunway) ? activePlan.arrivalRunway : definition.runways[0] ?? "";
      const points = await getNavigationProcedurePoints(definition.id, runway, "").catch(() => [] as FlightRoutePoint[]);
      await persistActivePlan({ ...activePlan, arrivalRunway: runway, approach: { name: definition.name, transition: "", points } });
    } catch { await queryClient.invalidateQueries({ queryKey: ["flight-plans"] }); }
  };
  // Navigraph §4.3 步骤 9/12：radio 选用 SID/STAR —— 虚线转实线（simbrief-route 渲染），
  // 同步程序支持的跑道（Charts selects the connecting runway automatically）。
  const selectProcedure = async (phase: "sid" | "star", name: string) => {
    setProcedurePreview(null);
    if (!activePlan) return;
    try {
      const definition = (phase === "sid" ? departureProcedures : arrivalProcedures).find((item) => item.name === name);
      if (!definition) { await persistActivePlan({ ...activePlan, [phase]: undefined } as FlightPlan); return; }
      const currentRunway = phase === "sid" ? activePlan.departureRunway : activePlan.arrivalRunway;
      const runway = currentRunway && procedureSupportsRunway(definition, currentRunway) ? currentRunway : definition.runways[0] ?? "";
      const points = await getNavigationProcedurePoints(definition.id, runway, "").catch(() => [] as FlightRoutePoint[]);
      await persistActivePlan({ ...activePlan, [phase]: { name: definition.name, transition: "", points }, ...(phase === "sid" ? { departureRunway: runway } : { arrivalRunway: runway }) } as FlightPlan);
    } catch { await queryClient.invalidateQueries({ queryKey: ["flight-plans"] }); }
  };
  // 点程序名 → 地图虚线预览（紫色高亮），再点一次取消；同时右下角弹出程序详情框
  // （Navigraph §4.3 步骤 7：the procedure is highlighted as a purple line, a details box appears）。
  const previewProcedure = (phase: "sid" | "star" | "approach", name: string | null) => {
    setProcedurePreview(name ? { phase, name } : null);
    if (!name) return;
    const source = phase === "sid" ? departureProcedures : phase === "star" ? arrivalProcedures : navApproaches;
    const definition = source.find((item) => item.name === name);
    const airport = flightAirports.find((item) => item.role === (phase === "sid" ? "DEP" : "ARR"));
    if (!definition || !airport) return;
    setSelectedSectorCallsigns([]);
    setSelectedMapPoint({ label: name, name: definition.runways.length ? `支持跑道 ${definition.runways.join(" / ")}` : "程序预览", kind: phase === "sid" ? "SID 程序预览" : phase === "star" ? "STAR 程序预览" : "进近程序预览", longitude: airport.longitude, latitude: airport.latitude });
  };
  const dataStatus = navigation.data?.ready ? `${navigationData.data?.airways.length ?? 0} 航段 · ${navigationData.data?.navaids.length ?? 0} 航路点/导航台 · ${navigationData.data?.airports.length ?? 0} 机场` : `AD_HP.csv · ${adHp.data?.length ?? 0} 个国内机场`;
  const navigationState: MapDataState = !navigationLayersEnabled ? "idle" : navigationData.isError || adHp.isError ? "error" : navigationData.isFetching || navigation.isFetching || adHp.isFetching ? "loading" : "ready";
  const navigationDetail = !navigationLayersEnabled ? "相关图层关闭，已暂停范围查询" : navigationData.isError ? navigationData.error.message : adHp.isError ? "机场回退数据加载失败" : navigationData.isFetching ? "正在更新当前可视范围" : dataStatus;
  const firState: MapDataState = !layers.fir ? "idle" : firBoundary.isError ? "error" : firBoundary.isFetching ? "loading" : firBoundary.data?.meta.stale ? "warning" : "ready";
  const firDetail = !layers.fir ? "图层关闭，已暂停加载" : firBoundary.isError ? firBoundary.error.message : firBoundary.data ? `${firBoundary.data.data.features.length} 个边界 · ${firCoverage ? `有管制 ${firCoverage.features.filter((feature) => feature.properties.active === true).length} · ` : ""}${cachedSourceLabel(firBoundary.data.meta)}${firBoundary.isFetching ? " · 后台刷新" : ""}` : "等待加载";
  const controlState: MapDataState = !layers.onlineControl ? "idle" : vatGlasses.isError && traconBoundary.isError ? "error" : vatGlasses.isFetching || traconBoundary.isFetching ? "loading" : vatGlasses.isError || traconBoundary.isError ? "warning" : "ready";
  const controlDetail = !layers.onlineControl ? "图层关闭，已暂停加载" : controlCoverage.features.length === 0 ? "等待加载" : `${vatGlasses.data?.source ?? "VATGlasses"} 高精度扇区 + SimAware 进近兜底 · 共 ${controlCoverage.features.length} 个扇区，在线席位点亮 ${onlineControlSectors} 个`;
  const vatsimState: MapDataState = !vatsimLayersEnabled ? "idle" : vatsim.isError ? "error" : vatsim.isFetching ? "loading" : vatsim.data?.meta.stale ? "warning" : "ready";
  const vatsimDetail = !vatsimLayersEnabled ? "FIR / APP / 交通图层关闭，已暂停刷新" : vatsim.isError ? vatsim.error.message : vatsim.data ? `${vatsim.data.controllers.length} 席位 · ${vatsim.data.pilots.length} 航班 · ${cachedSourceLabel(vatsim.data.meta)}${vatsim.isFetching ? " · 后台刷新" : ""}` : "等待加载";
  const airportGroundState: MapDataState = !layers.airportGround || viewport.zoom <= airportGroundLoadZoom ? "idle" : airportGround.isError ? "error" : airportGround.isFetching ? "loading" : airportGround.data?.meta?.stale ? "warning" : "ready";
  const airportGroundDetail = !layers.airportGround ? "图层关闭，已暂停加载" : viewport.zoom <= airportGroundLoadZoom ? `当前 Zoom ${viewport.zoom.toFixed(1)}，放大至 10 以上后加载` : airportGround.isError ? airportGround.error.message : airportGround.data ? `${airportGround.data.features.length} 个地面要素 · ${cachedSourceLabel(airportGround.data.meta)}${airportGround.isFetching ? " · 后台刷新" : ""}` : "等待加载";

  const flightPlanPanelVisible = Boolean(flightPlanPanel && !flightPlanPanelHidden);
  // 右侧栏同时承载「管制席位」与「VATSIM FLIGHT」两张卡片：管制卡固定在上，FLIGHT 卡占住剩余高度，
  // 两者之间由 flex gap 留出间距，不会互相叠压。
  const rightRailVisible = selectedSectorControllers.length > 0 || Boolean(selectedPilot) || Boolean(selectedMapPoint);
  return <div className={`map-page ${flightPlanPanelVisible ? "flight-plan-panel-open" : ""}`}><div className="map-canvas" ref={container} />
    {flightPlanPanelVisible && flightPlanPanel && <FlightPlanPanel data={flightPlanPanel} availableApproaches={navApproaches.map((procedure) => ({ name: procedure.name, runways: procedure.runways }))} availableDepartures={departureProcedures.map((procedure) => ({ name: procedure.name, runways: procedure.runways }))} availableArrivals={arrivalProcedures.map((procedure) => ({ name: procedure.name, runways: procedure.runways }))} onSelectProcedure={(phase, name) => { if (phase === "approach") void selectApproach(name); else void selectProcedure(phase, name); }} onPreviewProcedure={previewProcedure} onHide={() => setFlightPlanPanelHidden(true)} onUnload={() => unloadFlightPlanPanel(flightPlanPanel.planId)} onEdit={() => navigate("/flight-plans")} onOpenCharts={(icao) => navigate(`/charts?icao=${encodeURIComponent(icao)}`)} onRemoveAlternate={() => { void removeAlternate(); }} onSelectApproach={(approach) => { void selectApproach(approach); }} onViewSimBrief={() => { window.open("https://dispatch.simbrief.com/briefing/latest", "_blank", "noopener,noreferrer"); }} />}
    {flightPlanPanel && flightPlanPanelHidden && <button className="flight-plan-panel-show" type="button" onClick={() => setFlightPlanPanelHidden(false)}>Show Flight Plan</button>}
    <div className="map-toolbar"><button onClick={() => zoom(1)} aria-label="放大"><Plus size={19} /></button><button onClick={() => zoom(-1)} aria-label="缩小"><Minus size={19} /></button><span /><button onClick={() => { if (map.current) fitRouteBounds(map.current, completeRoutePoints, 650); }} aria-label="定位到计划航路"><Crosshair size={19} /></button><button className={measureMode ? "active" : ""} onClick={toggleMeasurement} aria-label="测量距离"><Ruler size={19} /></button></div>
    <aside className={`map-layers ${layersOpen ? "" : "collapsed"}`}>
      <div className="map-layers-heading"><div><Layers size={18} /><strong>地图图层</strong></div><button onClick={() => setLayersOpen((open) => !open)} aria-label={layersOpen ? "横向收起图层面板" : "展开图层面板"} title={layersOpen ? "横向收起" : "展开图层"}>{layersOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}</button></div>
      {layersOpen && <>
        <div className="map-style-selector" role="group" aria-label="地图图源"><button className={mapStyle === "standard" ? "active" : ""} onClick={() => setMapStyle("standard")}><MapIcon size={14} />标准地图</button><button className={mapStyle === "satellite" ? "active" : ""} onClick={() => setMapStyle("satellite")}><Satellite size={14} />卫星地图</button></div>
        {layers.route && <div className="airway-level-selector"><span>航路级别</span><div role="group" aria-label="高低空航路筛选">{([['all', '全部'], ['high', '高空'], ['low', '低空']] as Array<[AirwayLevel, string]>).map(([value, label]) => <button type="button" className={airwayLevelFilter === value ? "active" : ""} onClick={() => setAirwayLevelFilter(value)} key={value}>{label}</button>)}</div></div>}
        <div className="layer-list">{layerOptions.map(({ key, label }) => <label className="layer-toggle" key={key}><span>{label}</span><input type="checkbox" checked={layers[key]} onChange={() => setLayers((current) => ({ ...current, [key]: !current[key] }))} /><i /></label>)}</div>
        <div className="map-data-status">
          <MapDataRow label="导航数据" detail={navigationDetail} state={navigationState} />
          <MapDataRow label="FIR 边界" detail={firDetail} state={firState} />
          <MapDataRow label="在线管制" detail={controlDetail} state={controlState} />
          <MapDataRow label="VATSIM 实时" detail={vatsimDetail} state={vatsimState} />
          <MapDataRow label="OSM 机场地面" detail={airportGroundDetail} state={airportGroundState} />
          {layers.weather && <MapDataRow label="天气雷达" detail={openWeatherKey ? "瓦片图层已启用，随地图按需加载" : "未配置 VITE_OPENWEATHER_API_KEY"} state={openWeatherKey ? "ready" : "error"} />}
        </div>
      </>}
    </aside>
    {rightRailVisible && <div className="map-right-rail">{selectedMapPoint && <aside className="map-point-detail"><div className="map-point-detail-header"><span>{selectedMapPoint.kind || "航图要素"}</span><button onClick={() => setSelectedMapPoint(null)} aria-label="关闭要素详情"><X size={16} /></button></div><strong>{selectedMapPoint.label}</strong>{selectedMapPoint.name && selectedMapPoint.name.toUpperCase() !== selectedMapPoint.label.toUpperCase() && <p>{selectedMapPoint.name}</p>}<small>{coordinateText(selectedMapPoint.latitude, "lat")} {coordinateText(selectedMapPoint.longitude, "lon")}</small></aside>}{selectedSectorControllers.length > 0 && <ControllerDetailPanel key={selectedSectorCallsigns.join("|")} controllers={selectedSectorControllers} onClose={() => setSelectedSectorCallsigns([])} />}{selectedPilot && <aside className="traffic-detail-panel"><div className="traffic-detail-header"><div><span>VATSIM FLIGHT</span><strong>{selectedPilot.callsign}</strong></div><button onClick={() => setSelectedCallsign("")} aria-label="关闭航班详情"><X size={18} /></button></div><div className="traffic-route"><strong>{selectedPilot.flight_plan?.departure || "----"}</strong><span><Plane size={22} /></span><strong>{selectedPilot.flight_plan?.arrival || "----"}</strong><small>{selectedPilot.flight_plan?.alternate ? `备降 ${selectedPilot.flight_plan.alternate}` : "在线航班"}</small></div><div className="traffic-detail-grid"><div><span>注册号</span><strong>{pilotRegistration(selectedPilot)}</strong></div><div><span>机型</span><strong>{selectedPilot.flight_plan?.aircraft_short || "未提供"}</strong></div><div><span>高度</span><strong>{selectedPilot.altitude.toLocaleString()} ft</strong></div><div><span>地速</span><strong>{selectedPilot.groundspeed} kts</strong></div><div><span>航向</span><strong>{selectedPilot.heading}°</strong></div><div><span>应答机</span><strong className="squawk">{selectedPilot.transponder || "----"}</strong></div><div><span>飞行规则</span><strong>{flightRules(selectedPilot.flight_plan?.flight_rules)}</strong></div><div><span>计划高度</span><strong>{selectedPilot.flight_plan?.altitude ? `${selectedPilot.flight_plan.altitude} ft` : "未提供"}</strong></div><div><span>QNH</span><strong>{selectedPilot.qnh_mb || "----"} hPa</strong></div><div><span>巡航 TAS</span><strong>{selectedPilot.flight_plan?.cruise_tas ? `${selectedPilot.flight_plan.cruise_tas} kts` : "未提供"}</strong></div></div><div className="traffic-detail-card"><span>飞行员</span><strong>{selectedPilot.name}</strong><small>VATSIM CID {selectedPilot.cid}</small></div><div className="traffic-detail-card"><span>航路</span><p>{selectedPilot.flight_plan?.route || "未提交航路"}</p></div><div className="traffic-detail-footer">最后更新：{new Date(selectedPilot.last_updated).toLocaleTimeString("zh-CN")}</div></aside>}</div>}
    {measureMode && <div className="measure-card"><div><Ruler size={16} /><strong>距离测量</strong></div><span>{measureDistance.toFixed(1)} NM</span><p className={"measure-live" + (measureLive ? " active" : "")}>{measureLive ? <>{String(Math.round(measureLive.bearing)).padStart(3, "0")}° · {measureLive.distance.toFixed(1)} NM</> : "点击地图加点"}</p><button onClick={resetMeasurement}><RotateCcw size={14} />清除</button></div>}
    <div className="map-attribution">FIR: VAT-Spy/Volanta · 高精度扇区: VATGlasses · TRACON: SimAware · 航班: VATSIM · 机场地面: OpenStreetMap · 航图符号依据 Jeppesen CHARTING SYMBOLS LEGEND (SYMBOLS-1/2/3/8) 与 ENROUTE CHART LEGEND (ENROUTE-7) 及 Navigraph Charts 图例 · 地图 © {mapStyle === "satellite" ? satelliteMapProvider : standardMapProvider}</div>
  </div>;
}

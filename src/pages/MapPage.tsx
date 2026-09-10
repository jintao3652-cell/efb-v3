import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import * as maplibregl from "maplibre-gl";
import type { Map as MapLibreMap, StyleSpecification } from "maplibre-gl";
import { Crosshair, Download, Layers, Map as MapIcon, Minus, PanelRightClose, PanelRightOpen, Plane, Plus, RotateCcw, Ruler, Satellite, Upload, X } from "lucide-react";
import { FlightPlanPanel } from "../components/map/FlightPlanPanel";
import { loadAdHpAirports } from "../lib/airport-data";
import { applyActiveTraconControllers, loadFirBoundaries, loadTraconBoundaries, loadVatGlassesDataset, loadVatsimSnapshot, type OwnershipFile, type VatsimPilot } from "../lib/airspace";
import { registerChartSymbols } from "../lib/chart-symbols";
import { airports } from "../lib/data";
import { loadOsmAirportGround, normalizeAirportGroundBounds } from "../lib/osm-airport";
import { useAppStore } from "../stores/app-store";
import { useFlightPlanStore, updateFlightPlan } from "../stores/flight-plan-store";
import { getNavigationAirportProcedures, getNavigationDatabaseStatus, getNavigationMapData, getWeather, getXflyAirportData, listFlightPlans, saveFlightPlan, searchNavigationAirports, type MapViewport, type NavigationAirport, type NavigationMapData, type NavigationMapPoint } from "../lib/tauri";
import type { Airport, FlightPlan, FlightPlanAirportPanelData, FlightPlanData } from "../types";

type LayerKey = "route" | "terminalWaypoints" | "airports" | "airportGround" | "fir" | "vatglasses" | "tracon" | "traffic" | "weather";
type AirwayLevel = "all" | "high" | "low";

const layerOptions: Array<{ key: LayerKey; label: string }> = [
  { key: "route", label: "航路显示" }, { key: "terminalWaypoints", label: "终端航路点" }, { key: "airports", label: "机场显示" }, { key: "airportGround", label: "机场地面设施（OSM）" }, { key: "fir", label: "FIR / UIR 边界" }, { key: "vatglasses", label: "VATGlasses 高精度扇区" },
  { key: "tracon", label: "APP / TRACON 边界" },
  { key: "traffic", label: "VATSIM 实时交通" }, { key: "weather", label: "天气雷达" },
];
const mapLayerIds: Record<LayerKey, string[]> = {
  route: ["navigation-airways", "navigation-airway-labels", "navigation-airway-directions", "navigation-airway-distances", "navigation-airway-altitudes", "navigation-navaids", "navigation-navaid-labels", "flight-airport-halo", "flight-airport-points", "flight-airport-labels"],
  terminalWaypoints: ["navigation-waypoints", "navigation-waypoint-labels"],
  airports: ["navigation-airports", "navigation-airport-labels"], fir: ["fir-fill", "fir-line", "fir-labels"],
  vatglasses: ["vatglasses-fill", "vatglasses-separator-casing", "vatglasses-line", "vatglasses-labels"],
  airportGround: ["osm-apron-fill", "osm-apron-line", "osm-terminal-fill", "osm-terminal-line", "osm-runway-casing", "osm-runway-line", "osm-taxiway-casing", "osm-taxiway-line", "osm-runway-name-labels", "osm-taxiway-name-labels", "osm-stand-points", "osm-stand-labels"],
  tracon: ["tracon-fill", "tracon-active-glow", "tracon-separator-casing", "tracon-line", "tracon-labels"],
  traffic: ["traffic-points", "traffic-labels"], weather: ["weather-radar"],
};
const staticFallbackAirports: NavigationMapPoint[] = airports.map((airport) => ({ ident: airport.icao, icao: airport.icao, iata: airport.iata, name: airport.name, kind: "机场", latitude: airport.latitude, longitude: airport.longitude }));
const fallbackNavaids: NavigationMapPoint[] = [
  { ident: "RENOB", name: "RENOB", icao: "", iata: "", kind: "航路点", latitude: 39.2, longitude: 117.2 },
  { ident: "POU", name: "POU", icao: "", iata: "", kind: "航路点", latitude: 37.5, longitude: 118.2 },
  { ident: "DUMET", name: "DUMET", icao: "", iata: "", kind: "航路点", latitude: 34.8, longitude: 119.6 },
];
type RoutePoint = { ident: string; name: string; latitude: number; longitude: number };
type FlightAirportPoint = RoutePoint & { role: "DEP" | "ARR" };
const emptyRoutePoints: RoutePoint[] = [];
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
function distinctPointLabel(ident: string, name: string, fallback = "") { const normalizedIdent = ident.trim(); const normalizedName = name.trim(); if (!normalizedIdent) return normalizedName || fallback; return normalizedName && normalizedName.toUpperCase() !== normalizedIdent.toUpperCase() ? `${normalizedIdent} · ${normalizedName}` : normalizedIdent; }
function labelForPoint(point: NavigationMapPoint) { return point.icao ? `${point.icao}${point.iata ? ` / ${point.iata}` : ""}` : distinctPointLabel(point.ident, point.name, point.kind); }
function chartSymbolForPoint(point: NavigationMapPoint) {
  if (point.symbol) return point.symbol;
  if (point.kind === "机场") return "airport-ifr";
  if (point.kind === "航路点") return "waypoint";
  if (point.kind === "NDB") return "ndb";
  return "vor";
}
function pointsAsFeatures(points: NavigationMapPoint[], routePoints: RoutePoint[] = []) { return { type: "FeatureCollection" as const, features: points.map((point) => ({ type: "Feature" as const, properties: { label: labelForPoint(point), code: point.icao ? `${point.icao}${point.iata ? ` / ${point.iata}` : ""}` : point.ident, name: point.name || point.kind, ident: point.ident, kind: point.kind, symbol: chartSymbolForPoint(point), routePoint: routePoints.length > 0 && routeRequiresWaypoint(point, routePoints) }, geometry: { type: "Point" as const, coordinates: [point.longitude, point.latitude] } })) }; }
function airwayLevel(airwayType: string) { return airwayType === "J" ? "high" : airwayType === "V" ? "low" : airwayType === "B" ? "both" : "unknown"; }
function airwaysAsFeatures(data: NavigationMapData) { return { type: "FeatureCollection" as const, features: data.airways.map((airway) => ({ type: "Feature" as const, properties: { name: airway.name, airwayLevel: airwayLevel(airway.airwayType), routeType: airway.routeType, rnav: airway.routeType === "R" }, geometry: { type: "LineString" as const, coordinates: airway.coordinates } })) }; }
function airwayLegsAsFeatures(data: NavigationMapData) { return { type: "FeatureCollection" as const, features: data.airways.flatMap((airway) => airway.legs.map((leg) => ({ type: "Feature" as const, properties: { name: airway.name, airwayLevel: airwayLevel(airway.airwayType), direction: leg.direction, directionMarker: leg.direction === "F" ? "▶" : leg.direction === "B" ? "◀" : "", distance: `${Math.max(1, Math.round(distanceInNm(leg.coordinates)))} NM`, minimumAltitude: leg.minimumAltitude && leg.minimumAltitude < 99_999 ? `MEA ${leg.minimumAltitude}` : "" }, geometry: { type: "LineString" as const, coordinates: leg.coordinates } }))) }; }
function simbriefRouteFeatures(points: Array<{ ident: string; name: string; latitude: number; longitude: number }>) { return { type: "FeatureCollection" as const, features: points.length > 1 ? [{ type: "Feature" as const, properties: {}, geometry: { type: "LineString" as const, coordinates: points.map((point) => [point.longitude, point.latitude]) } }] : [] }; }
function simbriefPointFeatures(points: Array<{ ident: string; name: string; latitude: number; longitude: number }>) { return { type: "FeatureCollection" as const, features: points.map((point) => ({ type: "Feature" as const, properties: { label: distinctPointLabel(point.ident, point.name) }, geometry: { type: "Point" as const, coordinates: [point.longitude, point.latitude] } })) }; }
function flightAirportFeatures(points: FlightAirportPoint[]) { return { type: "FeatureCollection" as const, features: points.map((point) => ({ type: "Feature" as const, properties: { role: point.role, label: `${point.role} · ${point.ident}${point.name && point.name.toUpperCase() !== point.ident.toUpperCase() ? `\n${point.name}` : ""}` }, geometry: { type: "Point" as const, coordinates: [point.longitude, point.latitude] } })) }; }
function samePosition(first: RoutePoint | undefined, second: RoutePoint | undefined) { return Boolean(first && second && Math.abs(first.latitude - second.latitude) < .00001 && Math.abs(first.longitude - second.longitude) < .00001); }
function appendRouteSegment(points: RoutePoint[], segment: RoutePoint[]) { for (const point of segment) if (!samePosition(points.at(-1), point)) points.push(point); }
function mapRoutePoints(plan: FlightPlan) {
  const base = plan.routePoints ?? [];
  const departure = base.find((point) => point.ident.trim().toUpperCase() === plan.departure.trim().toUpperCase());
  const arrival = base.find((point) => point.ident.trim().toUpperCase() === plan.arrival.trim().toUpperCase());
  const enroute = base.filter((point) => point !== departure && point !== arrival);
  const points: RoutePoint[] = [];
  if (departure) points.push(departure);
  appendRouteSegment(points, plan.sid?.points ?? []);
  appendRouteSegment(points, enroute);
  appendRouteSegment(points, plan.star?.points ?? []);
  appendRouteSegment(points, plan.approach?.points ?? []);
  if (arrival) appendRouteSegment(points, [arrival]);
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
function trafficAsFeatures(pilots: VatsimPilot[]) { return { type: "FeatureCollection" as const, features: pilots.filter((pilot) => Number.isFinite(pilot.latitude) && Number.isFinite(pilot.longitude)).map((pilot) => ({ type: "Feature" as const, properties: { callsign: pilot.callsign, heading: pilot.heading }, geometry: { type: "Point" as const, coordinates: [pilot.longitude, pilot.latitude] } })) }; }
function pilotRegistration(pilot: VatsimPilot) { return pilot.flight_plan?.remarks.match(/(?:^|\s)REG\/([A-Z0-9-]+)/i)?.[1]?.toUpperCase() ?? "未提供"; }
function flightRules(value?: string) { return value === "I" ? "IFR" : value === "V" ? "VFR" : value || "未知"; }
function flightLevel(value?: string) { const number = Number(value?.toUpperCase().replace(/[^0-9]/g, "")); return Number.isFinite(number) && number > 0 ? (number > 600 ? Math.round(number / 100) : number) : undefined; }
function storedVatGlassesDataset() { try { return localStorage.getItem("skyboard-vatglasses-dataset") || "z"; } catch { return "z"; } }
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
  return [...new Set(data?.charts.filter((chart) => /(?:APPROACH|\bAPP\b|\bIAC\b|ILS|RNP|RNAV|进近)/i.test(`${chart.category} ${chart.name}`)).map((chart) => chart.name.trim()).filter(Boolean) ?? [])];
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

function ChartSymbolExample({ type }: { type: "airport" | "airport-vfr" | "waypoint" | "intersection" | "ndb" | "dme" | "vor-dme" | "tacan" | "vortac" }) {
  if (type === "airport" || type === "airport-vfr") return <svg className={`chart-symbol-example airport ${type === "airport-vfr" ? "vfr" : ""}`} viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.7l1.5 1.8 2.3-.6.7 2.2 2.3.4-.2 2.3 2 1.2-1.2 2 1.2 2-2 1.2.2 2.3-2.3.4-.7 2.2-2.3-.6-1.5 1.8-1.5-1.8-2.3.6-.7-2.2-2.3-.4.2-2.3-2-1.2 1.2-2-1.2-2 2-1.2-.2-2.3 2.3-.4.7-2.2 2.3.6z" /><circle cx="12" cy="12" r="3" /></svg>;
  if (type === "waypoint") return <svg className="chart-symbol-example" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l2.1 7.9L22 12l-7.9 2.1L12 22l-2.1-7.9L2 12l7.9-2.1z" /></svg>;
  if (type === "intersection") return <svg className="chart-symbol-example" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4l8 15H4z" /></svg>;
  if (type === "ndb") return <svg className="chart-symbol-example" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /></svg>;
  if (type === "dme") return <svg className="chart-symbol-example" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" /><rect x="7" y="7" width="10" height="10" /></svg>;
  if (type === "tacan") return <svg className="chart-symbol-example" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" /><path d="M12 4l2.2 5.8 6.2.5-4.8 4 1.5 6-5.1-3.4-5.1 3.4 1.5-6-4.8-4 6.2-.5z" /></svg>;
  if (type === "vortac") return <svg className="chart-symbol-example" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" /><path d="M12 4l2.2 5.8 6.2.5-4.8 4 1.5 6-5.1-3.4-5.1 3.4 1.5-6-4.8-4 6.2-.5z" /><path d="M12 8l3.5 2v4L12 16l-3.5-2v-4z" /></svg>;
  return <svg className="chart-symbol-example" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" /><rect x="6" y="6" width="12" height="12" /><path d="M12 7l5 3v5l-5 3-5-3v-5z" /></svg>;
}

function normalizeNavigationViewport(viewport: MapViewport): MapViewport {
  const step = viewport.zoom >= 10 ? 0.02 : viewport.zoom >= 7 ? 0.1 : 0.5;
  const lower = (value: number) => Number((Math.floor(value / step) * step).toFixed(3));
  const upper = (value: number) => Number((Math.ceil(value / step) * step).toFixed(3));
  return { west: lower(viewport.west), south: lower(viewport.south), east: upper(viewport.east), north: upper(viewport.north), zoom: Math.floor(viewport.zoom * 2) / 2 };
}

export function MapPage() {
  const { mapStyle, setMapStyle, online } = useAppStore();
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
  const ownershipInput = useRef<HTMLInputElement>(null);
  const [layersOpen, setLayersOpen] = useState(true);
  const [mapReady, setMapReady] = useState(false);
  const [measureMode, setMeasureMode] = useState(false);
  const [measureDistance, setMeasureDistance] = useState(0);
  const [selectedCallsign, setSelectedCallsign] = useState("");
  const [viewport, setViewport] = useState<MapViewport>(initialViewport);
  const [layers, setLayers] = useState<Record<LayerKey, boolean>>({ route: true, terminalWaypoints: false, airports: true, airportGround: true, fir: true, vatglasses: false, tracon: false, traffic: true, weather: false });
  const [airwayLevelFilter, setAirwayLevelFilter] = useState<AirwayLevel>("all");
  const [vatGlassesDataset, setVatGlassesDataset] = useState(storedVatGlassesDataset);
  const [vatGlassesDraft, setVatGlassesDraft] = useState(vatGlassesDataset);
  const [vatGlassesFlightLevel, setVatGlassesFlightLevel] = useState(300);
  const [customOwnership, setCustomOwnership] = useState<OwnershipFile>();
  const navigationLayersEnabled = layers.route || layers.terminalWaypoints || layers.airports;
  const vatsimLayersEnabled = layers.tracon || layers.traffic;
  const navigationViewport = useMemo(() => normalizeNavigationViewport(viewport), [viewport]);
  const airportGroundBounds = useMemo(() => normalizeAirportGroundBounds(viewport), [viewport]);
  const navigation = useQuery({ queryKey: ["navigation-database"], queryFn: getNavigationDatabaseStatus, retry: 0 });
  const navigationData = useQuery({ queryKey: ["navigation-map-data", navigation.data?.source, navigation.data?.databasePath, navigationViewport], queryFn: () => getNavigationMapData(navigationViewport), enabled: Boolean(navigation.data?.ready && navigationLayersEnabled), retry: 0, staleTime: 30_000, placeholderData: (previousData) => previousData });
  const adHp = useQuery({ queryKey: ["ad-hp-airports"], queryFn: loadAdHpAirports, staleTime: Infinity });
  const firBoundary = useQuery({ queryKey: ["vatsim-fir-boundaries"], queryFn: ({ signal }) => loadFirBoundaries(signal), enabled: layers.fir, retry: 0, staleTime: 6 * 60 * 60_000, networkMode: "always", placeholderData: (previousData) => previousData });
  const vatGlasses = useQuery({ queryKey: ["vatglasses", vatGlassesDataset, customOwnership], queryFn: ({ signal }) => loadVatGlassesDataset(vatGlassesDataset, customOwnership, signal), enabled: layers.vatglasses, retry: 0, staleTime: 24 * 60 * 60_000, networkMode: "always", placeholderData: (previousData) => previousData });
  const traconBoundary = useQuery({ queryKey: ["vatsim-tracon-boundaries"], queryFn: ({ signal }) => loadTraconBoundaries(signal), enabled: layers.tracon, retry: 0, staleTime: 6 * 60 * 60_000, networkMode: "always", placeholderData: (previousData) => previousData });
  const vatsim = useQuery({ queryKey: ["vatsim-live-snapshot"], queryFn: ({ signal }) => loadVatsimSnapshot(signal), enabled: vatsimLayersEnabled, retry: 0, refetchInterval: online ? 15_000 : false, staleTime: 12_000, networkMode: "always", placeholderData: (previousData) => previousData });
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
  const availableApproaches = useMemo(() => approachCharts(destinationXfly.data), [destinationXfly.data]);
  const routePoints = useMemo(() => activePlan ? mapRoutePoints(activePlan) : emptyRoutePoints, [activePlan]);
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
    const resolveAirport = (ident: string, role: "DEP" | "ARR") => {
      const normalized = ident.trim().toUpperCase();
      const point = routePoints.find((routePoint) => routePoint.ident.trim().toUpperCase() === normalized) ?? knownAirports.get(normalized);
      return point ? { ...point, ident: normalized, role } : undefined;
    };
    return [resolveAirport(activePlan.departure, "DEP"), resolveAirport(activePlan.arrival, "ARR")].filter((point): point is FlightAirportPoint => Boolean(point));
  }, [activePlan, knownAirports, routePoints]);
  const completeRoutePoints = useMemo(() => {
    const points = [...routePoints];
    const departure = flightAirports.find((point) => point.role === "DEP");
    const arrival = flightAirports.find((point) => point.role === "ARR");
    if (departure && !samePosition(points[0], departure)) points.unshift(departure);
    if (arrival && !samePosition(points.at(-1), arrival)) points.push(arrival);
    return points;
  }, [flightAirports, routePoints]);
  const simbriefWaypoints = useMemo(() => routePoints.filter((point) => !flightAirports.some((airport) => samePosition(point, airport))), [flightAirports, routePoints]);
  const traconCoverage = useMemo(() => traconBoundary.data ? applyActiveTraconControllers(traconBoundary.data.data, vatsim.data?.controllers ?? []) : undefined, [traconBoundary.data, vatsim.data?.controllers]);
  const selectedPilot = useMemo(() => (vatsim.data?.pilots ?? []).find((pilot) => pilot.callsign === selectedCallsign), [vatsim.data?.pilots, selectedCallsign]);
  const currentOwnership = useMemo<OwnershipFile | undefined>(() => {
    if (customOwnership ?? vatGlasses.data?.ownership) return customOwnership ?? vatGlasses.data?.ownership;
    if (!vatGlasses.data?.features.features.length) return undefined;
    const airspace: Record<string, string[]> = {};
    for (const feature of vatGlasses.data.features.features) {
      const key = String(feature.properties.sectorKey ?? "");
      const owner = String(feature.properties.owner ?? "");
      if (key && owner) airspace[key] = [owner];
    }
    return { name: `${vatGlassesDataset.toUpperCase()} 当前显示归属`, type: "ownership", airspace };
  }, [customOwnership, vatGlasses.data, vatGlassesDataset]);
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
  const visibleVatGlassesSectors = useMemo(() => (vatGlasses.data?.features.features ?? []).filter((feature) => Number(feature.properties.min ?? 0) <= vatGlassesFlightLevel && Number(feature.properties.max ?? 999) >= vatGlassesFlightLevel).length, [vatGlasses.data, vatGlassesFlightLevel]);
  const fallbackMapData = useMemo<NavigationMapData>(() => ({ airports: (adHp.data?.length ? adHp.data : airports).map((airport) => ({ ident: airport.icao, icao: airport.icao, iata: airport.iata, name: airport.name, kind: "机场", latitude: airport.latitude, longitude: airport.longitude })), navaids: fallbackNavaids, airways: [] }), [adHp.data]);

  useEffect(() => { const level = flightLevel(activePlan?.cruiseAltitude); if (level) setVatGlassesFlightLevel(level); }, [activePlan?.id, activePlan?.cruiseAltitude]);
  useEffect(() => { if (nextFlightPlanPanel) setFlightPlanPanel(nextFlightPlanPanel); else clearFlightPlanPanel(); }, [clearFlightPlanPanel, nextFlightPlanPanel, setFlightPlanPanel]);
  useEffect(() => { const frame = window.requestAnimationFrame(() => map.current?.resize()); return () => window.cancelAnimationFrame(frame); }, [flightPlanPanelHidden, flightPlanPanel?.planId]);

  useEffect(() => {
    if (!container.current || map.current) return;
    const instance = new maplibregl.Map({ container: container.current, center: [114.8, 34.5], zoom: 4.5, style: baseMapStyle });
    const updateMeasurement = (points: Array<[number, number]>) => (instance.getSource("measurement") as maplibregl.GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: points.length > 1 ? [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: points } }] : [] });
    const updateViewport = () => { const bounds = instance.getBounds(); setViewport({ west: Number(bounds.getWest().toFixed(3)), south: Number(bounds.getSouth().toFixed(3)), east: Number(bounds.getEast().toFixed(3)), north: Number(bounds.getNorth().toFixed(3)), zoom: Number(instance.getZoom().toFixed(1)) }); };
    instance.on("load", () => {
      instance.addSource("navigation-airways", { type: "geojson", data: emptyFeatures() }); instance.addSource("navigation-airway-legs", { type: "geojson", data: emptyFeatures() }); instance.addSource("navigation-airports", { type: "geojson", data: pointsAsFeatures(staticFallbackAirports) }); instance.addSource("navigation-navaids", { type: "geojson", data: pointsAsFeatures(fallbackNavaids) }); instance.addSource("simbrief-route", { type: "geojson", data: emptyFeatures() }); instance.addSource("simbrief-points", { type: "geojson", data: emptyFeatures() }); instance.addSource("flight-airports", { type: "geojson", data: emptyFeatures() }); instance.addSource("fir", { type: "geojson", data: emptyFeatures() }); instance.addSource("vatglasses", { type: "geojson", data: emptyFeatures() }); instance.addSource("tracon", { type: "geojson", data: emptyFeatures() }); instance.addSource("osm-airport-ground", { type: "geojson", data: emptyFeatures() }); instance.addSource("traffic", { type: "geojson", data: emptyFeatures() }); instance.addSource("measurement", { type: "geojson", data: emptyFeatures() });
      registerChartSymbols(instance);
      instance.addLayer({ id: "fir-fill", type: "fill", source: "fir", paint: { "fill-color": "#ffffff", "fill-opacity": .018 } }); instance.addLayer({ id: "fir-line", type: "line", source: "fir", paint: { "line-color": "#f4f6f8", "line-width": 1.35, "line-opacity": .92 } }); instance.addLayer({ id: "fir-labels", type: "symbol", source: "fir", minzoom: 3, layout: { "text-field": ["get", "id"], "text-size": 11, "text-allow-overlap": false }, paint: { "text-color": "#ffffff", "text-halo-color": "#071827", "text-halo-width": 1.7 } });
      instance.addLayer({ id: "vatglasses-fill", type: "fill", source: "vatglasses", minzoom: 4, filter: ["all", ["<=", ["get", "min"], 300], [">=", ["get", "max"], 300]], layout: { visibility: "none" }, paint: { "fill-color": ["get", "color"], "fill-opacity": .12 } }); instance.addLayer({ id: "vatglasses-separator-casing", type: "line", source: "vatglasses", minzoom: 4, filter: ["all", ["<=", ["get", "min"], 300], [">=", ["get", "max"], 300]], layout: { visibility: "none" }, paint: { "line-color": "#061018", "line-width": ["interpolate", ["linear"], ["zoom"], 4, 2.8, 9, 5.2], "line-opacity": .94 } }); instance.addLayer({ id: "vatglasses-line", type: "line", source: "vatglasses", minzoom: 4, filter: ["all", ["<=", ["get", "min"], 300], [">=", ["get", "max"], 300]], layout: { visibility: "none" }, paint: { "line-color": ["get", "color"], "line-width": ["interpolate", ["linear"], ["zoom"], 4, 1.2, 9, 2.4], "line-opacity": 1 } }); instance.addLayer({ id: "vatglasses-labels", type: "symbol", source: "vatglasses", minzoom: 5, filter: ["all", ["<=", ["get", "min"], 300], [">=", ["get", "max"], 300]], layout: { visibility: "none", "text-field": ["get", "label"], "text-size": 10, "text-allow-overlap": false, "text-optional": true }, paint: { "text-color": "#ecf8ff", "text-halo-color": "#07131d", "text-halo-width": 1.8 } });
      instance.addLayer({ id: "tracon-fill", type: "fill", source: "tracon", minzoom: 5, layout: { visibility: "none" }, paint: { "fill-color": ["case", ["==", ["get", "active"], true], "#00c96b", "#176443"], "fill-opacity": ["case", ["==", ["get", "active"], true], .8, .7] } }); instance.addLayer({ id: "tracon-active-glow", type: "line", source: "tracon", minzoom: 5, filter: ["==", ["get", "active"], true], layout: { visibility: "none" }, paint: { "line-color": "#25e98a", "line-width": 9, "line-opacity": .24, "line-blur": 3 } }); instance.addLayer({ id: "tracon-separator-casing", type: "line", source: "tracon", minzoom: 5, layout: { visibility: "none" }, paint: { "line-color": "#031a10", "line-width": ["case", ["==", ["get", "active"], true], 6.5, 4.5], "line-opacity": .92 } }); instance.addLayer({ id: "tracon-line", type: "line", source: "tracon", minzoom: 5, layout: { visibility: "none" }, paint: { "line-color": ["case", ["==", ["get", "active"], true], "#8effbd", "#45bd80"], "line-width": ["case", ["==", ["get", "active"], true], 3.4, 2.2], "line-opacity": ["case", ["==", ["get", "active"], true], 1, .9] } }); instance.addLayer({ id: "tracon-labels", type: "symbol", source: "tracon", minzoom: 5, filter: ["==", ["get", "active"], true], layout: { visibility: "none", "text-field": ["get", "activeCallsign"], "text-size": 13, "text-letter-spacing": .08, "text-allow-overlap": true, "text-ignore-placement": true }, paint: { "text-color": "#d8ffe9", "text-halo-color": "#062116", "text-halo-width": 2.2 } });
      instance.addLayer({ id: "osm-apron-fill", type: "fill", source: "osm-airport-ground", minzoom: 12, filter: ["==", ["get", "kind"], "apron"], layout: { visibility: "none" }, paint: { "fill-color": "#627482", "fill-opacity": .72 } }); instance.addLayer({ id: "osm-apron-line", type: "line", source: "osm-airport-ground", minzoom: 12, filter: ["==", ["get", "kind"], "apron"], layout: { visibility: "none" }, paint: { "line-color": "#a7bbc7", "line-width": 1.2 } }); instance.addLayer({ id: "osm-terminal-fill", type: "fill", source: "osm-airport-ground", minzoom: 12, filter: ["==", ["get", "kind"], "terminal"], layout: { visibility: "none" }, paint: { "fill-color": "#263d50", "fill-opacity": .9 } }); instance.addLayer({ id: "osm-terminal-line", type: "line", source: "osm-airport-ground", minzoom: 12, filter: ["==", ["get", "kind"], "terminal"], layout: { visibility: "none" }, paint: { "line-color": "#9fc5d8", "line-width": 1.5 } }); instance.addLayer({ id: "osm-runway-casing", type: "line", source: "osm-airport-ground", minzoom: 12, filter: ["==", ["get", "kind"], "runway"], layout: { visibility: "none" }, paint: { "line-color": "#111a21", "line-width": ["interpolate", ["linear"], ["zoom"], 12, 8, 16, 28] } }); instance.addLayer({ id: "osm-runway-line", type: "line", source: "osm-airport-ground", minzoom: 12, filter: ["==", ["get", "kind"], "runway"], layout: { visibility: "none" }, paint: { "line-color": "#cbd4d9", "line-width": ["interpolate", ["linear"], ["zoom"], 12, 5, 16, 22] } }); instance.addLayer({ id: "osm-taxiway-casing", type: "line", source: "osm-airport-ground", minzoom: 12, filter: ["==", ["get", "kind"], "taxiway"], layout: { visibility: "none" }, paint: { "line-color": "#3d3011", "line-width": ["interpolate", ["linear"], ["zoom"], 12, 3, 17, 12] } }); instance.addLayer({ id: "osm-taxiway-line", type: "line", source: "osm-airport-ground", minzoom: 12, filter: ["==", ["get", "kind"], "taxiway"], layout: { visibility: "none" }, paint: { "line-color": "#f0c44e", "line-width": ["interpolate", ["linear"], ["zoom"], 12, 1.4, 17, 6] } }); instance.addLayer({ id: "osm-runway-labels", type: "symbol", source: "osm-airport-ground", minzoom: 13, filter: ["all", ["==", ["get", "kind"], "runway"], ["has", "label"]], layout: { visibility: "none", "symbol-placement": "line", "text-field": ["get", "label"], "text-size": 12, "symbol-spacing": 500 }, paint: { "text-color": "#f4f8fa", "text-halo-color": "#18242c", "text-halo-width": 2 } }); instance.addLayer({ id: "osm-taxiway-labels", type: "symbol", source: "osm-airport-ground", minzoom: 14, filter: ["all", ["==", ["get", "kind"], "taxiway"], ["has", "label"]], layout: { visibility: "none", "symbol-placement": "line", "text-field": ["get", "label"], "text-size": 11, "symbol-spacing": 220, "text-allow-overlap": false }, paint: { "text-color": "#ffe48a", "text-halo-color": "#241d0d", "text-halo-width": 2 } }); instance.addLayer({ id: "osm-stand-points", type: "circle", source: "osm-airport-ground", minzoom: 15, filter: ["in", ["get", "kind"], ["literal", ["parking_position", "gate"]]], layout: { visibility: "none" }, paint: { "circle-radius": 4, "circle-color": "#64d7ff", "circle-stroke-color": "#092334", "circle-stroke-width": 1.5 } }); instance.addLayer({ id: "osm-stand-labels", type: "symbol", source: "osm-airport-ground", minzoom: 16, filter: ["in", ["get", "kind"], ["literal", ["parking_position", "gate"]]], layout: { visibility: "none", "text-field": ["get", "label"], "text-size": 10, "text-offset": [0, 1], "text-anchor": "top" }, paint: { "text-color": "#ccefff", "text-halo-color": "#092334", "text-halo-width": 1.5 } });
      instance.addLayer({ id: "osm-runway-name-labels", type: "symbol", source: "osm-airport-ground", minzoom: 12.5, filter: ["all", ["==", ["get", "kind"], "runway"], ["!=", ["get", "label"], ""]], layout: { visibility: "none", "symbol-placement": "line", "text-field": ["get", "label"], "text-size": ["interpolate", ["linear"], ["zoom"], 12.5, 12, 16, 17], "symbol-spacing": 360, "text-letter-spacing": .08, "text-max-angle": 45, "text-rotation-alignment": "map", "text-pitch-alignment": "map", "text-keep-upright": true, "text-allow-overlap": true }, paint: { "text-color": "#58f3ff", "text-halo-color": "#071015", "text-halo-width": 2.6 } });
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
      instance.addLayer({ id: "navigation-airways", type: "line", source: "navigation-airways", paint: { "line-color": ["match", ["get", "airwayLevel"], "high", "#62bfff", "low", "#62ddcf", "#55c8ef"], "line-width": ["interpolate", ["linear"], ["zoom"], 4, 1, 8, 2.4], "line-opacity": .88 } });
      instance.addLayer({ id: "navigation-airway-labels", type: "symbol", source: "navigation-airways", layout: { "symbol-placement": "line", "symbol-spacing": 260, "text-field": ["get", "name"], "text-size": ["interpolate", ["linear"], ["zoom"], 3, 9, 7, 11, 11, 13], "text-letter-spacing": .08, "text-max-angle": 28, "text-rotation-alignment": "map", "text-pitch-alignment": "map", "text-keep-upright": true, "text-padding": 5, "text-allow-overlap": false, "text-ignore-placement": false, "text-optional": true }, paint: { "text-color": ["match", ["get", "airwayLevel"], "high", "#b8e3ff", "low", "#b9fff3", "#c7efff"], "text-halo-color": "#071827", "text-halo-width": 1.8, "text-halo-blur": .35 } });
      instance.addLayer({ id: "navigation-airway-directions", type: "symbol", source: "navigation-airway-legs", minzoom: 6, filter: ["!=", ["get", "directionMarker"], ""], layout: { "symbol-placement": "line", "symbol-spacing": 180, "text-field": ["get", "directionMarker"], "text-size": 8, "text-rotation-alignment": "map", "text-pitch-alignment": "map", "text-keep-upright": false, "text-padding": 3, "text-allow-overlap": false, "text-ignore-placement": false, "text-optional": true }, paint: { "text-color": "#d6f5ff", "text-halo-color": "#071827", "text-halo-width": 1.3 } });
      instance.addLayer({ id: "navigation-airway-distances", type: "symbol", source: "navigation-airway-legs", minzoom: 7, layout: { "symbol-placement": "line-center", "text-field": ["get", "distance"], "text-size": 9, "text-offset": [0, 1.15], "text-rotation-alignment": "map", "text-pitch-alignment": "map", "text-keep-upright": true, "text-padding": 3, "text-allow-overlap": false, "text-ignore-placement": false, "text-optional": true }, paint: { "text-color": "#8baec1", "text-halo-color": "#071827", "text-halo-width": 1.5 } });
      instance.addLayer({ id: "navigation-airway-altitudes", type: "symbol", source: "navigation-airway-legs", minzoom: 8.5, filter: ["!=", ["get", "minimumAltitude"], ""], layout: { "symbol-placement": "line-center", "text-field": ["get", "minimumAltitude"], "text-size": 9, "text-offset": [0, -1.15], "text-rotation-alignment": "map", "text-pitch-alignment": "map", "text-keep-upright": true, "text-padding": 3, "text-allow-overlap": false, "text-ignore-placement": false, "text-optional": true }, paint: { "text-color": "#e4c987", "text-halo-color": "#071827", "text-halo-width": 1.5 } });
      instance.addLayer({ id: "navigation-waypoints", type: "symbol", source: "navigation-navaids", minzoom: 8, layout: { visibility: "none", "icon-image": ["get", "symbol"], "icon-size": ["interpolate", ["linear"], ["zoom"], 8, .58, 12, .82], "icon-allow-overlap": false, "icon-ignore-placement": false, "icon-padding": 2 }, filter: ["==", ["get", "kind"], "航路点"] });
      instance.addLayer({ id: "navigation-navaids", type: "symbol", source: "navigation-navaids", minzoom: 5, layout: { "icon-image": ["get", "symbol"], "icon-size": ["interpolate", ["linear"], ["zoom"], 5, .56, 10, .8], "icon-allow-overlap": false, "icon-ignore-placement": false, "icon-padding": 3 }, filter: ["!=", ["get", "kind"], "航路点"] });
      instance.addLayer({ id: "navigation-waypoint-labels", type: "symbol", source: "navigation-navaids", minzoom: 8.4, filter: ["all", ["==", ["get", "kind"], "航路点"], ["!=", ["get", "routePoint"], true]], layout: { visibility: "none", "text-field": ["get", "label"], "text-size": ["interpolate", ["linear"], ["zoom"], 8.4, 10, 11, 14], "text-offset": [0, 1], "text-anchor": "top", "text-allow-overlap": false, "text-optional": true }, paint: { "text-color": "#d9f3ff", "text-halo-color": "#071827", "text-halo-width": 1.4 } });
      instance.addLayer({ id: "navigation-navaid-labels", type: "symbol", source: "navigation-navaids", minzoom: 5.5, filter: ["all", ["!=", ["get", "kind"], "航路点"], ["!=", ["get", "routePoint"], true]], layout: { "text-field": ["get", "label"], "text-size": 11, "text-offset": [0, 1.15], "text-anchor": "top", "text-allow-overlap": false, "text-optional": true }, paint: { "text-color": "#bceaff", "text-halo-color": "#071827", "text-halo-width": 1.5 } });
      instance.addLayer({ id: "navigation-airports", type: "symbol", source: "navigation-airports", layout: { "icon-image": ["get", "symbol"], "icon-size": ["interpolate", ["linear"], ["zoom"], 4, .55, 9, .82], "icon-allow-overlap": false, "icon-ignore-placement": false, "icon-padding": 4 } });
      instance.addLayer({ id: "navigation-airport-labels", type: "symbol", source: "navigation-airports", minzoom: 5, filter: ["!=", ["get", "routePoint"], true], layout: { "text-field": ["concat", ["get", "code"], "\n", ["get", "name"]], "text-size": ["interpolate", ["linear"], ["zoom"], 5, 10, 9, 14], "text-offset": [0, 1.15], "text-anchor": "top", "text-allow-overlap": false, "text-optional": true }, paint: { "text-color": "#fff0d8", "text-halo-color": "#071827", "text-halo-width": 1.5 } });
      instance.addLayer({ id: "simbrief-route-casing", type: "line", source: "simbrief-route", paint: { "line-color": "#210e20", "line-width": ["interpolate", ["linear"], ["zoom"], 4, 5, 9, 9], "line-opacity": .92 } }); instance.addLayer({ id: "simbrief-route", type: "line", source: "simbrief-route", paint: { "line-color": "#ff6480", "line-width": ["interpolate", ["linear"], ["zoom"], 4, 2.5, 9, 4.5] } }); instance.addLayer({ id: "simbrief-route-points", type: "circle", source: "simbrief-points", paint: { "circle-radius": 4.5, "circle-color": "#ffcf77", "circle-stroke-width": 1.5, "circle-stroke-color": "#6e1c38" } }); instance.addLayer({ id: "simbrief-route-labels", type: "symbol", source: "simbrief-points", minzoom: 5.5, layout: { "text-field": ["get", "label"], "text-size": 11, "text-offset": [0, -1.1], "text-anchor": "bottom", "text-allow-overlap": false, "text-optional": true }, paint: { "text-color": "#ffd5de", "text-halo-color": "#381020", "text-halo-width": 1.5 } });
      instance.addLayer({ id: "flight-airport-halo", type: "circle", source: "flight-airports", paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 8, 9, 12], "circle-color": ["match", ["get", "role"], "DEP", "#4fdcff", "#ffb84d"], "circle-opacity": .24, "circle-blur": .25 } });
      instance.addLayer({ id: "flight-airport-points", type: "circle", source: "flight-airports", paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 5, 9, 8], "circle-color": ["match", ["get", "role"], "DEP", "#4fdcff", "#ffb84d"], "circle-stroke-color": "#071827", "circle-stroke-width": 2 } });
      instance.addLayer({ id: "flight-airport-labels", type: "symbol", source: "flight-airports", layout: { "text-field": ["get", "label"], "text-size": ["interpolate", ["linear"], ["zoom"], 3, 11, 9, 14], "text-line-height": 1.4, "text-letter-spacing": .025, "text-variable-anchor": ["top", "bottom", "left", "right"], "text-radial-offset": 1.15, "text-justify": "auto", "text-padding": 4, "text-allow-overlap": false, "text-ignore-placement": false, "text-optional": true }, paint: { "text-color": ["match", ["get", "role"], "DEP", "#bff5ff", "#ffe0ad"], "text-halo-color": "#071827", "text-halo-width": 2 } });
      instance.addLayer({ id: "traffic-points", type: "circle", source: "traffic", minzoom: 3, paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 3.5, 8, 6.5], "circle-color": "#7fe3a8", "circle-stroke-color": "#07311c", "circle-stroke-width": 2 } }); instance.addLayer({ id: "traffic-labels", type: "symbol", source: "traffic", minzoom: 6, layout: { "text-field": ["get", "callsign"], "text-size": 10, "text-offset": [0, 1.15], "text-anchor": "top", "text-allow-overlap": false }, paint: { "text-color": "#d7ffea", "text-halo-color": "#082417", "text-halo-width": 1.5 } });
      if (openWeatherKey) { instance.addSource("weather-radar", { type: "raster", tiles: [`https://tile.openweathermap.org/map/precipitation_new/{z}/{x}/{y}.png?appid=${openWeatherKey}`], tileSize: 256, attribution: "© OpenWeather" }); instance.addLayer({ id: "weather-radar", type: "raster", source: "weather-radar", layout: { visibility: "none" }, paint: { "raster-opacity": .65, "raster-fade-duration": 0 } }); }
      instance.addLayer({ id: "measurement-line", type: "line", source: "measurement", paint: { "line-color": "#ffdc70", "line-width": 3 } });
      updateViewport(); setMapReady(true);
    });
    instance.on("click", "traffic-points", (event) => { const callsign = event.features?.[0]?.properties?.callsign; if (callsign) setSelectedCallsign(String(callsign)); });
    instance.on("mouseenter", "traffic-points", () => { instance.getCanvas().style.cursor = "pointer"; });
    instance.on("mouseleave", "traffic-points", () => { instance.getCanvas().style.cursor = measureModeRef.current ? "crosshair" : ""; });
    instance.on("moveend", () => { window.clearTimeout(moveTimeout.current); moveTimeout.current = window.setTimeout(updateViewport, 650); });
    instance.on("click", (event) => { if (!measureModeRef.current) return; const nextPoints: Array<[number, number]> = [...measurePointsRef.current, [event.lngLat.lng, event.lngLat.lat]]; measurePointsRef.current = nextPoints; updateMeasurement(nextPoints); setMeasureDistance(distanceInNm(nextPoints)); });
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
  useEffect(() => { if (!mapReady || !map.current || !firBoundary.data) return; (map.current.getSource("fir") as maplibregl.GeoJSONSource).setData(firBoundary.data.data as never); }, [mapReady, firBoundary.data]);
  useEffect(() => { if (!mapReady || !map.current) return; (map.current.getSource("vatglasses") as maplibregl.GeoJSONSource).setData((vatGlasses.data?.features ?? emptyFeatures()) as never); }, [mapReady, vatGlasses.data]);
  useEffect(() => {
    if (!mapReady || !map.current) return;
    const filter = ["all", ["<=", ["get", "min"], vatGlassesFlightLevel], [">=", ["get", "max"], vatGlassesFlightLevel]] as never;
    for (const layerId of mapLayerIds.vatglasses) if (map.current.getLayer(layerId)) map.current.setFilter(layerId, filter);
  }, [mapReady, vatGlassesFlightLevel]);
  useEffect(() => { if (!mapReady || !map.current || !traconCoverage) return; (map.current.getSource("tracon") as maplibregl.GeoJSONSource).setData(traconCoverage as never); }, [mapReady, traconCoverage]);
  useEffect(() => { if (!mapReady || !map.current) return; (map.current.getSource("osm-airport-ground") as maplibregl.GeoJSONSource).setData((airportGround.data ?? emptyFeatures()) as never); }, [mapReady, airportGround.data]);
  useEffect(() => { if (!mapReady || !map.current) return; (map.current.getSource("traffic") as maplibregl.GeoJSONSource).setData(trafficAsFeatures(vatsim.data?.pilots ?? [])); }, [mapReady, vatsim.data?.pilots]);
  useEffect(() => {
    if (!mapReady || !map.current) return;
    (map.current.getSource("simbrief-route") as maplibregl.GeoJSONSource).setData(simbriefRouteFeatures(routePoints.length ? completeRoutePoints : []));
    (map.current.getSource("simbrief-points") as maplibregl.GeoJSONSource).setData(simbriefPointFeatures(simbriefWaypoints));
    (map.current.getSource("flight-airports") as maplibregl.GeoJSONSource).setData(flightAirportFeatures(flightAirports));
    const fitKey = activePlan ? `${activePlan.id}:${activePlan.importedAt}` : "";
    const hasDeparture = flightAirports.some((point) => point.role === "DEP");
    const hasArrival = flightAirports.some((point) => point.role === "ARR");
    if (!fitKey || lastAutoFittedPlanKey === fitKey || !hasDeparture || !hasArrival || completeRoutePoints.length < 2) return;
    lastAutoFittedPlanKey = fitKey;
    fitRouteBounds(map.current, completeRoutePoints, 900);
  }, [mapReady, routePoints, completeRoutePoints, simbriefWaypoints, flightAirports, activePlan]);

  const zoom = (amount: number) => map.current?.zoomTo(map.current.getZoom() + amount);
  const resetMeasurement = () => { measurePointsRef.current = []; (map.current?.getSource("measurement") as maplibregl.GeoJSONSource | undefined)?.setData(emptyFeatures()); setMeasureDistance(0); };
  const toggleMeasurement = () => { setMeasureMode((active) => !active); if (!measureMode) resetMeasurement(); };
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
    try { await persistActivePlan({ ...activePlan, approach: approach ? { name: approach, transition: "", points: [] } : undefined }); } catch { await queryClient.invalidateQueries({ queryKey: ["flight-plans"] }); }
  };
  const applyVatGlassesDataset = () => {
    const dataset = vatGlassesDraft.trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
    if (!dataset) return;
    setVatGlassesDraft(dataset);
    setVatGlassesDataset(dataset);
    setCustomOwnership(undefined);
    try { localStorage.setItem("skyboard-vatglasses-dataset", dataset); } catch { return; }
  };
  const uploadOwnership = async (file?: File) => {
    if (!file) return;
    try {
      const ownership = JSON.parse(await file.text()) as OwnershipFile;
      if (!ownership || typeof ownership !== "object" || !ownership.airspace || typeof ownership.airspace !== "object") throw new Error("文件中缺少 airspace 对象");
      setCustomOwnership(ownership);
    } catch (error) {
      window.alert(`Ownership 文件无效：${error instanceof Error ? error.message : "无法解析 JSON"}`);
    } finally {
      if (ownershipInput.current) ownershipInput.current.value = "";
    }
  };
  const downloadOwnership = () => {
    if (!currentOwnership) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(currentOwnership, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${vatGlassesDataset}-ownership.json`;
    link.click();
    URL.revokeObjectURL(url);
  };
  const dataStatus = navigation.data?.ready ? `${navigationData.data?.airways.length ?? 0} 航段 · ${navigationData.data?.navaids.length ?? 0} 航路点/导航台 · ${navigationData.data?.airports.length ?? 0} 机场` : `AD_HP.csv · ${adHp.data?.length ?? 0} 个国内机场`;
  const navigationState: MapDataState = !navigationLayersEnabled ? "idle" : navigationData.isError || adHp.isError ? "error" : navigationData.isFetching || navigation.isFetching || adHp.isFetching ? "loading" : "ready";
  const navigationDetail = !navigationLayersEnabled ? "相关图层关闭，已暂停范围查询" : navigationData.isError ? navigationData.error.message : adHp.isError ? "机场回退数据加载失败" : navigationData.isFetching ? "正在更新当前可视范围" : dataStatus;
  const firState: MapDataState = !layers.fir ? "idle" : firBoundary.isError ? "error" : firBoundary.isFetching ? "loading" : firBoundary.data?.meta.stale ? "warning" : "ready";
  const firDetail = !layers.fir ? "图层关闭，已暂停加载" : firBoundary.isError ? firBoundary.error.message : firBoundary.data ? `${firBoundary.data.data.features.length} 个边界 · ${cachedSourceLabel(firBoundary.data.meta)}${firBoundary.isFetching ? " · 后台刷新" : ""}` : "等待加载";
  const vatGlassesState: MapDataState = !layers.vatglasses ? "idle" : vatGlasses.isError ? "error" : vatGlasses.isFetching ? "loading" : "ready";
  const vatGlassesDetail = !layers.vatglasses ? "独立图层已关闭" : vatGlasses.isError ? `${vatGlasses.error.message}；该区域可继续使用 FIR / SimAware 边界` : vatGlasses.data ? `${vatGlasses.data.source} · FL${vatGlassesFlightLevel} 显示 ${visibleVatGlassesSectors} / ${vatGlasses.data.features.features.length} 个分层面` : "等待加载";
  const traconState: MapDataState = !layers.tracon ? "idle" : traconBoundary.isError ? "error" : traconBoundary.isFetching ? "loading" : traconBoundary.data?.meta.stale ? "warning" : "ready";
  const traconDetail = !layers.tracon ? "图层关闭，已暂停加载" : traconBoundary.isError ? traconBoundary.error.message : traconBoundary.data ? `${traconBoundary.data.data.features.length} 个扇区 · ${cachedSourceLabel(traconBoundary.data.meta)}${traconBoundary.isFetching ? " · 后台刷新" : ""}` : "等待加载";
  const vatsimState: MapDataState = !vatsimLayersEnabled ? "idle" : vatsim.isError ? "error" : vatsim.isFetching ? "loading" : vatsim.data?.meta.stale ? "warning" : "ready";
  const vatsimDetail = !vatsimLayersEnabled ? "APP 与交通图层关闭，已暂停刷新" : vatsim.isError ? vatsim.error.message : vatsim.data ? `${vatsim.data.controllers.length} 席位 · ${vatsim.data.pilots.length} 航班 · ${cachedSourceLabel(vatsim.data.meta)}${vatsim.isFetching ? " · 后台刷新" : ""}` : "等待加载";
  const airportGroundState: MapDataState = !layers.airportGround || viewport.zoom <= airportGroundLoadZoom ? "idle" : airportGround.isError ? "error" : airportGround.isFetching ? "loading" : airportGround.data?.meta?.stale ? "warning" : "ready";
  const airportGroundDetail = !layers.airportGround ? "图层关闭，已暂停加载" : viewport.zoom <= airportGroundLoadZoom ? `当前 Zoom ${viewport.zoom.toFixed(1)}，放大至 10 以上后加载` : airportGround.isError ? airportGround.error.message : airportGround.data ? `${airportGround.data.features.length} 个地面要素 · ${cachedSourceLabel(airportGround.data.meta)}${airportGround.isFetching ? " · 后台刷新" : ""}` : "等待加载";

  const flightPlanPanelVisible = Boolean(flightPlanPanel && !flightPlanPanelHidden);
  return <div className={`map-page ${flightPlanPanelVisible ? "flight-plan-panel-open" : ""}`}><div className="map-canvas" ref={container} />
    {flightPlanPanelVisible && flightPlanPanel && <FlightPlanPanel data={flightPlanPanel} availableApproaches={availableApproaches} onHide={() => setFlightPlanPanelHidden(true)} onUnload={() => unloadFlightPlanPanel(flightPlanPanel.planId)} onEdit={() => navigate("/flight-plans")} onOpenCharts={(icao) => navigate(`/charts?icao=${encodeURIComponent(icao)}`)} onRemoveAlternate={() => { void removeAlternate(); }} onSelectApproach={(approach) => { void selectApproach(approach); }} onViewSimBrief={() => { window.open("https://dispatch.simbrief.com/briefing/latest", "_blank", "noopener,noreferrer"); }} />}
    {flightPlanPanel && flightPlanPanelHidden && <button className="flight-plan-panel-show" type="button" onClick={() => setFlightPlanPanelHidden(false)}>Show Flight Plan</button>}
    <div className="map-toolbar"><button onClick={() => zoom(1)} aria-label="放大"><Plus size={19} /></button><button onClick={() => zoom(-1)} aria-label="缩小"><Minus size={19} /></button><span /><button onClick={() => { if (map.current) fitRouteBounds(map.current, completeRoutePoints, 650); }} aria-label="定位到计划航路"><Crosshair size={19} /></button><button className={measureMode ? "active" : ""} onClick={toggleMeasurement} aria-label="测量距离"><Ruler size={19} /></button></div>
    <aside className={`map-layers ${layersOpen ? "" : "collapsed"}`}>
      <div className="map-layers-heading"><div><Layers size={18} /><strong>地图图层</strong></div><button onClick={() => setLayersOpen((open) => !open)} aria-label={layersOpen ? "横向收起图层面板" : "展开图层面板"} title={layersOpen ? "横向收起" : "展开图层"}>{layersOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}</button></div>
      {layersOpen && <>
        <div className="map-style-selector" role="group" aria-label="地图图源"><button className={mapStyle === "standard" ? "active" : ""} onClick={() => setMapStyle("standard")}><MapIcon size={14} />标准地图</button><button className={mapStyle === "satellite" ? "active" : ""} onClick={() => setMapStyle("satellite")}><Satellite size={14} />卫星地图</button></div>
        {layers.route && <div className="airway-level-selector"><span>航路级别</span><div role="group" aria-label="高低空航路筛选">{([['all', '全部'], ['high', '高空'], ['low', '低空']] as Array<[AirwayLevel, string]>).map(([value, label]) => <button type="button" className={airwayLevelFilter === value ? "active" : ""} onClick={() => setAirwayLevelFilter(value)} key={value}>{label}</button>)}</div></div>}
        <div className="layer-list">{layerOptions.map(({ key, label }) => <label className="layer-toggle" key={key}><span>{label}</span><input type="checkbox" checked={layers[key]} onChange={() => setLayers((current) => ({ ...current, [key]: !current[key] }))} /><i /></label>)}</div>
        {layers.vatglasses && <div className="vatglasses-controls"><div className="vatglasses-dataset"><input value={vatGlassesDraft} onChange={(event) => setVatGlassesDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") applyVatGlassesDataset(); }} aria-label="VATGlasses 数据集代码" /><button onClick={applyVatGlassesDataset}>加载</button></div><label>显示高度 <span>FL</span><input type="number" min={0} max={600} step={10} value={vatGlassesFlightLevel} onChange={(event) => setVatGlassesFlightLevel(Math.max(0, Math.min(600, Number(event.target.value) || 0)))} /></label><input ref={ownershipInput} hidden type="file" accept="application/json,.json" onChange={(event) => void uploadOwnership(event.target.files?.[0])} /><div className="vatglasses-actions"><button onClick={() => ownershipInput.current?.click()}><Upload size={13} />上传归属</button><button onClick={() => { setCustomOwnership(undefined); if (!customOwnership) void vatGlasses.refetch(); }}>仓库预设</button><button onClick={downloadOwnership} disabled={!currentOwnership}><Download size={13} />下载当前</button></div></div>}
        <div className="map-data-status">
          {!online && <div className="map-offline-note">当前离线，优先显示上次缓存的数据。</div>}
          <MapDataRow label="导航数据" detail={navigationDetail} state={navigationState} />
          <MapDataRow label="FIR 边界" detail={firDetail} state={firState} />
          <MapDataRow label="VATGlasses 扇区" detail={vatGlassesDetail} state={vatGlassesState} />
          <MapDataRow label="APP / TRACON" detail={traconDetail} state={traconState} />
          <MapDataRow label="VATSIM 实时" detail={vatsimDetail} state={vatsimState} />
          <MapDataRow label="OSM 机场地面" detail={airportGroundDetail} state={airportGroundState} />
          {layers.weather && <MapDataRow label="天气雷达" detail={openWeatherKey ? "瓦片图层已启用，随地图按需加载" : "未配置 VITE_OPENWEATHER_API_KEY"} state={openWeatherKey ? "ready" : "error"} />}
        </div>
      </>}
    </aside>
    {selectedPilot && <aside className="traffic-detail-panel"><div className="traffic-detail-header"><div><span>VATSIM FLIGHT</span><strong>{selectedPilot.callsign}</strong></div><button onClick={() => setSelectedCallsign("")} aria-label="关闭航班详情"><X size={18} /></button></div><div className="traffic-route"><strong>{selectedPilot.flight_plan?.departure || "----"}</strong><span><Plane size={22} /></span><strong>{selectedPilot.flight_plan?.arrival || "----"}</strong><small>{selectedPilot.flight_plan?.alternate ? `备降 ${selectedPilot.flight_plan.alternate}` : "在线航班"}</small></div><div className="traffic-detail-grid"><div><span>注册号</span><strong>{pilotRegistration(selectedPilot)}</strong></div><div><span>机型</span><strong>{selectedPilot.flight_plan?.aircraft_short || "未提供"}</strong></div><div><span>高度</span><strong>{selectedPilot.altitude.toLocaleString()} ft</strong></div><div><span>地速</span><strong>{selectedPilot.groundspeed} kts</strong></div><div><span>航向</span><strong>{selectedPilot.heading}°</strong></div><div><span>应答机</span><strong className="squawk">{selectedPilot.transponder || "----"}</strong></div><div><span>飞行规则</span><strong>{flightRules(selectedPilot.flight_plan?.flight_rules)}</strong></div><div><span>计划高度</span><strong>{selectedPilot.flight_plan?.altitude ? `${selectedPilot.flight_plan.altitude} ft` : "未提供"}</strong></div><div><span>QNH</span><strong>{selectedPilot.qnh_mb || "----"} hPa</strong></div><div><span>巡航 TAS</span><strong>{selectedPilot.flight_plan?.cruise_tas ? `${selectedPilot.flight_plan.cruise_tas} kts` : "未提供"}</strong></div></div><div className="traffic-detail-card"><span>飞行员</span><strong>{selectedPilot.name}</strong><small>VATSIM CID {selectedPilot.cid}</small></div><div className="traffic-detail-card"><span>航路</span><p>{selectedPilot.flight_plan?.route || "未提交航路"}</p></div><div className="traffic-detail-footer">最后更新：{new Date(selectedPilot.last_updated).toLocaleTimeString("zh-CN")}</div></aside>}
    {measureMode && <div className="measure-card"><div><Ruler size={16} /><strong>距离测量</strong></div><span>{measureDistance.toFixed(1)} NM</span><button onClick={resetMeasurement}><RotateCcw size={14} />清除</button></div>}
    <div className="map-legend"><span className="map-legend-item"><i />导航航路</span><span className="map-legend-item"><b />SimBrief 航路</span><span className="map-legend-item"><ChartSymbolExample type="airport" />IFR 机场</span><span className="map-legend-item"><ChartSymbolExample type="airport-vfr" />VFR 机场</span><span className="map-legend-item"><ChartSymbolExample type="waypoint" />RNAV 点</span><span className="map-legend-item"><ChartSymbolExample type="intersection" />航路交汇点</span><span className="map-legend-item"><ChartSymbolExample type="ndb" />NDB</span><span className="map-legend-item"><ChartSymbolExample type="dme" />DME</span><span className="map-legend-item"><ChartSymbolExample type="vor-dme" />VOR/DME</span><span className="map-legend-item"><ChartSymbolExample type="tacan" />TACAN</span><span className="map-legend-item"><ChartSymbolExample type="vortac" />VORTAC</span></div><div className="map-attribution">FIR: VAT-Spy/Volanta · 高精度扇区: VATGlasses · TRACON: SimAware · 航班: VATSIM · 机场地面: OpenStreetMap · 航图符号参考 Jeppesen/Navigraph · 地图 © {mapStyle === "satellite" ? satelliteMapProvider : standardMapProvider}</div>
  </div>;
}

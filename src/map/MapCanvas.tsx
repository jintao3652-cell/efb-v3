import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import type { Map as MapLibreMap, StyleSpecification } from "maplibre-gl";
import { useQuery } from "@tanstack/react-query";
import { buildBaseStyle, tintBaseMap } from "./basemap";
import { addOverlays, recolorOverlays, syncOverlayVisibility } from "./overlays";
import { applyChartLayer, chartPdf, peekChartRaster, rememberChartRaster, renderChartRaster, releaseChartPdf, type ChartRaster } from "./chart-overlay";
import { chartQuad } from "../lib/chart-geo";
import { jeppGeoBounds } from "../lib/jepp";
import { ensureTrafficPlaneIcons, TRAFFIC_PLANE_ACTIVE_ICON, TRAFFIC_PLANE_ICON } from "./traffic-plane";
import { useAppStore, type SelectedPoint } from "../stores/app-store";
import { loadAdHpAirports } from "../lib/airport-data";
import { airports as fallbackAirports } from "../lib/data";
import { isTauri, getNavigationMapData, getNavigationProcedurePoints, getNavigationRunwayEnds, type NavigationMapData, type NavigationRunwayEnds, type MapViewport } from "../lib/tauri";
import { applyActiveFirControllers, loadFirBoundaries, loadTraconBoundaries, type VatsimPilot } from "../lib/airspace";
import { loadOnlineTraffic } from "../lib/traffic";
import { pilotRouteQueryOptions, pilotTrackQueryOptions } from "../lib/pilot-track";
import { getGates, getRunways, type XflyGate } from "../lib/xfly";
import { loadOsmAirportGround } from "../lib/osm-airport";
import type { FlightRoutePoint } from "../types";

type FC = { type: "FeatureCollection"; features: GeoJsonFeature[] };
type GeoJsonFeature = { type: "Feature"; properties: Record<string, unknown>; geometry: { type: string; coordinates: unknown } };

const emptyFC = (): FC => ({ type: "FeatureCollection", features: [] });

/**
 * 机位数据跟着视野变化重载（每次 moveend 都会触发），机场机位基本不变，
 * 本地缓存 10 分钟，避免拖动地图时反复打 XFS 接口。
 */
const gateCache = new Map<string, { at: number; rows: XflyGate[] }>();
async function loadGatesCached(icao: string) {
  const hit = gateCache.get(icao);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.rows;
  const rows = await getGates(icao);
  gateCache.set(icao, { at: Date.now(), rows });
  return rows;
}
const RADAR_TILES = import.meta.env.VITE_OPENWEATHER_API_KEY?.trim()
  ? `https://tile.openweathermap.org/map/precipitation_new/{z}/{x}/{y}.png?appid=${import.meta.env.VITE_OPENWEATHER_API_KEY.trim()}`
  : undefined;

function nmBetween(a: [number, number], b: [number, number]) {
  const R = 3440.065;
  const toRad = (value: number) => (value * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function airwayCollection(data: NavigationMapData): FC {
  return {
    type: "FeatureCollection",
    features: data.airways
      .filter((airway) => airway.coordinates.length > 1)
      .map((airway) => {
        let length = 0;
        for (let index = 1; index < airway.coordinates.length; index += 1) length += nmBetween(airway.coordinates[index - 1], airway.coordinates[index]);
        return {
          type: "Feature",
          properties: { name: airway.name, length: `${Math.round(length)}`, kind: airway.airwayType },
          geometry: { type: "LineString", coordinates: airway.coordinates },
        };
      }),
  };
}

function waypointCollection(data: NavigationMapData): FC {
  const features = (data.navaids ?? [])
    .filter((point) => /航路点|GPS|WP|REP/i.test(point.kind ?? "") || !point.kind)
    .map((point) => ({
      type: "Feature" as const,
      properties: { ident: point.ident, name: point.name, kind: point.kind },
      geometry: { type: "Point" as const, coordinates: [point.longitude, point.latitude] },
    }));
  return { type: "FeatureCollection", features };
}

function airportCollection(points: Array<{ ident: string; name?: string; cn?: string; iata?: string; international?: boolean; latitude: number; longitude: number }>): FC {
  return {
    type: "FeatureCollection",
    features: points.map((point) => ({
      type: "Feature",
      properties: {
        ident: point.ident,
        name: point.name ?? "",
        // 标签：国内机场两行「ICAO + 中文名」（AD_HP），国外机场维持只标 ICAO。
        label: point.cn ? `${point.ident}\n${point.cn}` : point.ident,
        // 大机场：AD_HP 标记为国际机场（或导航库机型有 IATA）。低缩放级别只标注这批，避免标签铺满屏幕。
        major: point.international ?? (Boolean(point.iata) || /国际|International/i.test(point.name ?? "")),
      },
      geometry: { type: "Point", coordinates: [point.longitude, point.latitude] },
    })),
  };
}

/**
 * 程序折线的平滑绘制：
 * - 普通拐角用二次贝塞尔圆角（切点向两侧各收一段，航路点标记仍在原位，不丢精度）；
 * - RF 腿按圆心真实加密成圆弧，不再画成直线弦。
 * 单位是度；用等距圆柱近似（经度乘 cos(纬度)）保证弧在图上是圆的不是椭圆。
 */
function smoothProcedurePath(
  vertices: Array<{ coord: [number, number]; arcCenter: [number, number] | null }>,
): Array<[number, number]> {
  const cosLat = (latitude: number) => Math.cos((latitude * Math.PI) / 180);
  const planarDistance = (a: [number, number], b: [number, number]) => {
    const midCos = cosLat((a[1] + b[1]) / 2);
    return Math.hypot((b[0] - a[0]) * midCos, b[1] - a[1]);
  };
  const out: Array<[number, number]> = [];
  if (vertices.length === 0) return out;
  out.push(vertices[0].coord);
  for (let index = 1; index < vertices.length; index += 1) {
    const previous = vertices[index - 1];
    const current = vertices[index];
    const next = vertices[index + 1];
    // RF 腿：绕 arcCenter（[lat, lon]）从上一点画真实圆弧到本点。
    if (current.arcCenter) {
      const [centerLatitude, centerLongitude] = current.arcCenter;
      const midCos = cosLat(centerLatitude);
      const toXY = ([longitude, latitude]: [number, number]): [number, number] =>
        [(longitude - centerLongitude) * midCos, latitude - centerLatitude];
      const start = toXY(previous.coord);
      const end = toXY(current.coord);
      const radius = (Math.hypot(...start) + Math.hypot(...end)) / 2;
      if (radius > 1e-9) {
        const a0 = Math.atan2(start[1], start[0]);
        const a1 = Math.atan2(end[1], end[0]);
        let sweep = a1 - a0;
        while (sweep > Math.PI) sweep -= 2 * Math.PI;
        while (sweep < -Math.PI) sweep += 2 * Math.PI;
        const steps = Math.min(96, Math.max(10, Math.round((Math.abs(sweep) * radius * 60) / 0.4)));
        for (let step = 1; step <= steps; step += 1) {
          const angle = a0 + (sweep * step) / steps;
          out.push([centerLongitude + (Math.cos(angle) * radius) / midCos, centerLatitude + Math.sin(angle) * radius]);
        }
        // 弧终点强制落在真实航路点上（半径取均值时末点可能有米级偏差）。
        out[out.length - 1] = current.coord;
      } else {
        out.push(current.coord);
      }
      continue;
    }
    // 端点、以及紧邻 RF 腿的顶点不做圆角（弧必须从精确位置起笔）。
    if (!next || next.arcCenter) {
      out.push(current.coord);
      continue;
    }
    // 普通拐角：切点向前后各收 min(35% 边长, 3 海里)，二次贝塞尔过顶点。
    const cut = Math.min(
      0.35 * planarDistance(previous.coord, current.coord),
      0.35 * planarDistance(current.coord, next.coord),
      0.05,
    );
    const midCos = cosLat(current.coord[1]);
    const direction = (from: [number, number], to: [number, number]): [number, number] => {
      const dx = (to[0] - from[0]) * midCos;
      const dy = to[1] - from[1];
      const length = Math.hypot(dx, dy) || 1;
      return [dx / length, dy / length];
    };
    const incoming = direction(previous.coord, current.coord);
    const outgoing = direction(current.coord, next.coord);
    if (cut <= 1e-6 || incoming[0] * outgoing[0] + incoming[1] * outgoing[1] < -0.99) {
      // 边太短（或 180° 掉头，圆角反而画成小圈）就保留尖角。
      out.push(current.coord);
      continue;
    }
    const entry: [number, number] = [current.coord[0] - (incoming[0] * cut) / midCos, current.coord[1] - incoming[1] * cut];
    const exit: [number, number] = [current.coord[0] + (outgoing[0] * cut) / midCos, current.coord[1] + outgoing[1] * cut];
    out.push(entry);
    const steps = 14;
    for (let step = 1; step < steps; step += 1) {
      const t = step / steps;
      const u = 1 - t;
      out.push([
        u * u * entry[0] + 2 * u * t * current.coord[0] + t * t * exit[0],
        u * u * entry[1] + 2 * u * t * current.coord[1] + t * t * exit[1],
      ]);
    }
    out.push(exit);
  }
  return out;
}

function procedureCollection(
  points: FlightRoutePoint[],
  extraStart?: [number, number] | null,
  extraEnd?: [number, number] | null,
): { line: FC; nodes: FC } {
  // SID 从跑道阈值起笔、STAR/进近画到跑道阈值收笔，航段和跑道在图上连成一体。
  const vertices: Array<{ coord: [number, number]; arcCenter: [number, number] | null }> = [
    ...(extraStart ? [{ coord: extraStart, arcCenter: null }] : []),
    ...points.map((point) => ({
      coord: [point.longitude, point.latitude] as [number, number],
      arcCenter: point.arcCenter ?? null,
    })),
    ...(extraEnd ? [{ coord: extraEnd, arcCenter: null }] : []),
  ];
  if (vertices.length < 2) return { line: emptyFC(), nodes: emptyFC() };
  const line: FC = {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: { name: points[0]?.ident ?? "" },
      geometry: { type: "LineString", coordinates: smoothProcedurePath(vertices) },
    }],
  };
  const nodes: FC = {
    type: "FeatureCollection",
    features: points.map((point, index) => ({
      type: "Feature",
      properties: { ident: point.ident, label: point.ident, index },
      geometry: { type: "Point", coordinates: [point.longitude, point.latitude] },
    })),
  };
  return { line, nodes };
}

/** 程序跑道：两端都有坐标画沥青色实线，缺对端退化为只标阈值点。 */
function runwayCollection(ends: NavigationRunwayEnds | null): FC {
  if (!ends) return emptyFC();
  const features: GeoJsonFeature[] = [];
  if (ends.reciprocal) {
    features.push({
      type: "Feature",
      properties: { runway: ends.runway },
      geometry: {
        type: "LineString",
        coordinates: [
          [ends.primary.longitude, ends.primary.latitude],
          [ends.reciprocal.longitude, ends.reciprocal.latitude],
        ],
      },
    });
  }
  for (const end of [ends.primary, ends.reciprocal]) {
    if (!end) continue;
    features.push({
      type: "Feature",
      properties: { label: `RW${end.ident}` },
      geometry: { type: "Point", coordinates: [end.longitude, end.latitude] },
    });
  }
  return { type: "FeatureCollection", features };
}

function pilotDetail(pilot: VatsimPilot) {
  const plan = pilot.flight_plan;
  const legs = plan?.departure && plan?.arrival ? `${plan.departure}–${plan.arrival}` : "";
  const type = plan?.aircraft_short || plan?.aircraft || "";
  return [
    `${Math.round(pilot.altitude / 100) * 100}ft`,
    `${Math.round(pilot.groundspeed)}kt`,
    type,
    legs,
  ].filter(Boolean).join(" · ");
}

/** 一条折线（历史轨迹 / 计划航路），点少于 2 个时不画。 */
function lineCollection(points: Array<{ latitude: number; longitude: number }>): FC {
  if (points.length < 2) return emptyFC();
  return {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: {},
      geometry: { type: "LineString", coordinates: points.map((point) => [point.longitude, point.latitude]) },
    }],
  };
}

function trafficCollection(pilots: VatsimPilot[]): FC {
  return {
    type: "FeatureCollection",
    features: pilots
      .filter((pilot) => Number.isFinite(pilot.latitude) && Number.isFinite(pilot.longitude))
      .map((pilot) => ({
        type: "Feature",
        properties: { callsign: pilot.callsign, detail: pilotDetail(pilot), heading: pilot.heading, cid: pilot.cid },
        geometry: { type: "Point", coordinates: [pilot.longitude, pilot.latitude] },
      })),
  };
}

export interface MapCanvasHandle {
  flyToAirport: (latitude: number, longitude: number, zoom?: number) => void;
  fitBounds: (points: Array<{ latitude: number; longitude: number }>, padding?: number) => void;
  /** 把镜头框到当前选中机组的历史轨迹 + 计划航路上（卡片上的「看整趟航路」）。 */
  framePilotRoute: () => void;
  /** 把镜头框到当前叠加的航图覆盖范围内。 */
  frameChart: () => void;
  zoomBy: (delta: number) => void;
  resetView: () => void;
}

interface MapCanvasProps {
  variant?: "nav" | "route";
  routePoints?: FlightRoutePoint[];
  onAirportClick?: (ident: string) => void;
  onMapClick?: () => void;
  onReady?: () => void;
  initialView?: { center: [number, number]; zoom: number };
}

export const MapCanvas = forwardRef<MapCanvasHandle, MapCanvasProps>(function MapCanvas(
  { variant = "nav", routePoints, onAirportClick, onMapClick, onReady, initialView },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const readyRef = useRef(false);

  const theme = useAppStore((state) => state.theme);
  const baseMap = useAppStore((state) => state.baseMap);
  const layers = useAppStore((state) => state.layers);
  const procedure = useAppStore((state) => state.procedure);
  const groundMode = useAppStore((state) => state.groundMode);
  const setSelectedPoint = useAppStore((state) => state.setSelectedPoint);
  const selectedPoint = useAppStore((state) => state.selectedPoint);
  const chartOverlay = useAppStore((state) => state.chartOverlay);
  const setChartOverlayStatus = useAppStore((state) => state.setChartOverlayStatus);
  /** 当前已渲染好的航图栅格；key 覆盖「哪张图 + 纸底模式 + 主题」，变了才重画。 */
  const chartRasterRef = useRef<{ key: string; raster: ChartRaster } | null>(null);

  const navRef = useRef<NavigationMapData | null>(null);
  /** 地图每次 moveend 递增，用来让「按视野加载」的图层（地面/机位）重新取数。 */
  const [viewTick, setViewTick] = useState(0);
  const routeRef = useRef<FC>(emptyFC());
  const trafficRef = useRef<FC>(emptyFC());
  /** 选中机组的历史轨迹与计划航路，单独两条 source，避免和签派航路互相覆盖。 */
  const trackRef = useRef<FC>(emptyFC());
  const pilotRouteRef = useRef<FC>(emptyFC());
  const fittedAnchorRef = useRef("");
  /** 用户是点飞机选中的：镜头已经移到他身上，别让轨迹回来后自动框选把镜头又拉走。 */
  const keepClickCenterRef = useRef(false);
  const groundRef = useRef<FC>(emptyFC());
  const airspaceRef = useRef<{ all: FC; active: FC }>({ all: emptyFC(), active: emptyFC() });

  const viewportRef = useRef<{ bbox: [number, number, number, number]; zoom: number }>({ bbox: [73, 18, 135, 54], zoom: 4.2 });
  const navRequestRef = useRef(0);
  const applyRef = useRef<(data: NavigationMapData | null) => void>(() => undefined);
  const onReadyRef = useRef<(() => void) | undefined>(onReady);

  useEffect(() => { onReadyRef.current = onReady; }, [onReady]);
  const loadRef = useRef<() => Promise<void>>(async () => undefined);

  const adHp = useQuery({ queryKey: ["ad-hp-airports"], queryFn: loadAdHpAirports, staleTime: Infinity, enabled: variant === "nav" });
  const trafficSource = useAppStore((state) => state.trafficSource);
  const online = useQuery({
    queryKey: ["online-traffic", trafficSource],
    queryFn: ({ signal }) => loadOnlineTraffic(trafficSource, signal),
    enabled: variant === "nav",
    retry: 1,
    retryDelay: 900,
    refetchInterval: 25_000,
    staleTime: 15_000,
    networkMode: "always",
  });

  /**
   * 点中的机组：先按呼号在最新在线快照里找回完整记录（CID / 上线时间 / 计划），
   * 再凭这些去查轨迹。快照每 25 秒刷新一次，key 用 CID + 上线时间，数据本身
   * 不会因为刷新而失效。
   */
  const selectedPilot = useMemo(() => {
    if (!selectedPoint?.cid) return null;
    return (online.data?.pilots ?? []).find((pilot) => pilot.callsign === selectedPoint.ident) ?? null;
  }, [online.data, selectedPoint]);
  const trackQuery = useQuery(pilotTrackQueryOptions(selectedPilot, trafficSource));
  const pilotRouteText = (selectedPilot?.flight_plan?.route || trackQuery.data?.routeText || "").trim();
  const pilotRouteQuery = useQuery(pilotRouteQueryOptions(pilotRouteText));

  const pushSource = useCallback((id: string, data: FC) => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    const source = map.getSource(id) as maplibregl.GeoJSONSource | undefined;
    source?.setData(data as never);
  }, []);

  const applyNavData = useCallback((data: NavigationMapData | null) => {
    if (!data) return;
    pushSource("ov-airways", airwayCollection(data));
    pushSource("ov-waypoints", waypointCollection(data));
    // 国内机场中文名来自 AD_HP.csv（随本地 NAIP 数据包更新）；导航库（DFD v2）给的是英文名。
    const cnNames = new Map((adHp.data ?? []).map((airport) => [airport.icao, airport] as const));
    const airports: Array<{ ident: string; name: string; cn?: string; iata?: string; international?: boolean; latitude: number; longitude: number }> = data.airports.length
      ? data.airports.map((point) => {
          const local = cnNames.get(point.ident);
          return {
            ident: point.ident,
            name: local?.name ?? point.name,
            cn: local?.name,
            iata: point.iata,
            // 仅当 AD_HP 明确标记国际机场才强制 major；false 时让 IATA / 名称规则兜底，
            // 避免导航库里带 IATA 的机场在低缩放级别消失。
            international: local?.international || undefined,
            latitude: point.latitude,
            longitude: point.longitude,
          };
        })
      : (adHp.data ?? fallbackAirports)
          .filter((airport) => {
            const [west, south, east, north] = viewportRef.current.bbox;
            return airport.longitude >= west && airport.longitude <= east && airport.latitude >= south && airport.latitude <= north;
          })
          .slice(0, 400)
          .map((airport) => ({ ident: airport.icao, name: airport.name, cn: airport.name, iata: airport.iata, international: airport.international, latitude: airport.latitude, longitude: airport.longitude }));
    pushSource("ov-airports", airportCollection(airports));
  }, [adHp.data, pushSource]);

  const loadNavigation = useCallback(async () => {
    if (variant !== "nav") return;
    const map = mapRef.current;
    if (!map) return;
    const bounds = map.getBounds();
    const zoom = map.getZoom();
    viewportRef.current = { bbox: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()], zoom };
    if (!isTauri()) {
      applyRef.current({ airports: [], navaids: [], airways: [] });
      return;
    }
    if (zoom < 3.2) return;
    const requestId = ++navRequestRef.current;
    const viewport: MapViewport = { west: bounds.getWest(), south: bounds.getSouth(), east: bounds.getEast(), north: bounds.getNorth(), zoom };
    try {
      const data = await getNavigationMapData(viewport);
      if (requestId !== navRequestRef.current) return;
      navRef.current = data;
      applyRef.current(data);
    } catch {
      /* 导航数据库未连接时静默降级 */
    }
  }, [applyNavData, variant]);

  const installOverlays = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    if (useAppStore.getState().baseMap === "vector") tintBaseMap(map, useAppStore.getState().theme);
    addOverlays(map, useAppStore.getState().theme, RADAR_TILES);
    // 飞机标记是 addImage 加进去的位图，图层引用时不阻塞，图标到位后 MapLibre 自动重绘。
    void ensureTrafficPlaneIcons(map);
    readyRef.current = true;
    syncOverlayVisibility(map, useAppStore.getState().layers);
    applyRef.current(navRef.current ?? { airports: [], navaids: [], airways: [] });
    pushSource("ov-route", routeRef.current);
    pushSource("ov-traffic", trafficRef.current);
    pushSource("ov-track", trackRef.current);
    pushSource("ov-pilot-route", pilotRouteRef.current);
    pushSource("ov-ground", groundRef.current);
    pushSource("ov-airspace", airspaceRef.current.all);
    pushSource("ov-control", airspaceRef.current.active);
    // 切主题 / 底图会 setStyle 把 source 全清掉，已渲染的航图栅格要重新贴回去。
    const raster = chartRasterRef.current?.raster;
    if (raster) applyChartLayer(map, raster, useAppStore.getState().layers.chart, useAppStore.getState().chartOverlay?.opacity ?? 1);
  }, [applyNavData, pushSource]);

  // 点选一架航班后把它的图标换成琥珀色：颜色是唯一的状态信号，形状保持不变。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current || !map.getLayer("ov-traffic")) return;
    const callsign = selectedPoint?.type === "waypoint" ? selectedPoint.ident : "";
    map.setLayoutProperty("ov-traffic", "icon-image", [
      "case", ["==", ["get", "callsign"], callsign], TRAFFIC_PLANE_ACTIVE_ICON, TRAFFIC_PLANE_ICON,
    ]);
  }, [selectedPoint, theme]);

  useEffect(() => { applyRef.current = applyNavData; }, [applyNavData]);
  useEffect(() => { loadRef.current = loadNavigation; }, [loadNavigation]);

  // 初始化地图：等容器拿到尺寸再建图。零尺寸容器会让 MapLibre 停在 noTiles 状态（生产包里表现为地图空白）。
  useEffect(() => {
    const element = containerRef.current;
    if (!element || mapRef.current) return;
    let raf = 0;
    let disposed = false;
    let created: MapLibreMap | null = null;
    let observer: ResizeObserver | null = null;

    const boot = () => {
      if (disposed) return;
      if (element.clientWidth < 32 || element.clientHeight < 32) {
        raf = requestAnimationFrame(boot);
        return;
      }
      const state = useAppStore.getState();
      const map = new maplibregl.Map({
        container: element,
        style: buildBaseStyle(state.theme, state.baseMap),
        center: initialView?.center ?? [112.5, 33.2],
        zoom: initialView?.zoom ?? 4.4,
        minZoom: 2,
        maxZoom: 17,
        attributionControl: false,
        dragRotate: false,
        pitchWithRotate: false,
        fadeDuration: 120,
      });
      created = map;
      mapRef.current = map;
      // 开发期调试钩子：控制台里能拿到 map 实例做投影、图层排查（生产包不挂）。
      if (import.meta.env.DEV) (window as unknown as { __efbMap?: MapLibreMap }).__efbMap = map;
      map.on("error", (event) => console.error("MAPERR", (event as unknown as { error?: { message?: string } }).error?.message ?? "unknown"));
      map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
      // 面板展开/收起会改变容器尺寸，MapLibre 自带 observer 在 WebView 里偶尔漏掉首帧，这里显式兜底。
      observer = new ResizeObserver(() => map.resize());
      observer.observe(element);
      map.on("load", () => {
        installOverlays();
        void loadRef.current();
        onReadyRef.current?.();
      });
      window.setTimeout(() => { if (!disposed) map.resize(); }, 350);
      map.on("moveend", () => { void loadRef.current(); setViewTick((value) => value + 1); });
      map.on("click", (event) => {
        const features = map.queryRenderedFeatures(event.point, { layers: ["ov-airport", "ov-waypoint", "ov-traffic"] });
        const feature = features[0];
        if (!feature) { onMapClick?.(); return; }
        const props = feature.properties ?? {};
        const coordinates = ((feature.geometry as { coordinates?: [number, number] }).coordinates ?? [0, 0]) as [number, number];
        if (feature.layer?.id === "ov-airport") {
          const ident = String(props.ident ?? "");
          if (ident) {
            setSelectedPoint({ type: "airport", ident, name: String(props.name ?? ""), latitude: coordinates[1], longitude: coordinates[0] });
            onAirportClick?.(ident);
          }
          return;
        }
        if (feature.layer?.id === "ov-traffic") {
          const label = useAppStore.getState().trafficSource === "vatsim" ? "VATSIM" : "XFS";
          setSelectedPoint({
            type: "waypoint",
            ident: String(props.callsign ?? ""),
            name: `${props.detail ?? ""}`,
            latitude: coordinates[1],
            longitude: coordinates[0],
            detail: label,
            cid: Number(props.cid) || 0,
          });
          // 点中飞机就把镜头挪到它身上，且只挪这一次：后续 25 秒一次的交通快照刷新
          // 不会再拉镜头（否则用户手动平移会被一直抢回去），也不跟随移动。
          // 轨迹回来后的「自动框整趟」也跳过——否则两秒后镜头又缩到航线全景，飞机不再居中。
          keepClickCenterRef.current = true;
          map.easeTo({ center: coordinates, duration: 600, essential: true });
          return;
        }
        const ident = String(props.ident ?? "");
        const kind = /VOR|NDB|DME|TACAN/i.test(String(props.kind ?? "")) ? "navaid" : "waypoint";
        setSelectedPoint({ type: kind, ident, name: String(props.kind ?? ""), latitude: coordinates[1], longitude: coordinates[0] } as SelectedPoint);
      });
      let hovered = false;
      map.on("mousemove", (event) => {
        const next = map.queryRenderedFeatures(event.point, { layers: ["ov-airport", "ov-waypoint", "ov-traffic"] }).length > 0;
        if (next !== hovered) {
          hovered = next;
          map.getCanvas().style.cursor = next ? "pointer" : "";
        }
      });
    };

    boot();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      observer?.disconnect();
      readyRef.current = false;
      mapRef.current = null;
      created?.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 主题 / 底图切换
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    readyRef.current = false;
    map.setStyle(buildBaseStyle(theme, baseMap) as StyleSpecification, { diff: false });
    map.once("style.load", () => installOverlays());
  }, [theme, baseMap, installOverlays]);

  // 主题色变化时仅改涂料
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    recolorOverlays(map, theme);
  }, [theme]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    syncOverlayVisibility(map, layers);
  }, [layers]);

  // 航路数据（浏览器模式回退到 AD_HP 机场）
  useEffect(() => {
    if (!adHp.data) return;
    applyNavData(navRef.current ?? { airports: [], navaids: [], airways: [] });
  }, [adHp.data, applyNavData]);

  // 在线交通（XFS / VATSIM，由设置决定）
  useEffect(() => {
    const pilots = online.data?.pilots ?? [];
    trafficRef.current = trafficCollection(pilots);
    pushSource("ov-traffic", trafficRef.current);
  }, [online.data, pushSource]);

  // 选中机组的历史轨迹与计划航路：换机组 / 取消选中时都会重推，取消即清空。
  useEffect(() => {
    trackRef.current = lineCollection(trackQuery.data?.points ?? []);
    pushSource("ov-track", trackRef.current);
  }, [trackQuery.data, pushSource]);

  useEffect(() => {
    // 航路串里的首尾通常是 SID/STAR 名，解析不到坐标；用机场库把起降场补到两端，
    // 计划航路才会从机场画到机场。
    const points = pilotRouteQuery.data?.points ?? [];
    const departure = trackQuery.data?.departure || selectedPilot?.flight_plan?.departure || "";
    const arrival = trackQuery.data?.arrival || selectedPilot?.flight_plan?.arrival || "";
    const catalog = adHp.data ?? [];
    const depAirport = departure ? catalog.find((item) => item.icao === departure) : undefined;
    const arrAirport = arrival ? catalog.find((item) => item.icao === arrival) : undefined;
    pilotRouteRef.current = lineCollection([
      ...(depAirport ? [{ latitude: depAirport.latitude, longitude: depAirport.longitude }] : []),
      ...points,
      ...(arrAirport ? [{ latitude: arrAirport.latitude, longitude: arrAirport.longitude }] : []),
    ]);
    pushSource("ov-pilot-route", pilotRouteRef.current);
  }, [pilotRouteQuery.data, trackQuery.data, selectedPilot, adHp.data, pushSource]);

  // 轨迹回来后把镜头框到整趟航线，同一趟连线只自动框一次（刷新快照不会反复拉镜头）。
  useEffect(() => {
    const map = mapRef.current;
    const track = trackQuery.data;
    if (!map || !readyRef.current || !track || track.points.length < 2) return;
    if (fittedAnchorRef.current === track.anchor) return;
    fittedAnchorRef.current = track.anchor;
    // 点飞机进来的：镜头已经在飞机上，这次不自动框；想看整趟用卡片上的按钮。
    if (keepClickCenterRef.current) {
      keepClickCenterRef.current = false;
      return;
    }
    const bounds = new maplibregl.LngLatBounds();
    for (const point of track.points) bounds.extend([point.longitude, point.latitude]);
    for (const point of pilotRouteQuery.data?.points ?? []) bounds.extend([point.longitude, point.latitude]);
    map.fitBounds(bounds, { padding: 80, duration: 800, maxZoom: 9 });
  }, [trackQuery.data, pilotRouteQuery.data]);

  // 取消选中或改选别的航班后允许下一次重新框选。
  useEffect(() => {
    if (!selectedPoint?.cid) {
      fittedAnchorRef.current = "";
      keepClickCenterRef.current = false;
    }
  }, [selectedPoint?.cid]);

  // FIR / TRACON 边界
  useEffect(() => {
    if (variant !== "nav") return;
    let cancelled = false;
    void (async () => {
      try {
        const [fir, tracon] = await Promise.all([loadFirBoundaries(), loadTraconBoundaries()]);
        if (cancelled) return;
        const controllers = online.data?.controllers ?? [];
        const active = applyActiveFirControllers(fir.data, controllers);
        const all = [...fir.data.features, ...tracon.data.features].map((feature) => ({
          ...feature,
          properties: { ...feature.properties, label: String(feature.properties.id ?? feature.properties.name ?? "") },
        }));
        const activeFeatures = active.features
          .filter((feature) => feature.properties.active)
          .map((feature) => ({ ...feature, properties: { ...feature.properties, label: String(feature.properties.activeCallsign ?? "") } }));
        airspaceRef.current = { all: { type: "FeatureCollection", features: all }, active: { type: "FeatureCollection", features: activeFeatures } };
        pushSource("ov-airspace", airspaceRef.current.all);
        pushSource("ov-control", airspaceRef.current.active);
      } catch {
        /* 边界数据不可达时保持空图层 */
      }
    })();
    return () => { cancelled = true; };
  }, [variant, online.data, pushSource]);

  // 程序叠加：航段 + 程序跑道一起画，数据到位后自动框选到程序范围。
  useEffect(() => {
    if (!procedure) {
      pushSource("ov-procedure", emptyFC());
      pushSource("ov-procedure-points", emptyFC());
      pushSource("ov-proc-runway", emptyFC());
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        // 航段与跑道两端互不依赖，并行取。
        const [rows, runwayEnds] = await Promise.all([
          getNavigationProcedurePoints(procedure.id, procedure.runway, procedure.transition),
          procedure.runway ? getNavigationRunwayEnds(procedure.icao, procedure.runway) : Promise.resolve(null),
        ]);
        if (cancelled) return;
        const threshold: [number, number] | null = runwayEnds
          ? [runwayEnds.primary.longitude, runwayEnds.primary.latitude]
          : null;
        const built = procedureCollection(
          rows,
          procedure.kind === "SID" ? threshold : null,
          procedure.kind === "SID" ? null : threshold,
        );
        pushSource("ov-procedure", built.line);
        pushSource("ov-procedure-points", built.nodes);
        pushSource("ov-proc-runway", runwayCollection(runwayEnds));
        // 自动定位/放大：程序航段 + 跑道两端一起进视野。
        const map = mapRef.current;
        if (map && readyRef.current) {
          const bounds = new maplibregl.LngLatBounds();
          for (const point of rows) bounds.extend([point.longitude, point.latitude]);
          if (runwayEnds) {
            bounds.extend([runwayEnds.primary.longitude, runwayEnds.primary.latitude]);
            if (runwayEnds.reciprocal) bounds.extend([runwayEnds.reciprocal.longitude, runwayEnds.reciprocal.latitude]);
          }
          if (!bounds.isEmpty()) {
            map.fitBounds(bounds, { padding: 90, duration: 900, maxZoom: 12.5 });
          }
        }
      } catch {
        pushSource("ov-procedure", emptyFC());
        pushSource("ov-procedure-points", emptyFC());
        pushSource("ov-proc-runway", emptyFC());
      }
    })();
    return () => { cancelled = true; };
  }, [procedure, pushSource]);

  // 航图叠加：选图 → 取地理配准 + 取 PDF（并行）→ 画成栅格 → 贴到地图上。
  // key 里带「纸底模式 + 主题」，因为这两项会改变像素处理，需要重画；只改透明度则不重画。
  const chartRenderKey = chartOverlay
    ? `${chartOverlay.icao}/${chartOverlay.filename}/${chartOverlay.paper}/${theme}`
    : "";

  useEffect(() => {
    const map = mapRef.current;
    if (!chartOverlay) {
      if (chartRasterRef.current) {
        chartRasterRef.current = null;
        releaseChartPdf();
      }
      if (map && readyRef.current) applyChartLayer(map, null, false, 1);
      return;
    }
    const key = chartRenderKey;
    const selection = chartOverlay;
    const apply = (raster: ChartRaster) => {
      const target = mapRef.current;
      if (target && readyRef.current) {
        applyChartLayer(target, raster, useAppStore.getState().layers.chart, selection.opacity);
      }
    };
    // 缓存命中（成品栅格 LRU）：切回看过的图、切纸底/主题，直接贴，不取数不渲染。
    const cached = peekChartRaster(key);
    if (cached) {
      chartRasterRef.current = { key, raster: cached };
      apply(cached);
      setChartOverlayStatus("ready");
      return;
    }
    if (chartRasterRef.current?.key === key) {
      apply(chartRasterRef.current.raster);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        // 地理配准和 PDF 下载互不依赖，并行取，省一个来回。
        const [bounds, pdfUrl] = await Promise.all([
          jeppGeoBounds(selection.icao, selection.filename),
          chartPdf(selection.icao, selection.filename),
        ]);
        if (cancelled) return;
        // 并行等待期间别的实例可能已经把图渲出来了（StrictMode 双挂载）。
        const raced = peekChartRaster(key);
        if (raced) {
          chartRasterRef.current = { key, raster: raced };
          apply(raced);
          setChartOverlayStatus("ready");
          return;
        }
        const quad = chartQuad(bounds);
        if (!quad) throw new Error(bounds.error || "这张航图没有地理配准，不能叠加到地图");
        // 先贴半分辨率预览让图立刻出现，全分辨率在后台渲染完再替换。
        const raster = await renderChartRaster(pdfUrl, quad, {
          paper: selection.paper,
          invert: useAppStore.getState().theme === "dark",
        }, (preview) => {
          if (cancelled) return;
          chartRasterRef.current = { key, raster: preview };
          apply(preview);
          setChartOverlayStatus("ready");
        });
        if (cancelled) return;
        rememberChartRaster(key, raster);
        chartRasterRef.current = { key, raster };
        apply(raster);
        setChartOverlayStatus("ready");
      } catch (error) {
        if (cancelled) return;
        setChartOverlayStatus("error", error instanceof Error ? error.message : String(error));
      }
    })();
    return () => { cancelled = true; };
  }, [chartOverlay, chartRenderKey, layers.chart, theme, setChartOverlayStatus]);

  // 飞行计划航路
  useEffect(() => {
    const points = routePoints ?? [];
    routeRef.current = points.length > 1
      ? { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: points.map((point) => [point.longitude, point.latitude]) } }] }
      : emptyFC();
    pushSource("ov-route", routeRef.current);
  }, [routePoints, pushSource]);

  // 机场地面：OSM 提供跑道/滑行道/机坪/航站楼，停机位唯一来源是 XFS 的 gates 接口
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const shouldLoad = (layers.ground || groundMode) && map.getZoom() >= 9.5;
    if (!shouldLoad) {
      groundRef.current = emptyFC();
      pushSource("ov-ground", groundRef.current);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const bounds = map.getBounds();
      const push = (features: GeoJsonFeature[]) => {
        groundRef.current = { type: "FeatureCollection", features };
        pushSource("ov-ground", groundRef.current);
      };

      // XFly 停机位与跑道：给机坪补编号，并在没有 OSM 数据时补上跑道走向。
      const icao = useAppStore.getState().selectedAirport;
      const focus = icao && map.getZoom() >= 9.5;
      const gatesTask = focus ? loadGatesCached(icao).catch(() => []) : Promise.resolve([]);
      const runwayTask = focus ? getRunways(icao).catch(() => []) : Promise.resolve([]);

      const osmTask = isTauri()
        ? loadOsmAirportGround({ west: bounds.getWest(), south: bounds.getSouth(), east: bounds.getEast(), north: bounds.getNorth() })
            .then((response) => response.features)
            .catch(() => [])
        : Promise.resolve([]);

      void Promise.all([osmTask, gatesTask, runwayTask]).then(([osmFeatures, gates, runways]) => {
        if (cancelled) return;
        const features: GeoJsonFeature[] = [];
        for (const runway of runways) {
          const le: [number, number] = [Number(runway.leLongitudeDeg), Number(runway.leLatitudeDeg)];
          const he: [number, number] = [Number(runway.heLongitudeDeg), Number(runway.heLatitudeDeg)];
          if (!le.every(Number.isFinite) || !he.every(Number.isFinite)) continue;
          features.push({ type: "Feature", properties: { kind: "runway", label: `${runway.leIdent}/${runway.heIdent}` }, geometry: { type: "LineString", coordinates: [le, he] } });
          features.push({
            type: "Feature",
            properties: { kind: "label", label: `${runway.leIdent}/${runway.heIdent}` },
            geometry: { type: "Point", coordinates: [(le[0] + he[0]) / 2, (le[1] + he[1]) / 2] },
          });
        }
        for (const feature of osmFeatures) {
          const kind = String(feature.properties.kind ?? "");
          const label = String(feature.properties.label ?? "");
          if (kind === "runway-end" || kind === "label") {
            features.push({ type: "Feature", properties: { kind: "label", label }, geometry: feature.geometry as GeoJsonFeature["geometry"] });
            continue;
          }
          if (!kind || kind === "terminal") continue;
          const mapped = kind === "parking_position" || kind === "parking" || kind === "stand" ? "stand" : kind;
          features.push({ type: "Feature", properties: { kind: mapped, label }, geometry: feature.geometry as GeoJsonFeature["geometry"] });
          if (label && (kind === "taxiway" || kind === "taxilane") && feature.geometry.type === "LineString") {
            const line = feature.geometry.coordinates as [number, number][];
            features.push({ type: "Feature", properties: { kind: "label", label }, geometry: { type: "Point", coordinates: line[Math.floor(line.length / 2)] } });
          }
        }
        // 机位唯一来源是 XFS：`gate` 是廊桥/登机口，其余按远机位画。
        for (const gate of gates) {
          if (!Number.isFinite(gate.latitude) || !Number.isFinite(gate.longitude)) continue;
          const coordinates: [number, number] = [gate.longitude, gate.latitude];
          const kind = gate.gateType === "gate" ? "gate" : "stand";
          features.push({ type: "Feature", properties: { kind, label: gate.gateRef }, geometry: { type: "Point", coordinates } });
          features.push({ type: "Feature", properties: { kind: "label", label: gate.gateRef }, geometry: { type: "Point", coordinates } });
        }
        push(features);
      });
    }, 400);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [layers.ground, groundMode, viewTick, pushSource]);

  useImperativeHandle(ref, () => ({
    flyToAirport: (latitude, longitude, zoom = 11) => {
      mapRef.current?.flyTo({ center: [longitude, latitude], zoom, duration: 900, essential: true });
    },
    fitBounds: (points, padding = 60) => {
      const map = mapRef.current;
      if (!map || points.length === 0) return;
      const bounds = new maplibregl.LngLatBounds();
      for (const point of points) bounds.extend([point.longitude, point.latitude]);
      map.fitBounds(bounds, { padding, duration: 900, maxZoom: 11 });
    },
    framePilotRoute: () => {
      const map = mapRef.current;
      if (!map) return;
      const bounds = new maplibregl.LngLatBounds();
      let count = 0;
      for (const collection of [pilotRouteRef.current, trackRef.current]) {
        for (const feature of collection.features) {
          const geometry = feature.geometry as { type?: string; coordinates?: unknown };
          if (geometry?.type !== "LineString") continue;
          for (const coordinate of (geometry.coordinates ?? []) as [number, number][]) {
            bounds.extend(coordinate);
            count++;
          }
        }
      }
      if (count < 2) return;
      map.fitBounds(bounds, { padding: 80, duration: 800, maxZoom: 9 });
    },
    frameChart: () => {
      const map = mapRef.current;
      const raster = chartRasterRef.current?.raster;
      if (!map || !raster) return;
      map.fitBounds(new maplibregl.LngLatBounds(raster.southwest, raster.northeast), { padding: 36, duration: 700 });
    },
    zoomBy: (delta) => mapRef.current?.zoomTo(mapRef.current.getZoom() + delta, { duration: 220 }),
    resetView: () => mapRef.current?.flyTo({ center: [112.5, 33.2], zoom: 4.4, duration: 700 }),
  }), []);

  const style = useMemo(() => ({ position: "absolute" as const, inset: 0 }), []);
  return <div ref={containerRef} style={style} data-variant={variant} />;
});

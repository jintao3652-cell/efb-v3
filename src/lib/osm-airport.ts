import { fetchJsonWithRetry, loadCachedResource, waitFor, type CachedResourceMeta } from "./network-cache";

export interface AirportGroundFeatureCollection {
  type: "FeatureCollection";
  meta?: CachedResourceMeta;
  features: Array<{
    type: "Feature";
    properties: { kind: string; label: string };
    geometry: { type: "Point" | "LineString" | "Polygon"; coordinates: unknown };
  }>;
}

interface OverpassElement {
  type: "node" | "way";
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  geometry?: Array<{ lat: number; lon: number }>;
}

interface OverpassResponse {
  elements?: OverpassElement[];
}

export interface AirportGroundBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

const endpoints = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
const requestGrid = 0.05;
const maximumHalfSpan = 0.15;
const overpassMinimumInterval = 1_500;
let lastOverpassRequestAt = 0;
let overpassQueue: Promise<void> = Promise.resolve();

function rounded(value: number) {
  return Number(value.toFixed(3));
}

function normalizedCenter(first: number, second: number) {
  return Math.round(((first + second) / 2) / requestGrid) * requestGrid;
}

export function normalizeAirportGroundBounds(bounds: AirportGroundBounds): AirportGroundBounds {
  const centerLongitude = normalizedCenter(bounds.west, bounds.east);
  const centerLatitude = normalizedCenter(bounds.south, bounds.north);
  return {
    west: rounded(Math.max(-180, centerLongitude - maximumHalfSpan)),
    south: rounded(Math.max(-85, centerLatitude - maximumHalfSpan)),
    east: rounded(Math.min(180, centerLongitude + maximumHalfSpan)),
    north: rounded(Math.min(85, centerLatitude + maximumHalfSpan)),
  };
}

function scheduleOverpassRequest<T>(signal: AbortSignal, request: () => Promise<T>) {
  const scheduled = overpassQueue.then(async () => {
    const delay = Math.max(0, overpassMinimumInterval - (Date.now() - lastOverpassRequestAt));
    if (delay) await waitFor(delay, signal);
    if (signal.aborted) throw new DOMException("请求已取消", "AbortError");
    lastOverpassRequestAt = Date.now();
    return request();
  });
  overpassQueue = scheduled.then(() => undefined, () => undefined);
  return scheduled;
}

function elementKind(element: OverpassElement) {
  if (element.tags?.aeroway) return element.tags.aeroway;
  return element.tags?.building === "terminal" ? "terminal" : "";
}

function elementLabel(element: OverpassElement) {
  const label = element.tags?.ref ?? element.tags?.name ?? element.tags?.designation ?? "";
  if (element.tags?.aeroway !== "runway" || !label) return label;
  return label.split(/[\/;,]+/).map((ident) => ident.trim()).filter(Boolean).map((ident) => /^RW(?:Y)?/i.test(ident) ? ident.toUpperCase().replace(/^RWY/i, "RW") : `RW${ident.toUpperCase()}`).join("  ");
}

function bearingDeg(from: number[], to: number[]) {
  const radians = (value: number) => value * Math.PI / 180;
  const lat1 = radians(from[1]);
  const lat2 = radians(to[1]);
  const deltaLon = radians(to[0] - from[0]);
  const y = Math.sin(deltaLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// 跑道号 = 跑道磁方位 / 10（如 180° → 18）；用真方位近似，误差经 ref 匹配兜底。
function runwayEndNumber(bearing: number) {
  const value = Math.round(bearing / 10) % 36;
  return value === 0 ? 36 : value;
}

function runwayIdents(element: OverpassElement) {
  return (element.tags?.ref ?? "").split(/[\/;,]+/).map((ident) => ident.trim().toUpperCase().replace(/^RWY?\s*/i, "")).filter(Boolean);
}

// 跑道号各归各的跑道头：按「端点看向对端的方位」推算该端跑道号，ref 里的号
// 按数字就近匹配到对应端（真磁差一般 ≤ 20°，匹配阈值放宽到 ±3）；
// 匹配不上的端直接用推算号（ref 缺失或只有一个号时同理）。
function runwayEndFeatures(coordinates: number[][], element: OverpassElement): AirportGroundFeatureCollection["features"] {
  const first = coordinates[0];
  const last = coordinates[coordinates.length - 1];
  const firstNumber = runwayEndNumber(bearingDeg(first, last));
  const lastNumber = runwayEndNumber(bearingDeg(last, first));
  const idents = runwayIdents(element);
  const pick = (target: number, used: Set<string>) => {
    const candidate = idents.filter((ident) => !used.has(ident)).sort((a, b) => Math.abs(parseInt(a, 10) - target) - Math.abs(parseInt(b, 10) - target))[0];
    return candidate && Math.abs(parseInt(candidate, 10) - target) <= 3 ? candidate : undefined;
  };
  const used = new Set<string>();
  const firstIdent = pick(firstNumber, used);
  if (firstIdent) used.add(firstIdent);
  const lastIdent = pick(lastNumber, used);
  const features: AirportGroundFeatureCollection["features"] = [];
  for (const [label, coords] of [[`RW${firstIdent ?? firstNumber}`, first], [`RW${lastIdent ?? lastNumber}`, last]] as const) {
    features.push({ type: "Feature", properties: { kind: "runway-end", label }, geometry: { type: "Point", coordinates: coords } });
  }
  return features;
}

function asFeature(element: OverpassElement): AirportGroundFeatureCollection["features"] {
  const kind = elementKind(element);
  const properties = { kind, label: elementLabel(element) };
  if (element.type === "node" && Number.isFinite(element.lon) && Number.isFinite(element.lat)) {
    return [{ type: "Feature", properties, geometry: { type: "Point", coordinates: [element.lon, element.lat] } }];
  }
  const coordinates = element.geometry?.map((point) => [point.lon, point.lat]) ?? [];
  if (coordinates.length < 2) return [];
  const isArea = kind === "apron" || kind === "terminal";
  if (isArea && coordinates.length >= 4) {
    const first = coordinates[0];
    const last = coordinates[coordinates.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) coordinates.push([...first]);
    return [{ type: "Feature", properties, geometry: { type: "Polygon", coordinates: [coordinates] } }];
  }
  const line = { type: "Feature" as const, properties, geometry: { type: "LineString" as const, coordinates } };
  // 跑道线额外产出两端点的跑道号标签（kind=runway-end），跑道号各显示在各自跑道头。
  if (kind !== "runway") return [line];
  return [line, ...runwayEndFeatures(coordinates, element)];
}

export async function loadOsmAirportGround(bounds: AirportGroundBounds, signal?: AbortSignal): Promise<AirportGroundFeatureCollection> {
  const normalizedBounds = normalizeAirportGroundBounds(bounds);
  const bbox = `${normalizedBounds.south},${normalizedBounds.west},${normalizedBounds.north},${normalizedBounds.east}`;
  const query = `[out:json][timeout:18];(way["aeroway"="runway"](${bbox});way["aeroway"="taxiway"](${bbox});way["aeroway"="taxilane"](${bbox});way["aeroway"="apron"](${bbox});way["aeroway"="terminal"](${bbox});way["building"="terminal"](${bbox});node["aeroway"="parking_position"](${bbox});node["aeroway"="gate"](${bbox}););out tags geom;`;
  const cacheKey = `osm-airport-ground-v3:${bbox}`;
  const result = await loadCachedResource({
    cacheKey,
    ttlMs: 24 * 60 * 60_000,
    signal,
    load: (requestSignal) => scheduleOverpassRequest(requestSignal, async () => {
      let lastError = new Error("OSM 机场地面数据加载失败");
      for (const endpoint of endpoints) {
        try {
          const payload = await fetchJsonWithRetry<OverpassResponse>(`${endpoint}?data=${encodeURIComponent(query)}`, { signal: requestSignal, timeoutMs: 20_000, retries: 0, headers: { Accept: "application/json" } });
          return { type: "FeatureCollection" as const, features: (payload.elements ?? []).flatMap((element) => asFeature(element)) };
        } catch (error) {
          if (requestSignal.aborted) throw error;
          lastError = error instanceof Error ? error : lastError;
        }
      }
      throw lastError;
    }),
  });
  return { ...result.data, meta: result.meta };
}

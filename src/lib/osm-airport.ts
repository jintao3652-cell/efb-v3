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

function asFeature(element: OverpassElement): AirportGroundFeatureCollection["features"][number] | undefined {
  const kind = elementKind(element);
  const properties = { kind, label: elementLabel(element) };
  if (element.type === "node" && Number.isFinite(element.lon) && Number.isFinite(element.lat)) {
    return { type: "Feature", properties, geometry: { type: "Point", coordinates: [element.lon, element.lat] } };
  }
  const coordinates = element.geometry?.map((point) => [point.lon, point.lat]) ?? [];
  if (coordinates.length < 2) return undefined;
  const isArea = kind === "apron" || kind === "terminal";
  if (isArea && coordinates.length >= 4) {
    const first = coordinates[0];
    const last = coordinates[coordinates.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) coordinates.push([...first]);
    return { type: "Feature", properties, geometry: { type: "Polygon", coordinates: [coordinates] } };
  }
  return { type: "Feature", properties, geometry: { type: "LineString", coordinates } };
}

export async function loadOsmAirportGround(bounds: AirportGroundBounds, signal?: AbortSignal): Promise<AirportGroundFeatureCollection> {
  const normalizedBounds = normalizeAirportGroundBounds(bounds);
  const bbox = `${normalizedBounds.south},${normalizedBounds.west},${normalizedBounds.north},${normalizedBounds.east}`;
  const query = `[out:json][timeout:18];(way["aeroway"="runway"](${bbox});way["aeroway"="taxiway"](${bbox});way["aeroway"="taxilane"](${bbox});way["aeroway"="apron"](${bbox});way["aeroway"="terminal"](${bbox});way["building"="terminal"](${bbox});node["aeroway"="parking_position"](${bbox});node["aeroway"="gate"](${bbox}););out tags geom;`;
  const cacheKey = `osm-airport-ground-v2:${bbox}`;
  const result = await loadCachedResource({
    cacheKey,
    ttlMs: 24 * 60 * 60_000,
    signal,
    load: (requestSignal) => scheduleOverpassRequest(requestSignal, async () => {
      let lastError = new Error("OSM 机场地面数据加载失败");
      for (const endpoint of endpoints) {
        try {
          const payload = await fetchJsonWithRetry<OverpassResponse>(`${endpoint}?data=${encodeURIComponent(query)}`, { signal: requestSignal, timeoutMs: 20_000, retries: 0, headers: { Accept: "application/json" } });
          return { type: "FeatureCollection" as const, features: (payload.elements ?? []).map(asFeature).filter((feature): feature is NonNullable<typeof feature> => Boolean(feature)) };
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

import { fetchJsonWithRetry, loadCachedResource, type CachedResourceMeta } from "./network-cache";

export interface GeoJsonFeatureCollection {
  type: "FeatureCollection";
  features: Array<{ type: "Feature"; properties: Record<string, unknown>; geometry: { type: string; coordinates: unknown } }>;
}

export interface OwnershipFile {
  name?: string;
  description?: string;
  type?: string;
  airspace?: Record<string, string[]>;
  airports?: Record<string, unknown>;
}

export interface VatGlassesResult {
  features: GeoJsonFeatureCollection;
  ownership?: OwnershipFile;
  source: string;
}

export interface VatsimController {
  callsign: string;
  frequency: string;
  name: string;
  facility: number;
}

export interface VatsimPilot {
  cid: number;
  name: string;
  callsign: string;
  latitude: number;
  longitude: number;
  altitude: number;
  groundspeed: number;
  transponder: string;
  heading: number;
  qnh_i_hg: number;
  qnh_mb: number;
  logon_time: string;
  last_updated: string;
  flight_plan?: {
    flight_rules: string;
    aircraft: string;
    aircraft_short: string;
    departure: string;
    arrival: string;
    alternate: string;
    cruise_tas: string;
    altitude: string;
    deptime: string;
    enroute_time: string;
    fuel_time: string;
    remarks: string;
    route: string;
  } | null;
}

export interface CachedGeoJsonCollection {
  data: GeoJsonFeatureCollection;
  meta: CachedResourceMeta;
}

export interface VatsimSnapshot {
  controllers: VatsimController[];
  pilots: VatsimPilot[];
  meta: CachedResourceMeta;
}

const emptyCollection = (): GeoJsonFeatureCollection => ({ type: "FeatureCollection", features: [] });

function normalizeCoordinates(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  if (value.length && value.every((item) => typeof item === "string")) {
    return value.map((item) => {
      const [longitude, latitude] = String(item).trim().split(/\s+/).map(Number);
      return [longitude, latitude];
    });
  }
  return value.map(normalizeCoordinates);
}

function normalizeGeoJson(payload: GeoJsonFeatureCollection): GeoJsonFeatureCollection {
  return { ...payload, features: payload.features.map((feature) => ({ ...feature, geometry: { ...feature.geometry, coordinates: normalizeCoordinates(feature.geometry.coordinates) } })) };
}

function fetchJson<T>(url: string) {
  return fetchJsonWithRetry<T>(url, { timeoutMs: 15_000, retries: 1 });
}

async function loadCachedGeoJson(cacheKey: string, url: string, signal?: AbortSignal): Promise<CachedGeoJsonCollection> {
  const result = await loadCachedResource({
    cacheKey,
    ttlMs: 24 * 60 * 60_000,
    signal,
    load: async (requestSignal) => normalizeGeoJson(await fetchJsonWithRetry<GeoJsonFeatureCollection>(url, { signal: requestSignal, timeoutMs: 18_000, retries: 1 })),
  });
  return result;
}

export function loadFirBoundaries(signal?: AbortSignal) {
  return loadCachedGeoJson("vatsim-fir-boundaries-v1", "https://cdn.volanta.app/navdata/vatsim/boundaries.json", signal);
}

export function loadTraconBoundaries(signal?: AbortSignal) {
  return loadCachedGeoJson("vatsim-tracon-boundaries-v1", "https://cdn.volanta.app/vatsim/TRACONBoundaries.geojson", signal);
}

export async function loadGlobalAirspace(signal?: AbortSignal) {
  const [fir, tracon] = await Promise.all([loadFirBoundaries(signal), loadTraconBoundaries(signal)]);
  return { fir: fir.data, tracon: tracon.data, status: { fir: fir.meta, tracon: tracon.meta } };
}

export async function loadVatsimSnapshot(signal?: AbortSignal): Promise<VatsimSnapshot> {
  const result = await loadCachedResource({
    cacheKey: "vatsim-live-snapshot-v1",
    ttlMs: 12_000,
    signal,
    load: (requestSignal) => fetchJsonWithRetry<{ controllers?: VatsimController[]; pilots?: VatsimPilot[] }>("https://data.vatsim.net/v3/vatsim-data.json", { signal: requestSignal, timeoutMs: 12_000, retries: 1 }),
  });
  return { controllers: result.data.controllers ?? [], pilots: result.data.pilots ?? [], meta: result.meta };
}

export async function loadVatsimControllers(signal?: AbortSignal): Promise<VatsimController[]> {
  return (await loadVatsimSnapshot(signal)).controllers;
}

export async function loadVatsimPilots(signal?: AbortSignal): Promise<VatsimPilot[]> {
  return (await loadVatsimSnapshot(signal)).pilots;
}

function traconPrefixes(feature: GeoJsonFeatureCollection["features"][number]) {
  const prefix = feature.properties.prefix;
  return Array.isArray(prefix) ? prefix.map(String) : typeof prefix === "string" ? [prefix] : [];
}

function traconSuffix(feature: GeoJsonFeatureCollection["features"][number]) {
  return String(feature.properties.suffix ?? "APP").toUpperCase();
}

export function applyActiveTraconControllers(collection: GeoJsonFeatureCollection, controllers: VatsimController[]): GeoJsonFeatureCollection {
  const activeMatches = new Map<number, string[]>();
  for (const controller of controllers) {
    const callsign = controller.callsign.toUpperCase();
    const candidates = collection.features.map((feature, index) => {
      const suffix = traconSuffix(feature);
      const matchingPrefixes = traconPrefixes(feature).filter((prefix) => callsign.startsWith(`${prefix.toUpperCase()}_`) && callsign.endsWith(`_${suffix}`));
      return { index, score: Math.max(0, ...matchingPrefixes.map((prefix) => prefix.length)) };
    }).filter((candidate) => candidate.score > 0);
    const bestScore = Math.max(0, ...candidates.map((candidate) => candidate.score));
    for (const candidate of candidates.filter((item) => item.score === bestScore)) activeMatches.set(candidate.index, [...(activeMatches.get(candidate.index) ?? []), controller.callsign]);
  }
  return {
    ...collection,
    features: collection.features.map((feature, index) => {
      const callsigns = activeMatches.get(index) ?? [];
      return { ...feature, properties: { ...feature.properties, active: callsigns.length > 0, activeCallsign: callsigns.join(" / ") } };
    }),
  };
}

function dmsCoordinate(value: string) {
  const sign = value.startsWith("-") ? -1 : 1;
  const digits = value.replace(/^[+-]/, "");
  const degreeLength = digits.length - 4;
  const degrees = Number(digits.slice(0, degreeLength));
  const minutes = Number(digits.slice(degreeLength, degreeLength + 2));
  const seconds = Number(digits.slice(degreeLength + 2));
  return sign * (degrees + minutes / 60 + seconds / 3600);
}

function asEntries(value: unknown): Array<[string, Record<string, unknown>]> {
  if (Array.isArray(value)) return value.map((item, index) => [String((item as Record<string, unknown>).id ?? index), item as Record<string, unknown>]);
  if (value && typeof value === "object") return Object.entries(value as Record<string, Record<string, unknown>>);
  return [];
}

function vatGlassesFeatures(airspace: unknown, positions: Record<string, Record<string, unknown>>, ownership?: OwnershipFile) {
  const features: GeoJsonFeatureCollection["features"] = [];
  for (const [key, item] of asEntries(airspace)) {
    const id = String(item.id ?? key);
    const owner = ownership?.airspace?.[key]?.[0] ?? ownership?.airspace?.[id]?.[0] ?? (item.owner as string[] | undefined)?.[0] ?? item.parent;
    const position = owner ? positions[String(owner)] : undefined;
    const colours = position?.colours as Array<{ hex?: string }> | undefined;
    const color = colours?.[0]?.hex || "#48d7ff";
    for (const sector of (item.sectors as Array<Record<string, unknown>> | undefined) ?? []) {
      const points = sector.points as Array<[string, string]> | undefined;
      if (!points?.length) continue;
      features.push({ type: "Feature", properties: { id, group: item.group ?? "SECTOR", min: sector.min ?? 0, max: sector.max ?? 999, color }, geometry: { type: "Polygon", coordinates: [points.map(([latitude, longitude]) => [dmsCoordinate(longitude), dmsCoordinate(latitude)])] } });
    }
  }
  return { type: "FeatureCollection" as const, features };
}

export async function loadVatGlassesDataset(dataset: string, customOwnership?: OwnershipFile): Promise<VatGlassesResult> {
  const code = dataset.trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
  if (!code) return { features: emptyCollection(), source: "未选择数据集" };
  const base = `https://raw.githubusercontent.com/lennycolton/vatglasses-data/main/data/${code}`;
  try {
    const [airspacePayload, positionsPayload, presetOwnership] = await Promise.all([
      fetchJson<{ airspace?: unknown }>(`${base}/airspace.json`),
      fetchJson<{ positions?: Record<string, Record<string, unknown>> }>(`${base}/positions.json`),
      customOwnership ? Promise.resolve(customOwnership) : fetchJson<OwnershipFile>(`${base}/ownership/default.json`),
    ]);
    return { features: vatGlassesFeatures(airspacePayload.airspace, positionsPayload.positions ?? {}, presetOwnership), ownership: presetOwnership, source: `VATGlasses ${code.toUpperCase()}` };
  } catch {
    const payload = await fetchJson<{ airspace?: unknown; positions?: Record<string, Record<string, unknown>> }>(`${base}.json`);
    return { features: vatGlassesFeatures(payload.airspace, payload.positions ?? {}, customOwnership), ownership: customOwnership, source: `VATGlasses ${code.toUpperCase()}` };
  }
}

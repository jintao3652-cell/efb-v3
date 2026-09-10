export interface AirportGroundFeatureCollection {
  type: "FeatureCollection";
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

function elementKind(element: OverpassElement) {
  if (element.tags?.aeroway) return element.tags.aeroway;
  return element.tags?.building === "terminal" ? "terminal" : "";
}

function elementLabel(element: OverpassElement) {
  return element.tags?.ref ?? element.tags?.name ?? element.tags?.designation ?? "";
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

export async function loadOsmAirportGround(bounds: AirportGroundBounds): Promise<AirportGroundFeatureCollection> {
  const bbox = `${bounds.south},${bounds.west},${bounds.north},${bounds.east}`;
  const query = `[out:json][timeout:18];(way["aeroway"="runway"](${bbox});way["aeroway"="taxiway"](${bbox});way["aeroway"="apron"](${bbox});way["aeroway"="terminal"](${bbox});way["building"="terminal"](${bbox});node["aeroway"="parking_position"](${bbox});node["aeroway"="gate"](${bbox}););out tags geom;`;
  let lastError = new Error("OSM 机场地面数据加载失败");
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(`${endpoint}?data=${encodeURIComponent(query)}`, { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const payload = await response.json() as OverpassResponse;
      return { type: "FeatureCollection", features: (payload.elements ?? []).map(asFeature).filter((feature): feature is NonNullable<typeof feature> => Boolean(feature)) };
    } catch (error) {
      lastError = error instanceof Error ? error : lastError;
    }
  }
  throw lastError;
}

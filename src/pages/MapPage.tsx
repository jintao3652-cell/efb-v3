import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import maplibregl, { type Map as MapLibreMap, type StyleSpecification } from "maplibre-gl";
import { Crosshair, Layers, MapPin, Minus, Plane, Plus, RotateCcw, Ruler, X } from "lucide-react";
import { airports } from "../lib/data";
import { getNavigationDatabaseStatus, getNavigationMapData, listFlightPlans, type MapViewport, type NavigationMapData, type NavigationMapPoint } from "../lib/tauri";

type LayerKey = "route" | "airports" | "airspace" | "traffic" | "weather";

const layerOptions: Array<{ key: LayerKey; label: string }> = [
  { key: "route", label: "航路显示" }, { key: "airports", label: "机场显示" }, { key: "airspace", label: "空域边界" },
  { key: "traffic", label: "实时交通（演示）" }, { key: "weather", label: "天气雷达（演示）" },
];
const mapLayerIds: Record<LayerKey, string[]> = {
  route: ["navigation-airways", "navigation-waypoints", "navigation-navaids", "navigation-waypoint-labels", "navigation-navaid-labels"],
  airports: ["navigation-airports", "navigation-airport-labels"], airspace: ["airspace-fill", "airspace-line"], traffic: ["traffic-points"], weather: ["weather-fill", "weather-line"],
};
const fallbackAirports: NavigationMapPoint[] = airports.map((airport) => ({ ident: airport.icao, icao: airport.icao, iata: airport.iata, name: airport.name, kind: "机场", latitude: airport.latitude, longitude: airport.longitude }));
const fallbackNavaids: NavigationMapPoint[] = [
  { ident: "RENOB", name: "RENOB", icao: "", iata: "", kind: "航路点", latitude: 39.2, longitude: 117.2 },
  { ident: "POU", name: "POU", icao: "", iata: "", kind: "航路点", latitude: 37.5, longitude: 118.2 },
  { ident: "DUMET", name: "DUMET", icao: "", iata: "", kind: "航路点", latitude: 34.8, longitude: 119.6 },
];
const fallbackMapData: NavigationMapData = { airports: fallbackAirports, navaids: fallbackNavaids, airways: [] };
const airspace = { type: "FeatureCollection" as const, features: [{ type: "Feature" as const, properties: {}, geometry: { type: "Polygon" as const, coordinates: [[[115.2, 40.5], [118.4, 40.5], [118.4, 37.9], [115.2, 37.9], [115.2, 40.5]]] } }] };
const traffic = { type: "FeatureCollection" as const, features: [{ type: "Feature" as const, properties: { callsign: "CSN6981" }, geometry: { type: "Point" as const, coordinates: [118.2, 37.5] } }] };
const weather = { type: "FeatureCollection" as const, features: [{ type: "Feature" as const, properties: {}, geometry: { type: "Polygon" as const, coordinates: [[[119.0, 34.3], [120.6, 34.3], [120.6, 35.4], [119.0, 35.4], [119.0, 34.3]]] } }] };
const mapboxToken = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN?.trim();
const mapProvider = mapboxToken ? "Mapbox · OpenStreetMap" : "OpenStreetMap contributors";
const initialViewport: MapViewport = { west: 73, south: 18, east: 135, north: 54, zoom: 4.5 };
const baseMapStyle: StyleSpecification = {
  version: 8,
  sources: { base: mapboxToken ? { type: "raster", tiles: [`https://api.mapbox.com/styles/v1/mapbox/navigation-night-v1/tiles/512/{z}/{x}/{y}?access_token=${mapboxToken}`], tileSize: 512, attribution: "© Mapbox © OpenStreetMap" } : { type: "raster", tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"], tileSize: 256, attribution: "© OpenStreetMap contributors" } },
  layers: [{ id: "base", type: "raster", source: "base" }],
};

function emptyFeatures() { return { type: "FeatureCollection" as const, features: [] }; }
function labelForPoint(point: NavigationMapPoint) { return point.icao ? `${point.icao}${point.iata ? ` / ${point.iata}` : ""} · ${point.name || point.icao}` : `${point.ident} · ${point.name || point.kind}`; }
function pointsAsFeatures(points: NavigationMapPoint[]) { return { type: "FeatureCollection" as const, features: points.map((point) => ({ type: "Feature" as const, properties: { label: labelForPoint(point), ident: point.ident, kind: point.kind }, geometry: { type: "Point" as const, coordinates: [point.longitude, point.latitude] } })) }; }
function airwaysAsFeatures(data: NavigationMapData) { return { type: "FeatureCollection" as const, features: data.airways.map((airway) => ({ type: "Feature" as const, properties: { name: airway.name }, geometry: { type: "LineString" as const, coordinates: airway.coordinates } })) }; }
function simbriefRouteFeatures(points: Array<{ ident: string; name: string; latitude: number; longitude: number }>) { return { type: "FeatureCollection" as const, features: points.length > 1 ? [{ type: "Feature" as const, properties: {}, geometry: { type: "LineString" as const, coordinates: points.map((point) => [point.longitude, point.latitude]) } }] : [] }; }
function simbriefPointFeatures(points: Array<{ ident: string; name: string; latitude: number; longitude: number }>) { return { type: "FeatureCollection" as const, features: points.map((point) => ({ type: "Feature" as const, properties: { label: point.name ? `${point.ident} · ${point.name}` : point.ident }, geometry: { type: "Point" as const, coordinates: [point.longitude, point.latitude] } })) }; }
function distanceInNm(points: Array<[number, number]>) {
  const radians = (value: number) => value * Math.PI / 180;
  return points.slice(1).reduce((total, point, index) => { const previous = points[index]; const a = Math.sin(radians(point[1] - previous[1]) / 2) ** 2 + Math.cos(radians(previous[1])) * Math.cos(radians(point[1])) * Math.sin(radians(point[0] - previous[0]) / 2) ** 2; return total + 3440.065 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)); }, 0);
}

export function MapPage() {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const measureModeRef = useRef(false);
  const measurePointsRef = useRef<Array<[number, number]>>([]);
  const moveTimeout = useRef<number | undefined>(undefined);
  const [layersOpen, setLayersOpen] = useState(true);
  const [mapReady, setMapReady] = useState(false);
  const [measureMode, setMeasureMode] = useState(false);
  const [measureDistance, setMeasureDistance] = useState(0);
  const [viewport, setViewport] = useState<MapViewport>(initialViewport);
  const [layers, setLayers] = useState<Record<LayerKey, boolean>>({ route: true, airports: true, airspace: false, traffic: true, weather: false });
  const navigation = useQuery({ queryKey: ["navigation-database"], queryFn: getNavigationDatabaseStatus, retry: 0 });
  const navigationData = useQuery({ queryKey: ["navigation-map-data", navigation.data?.source, navigation.data?.databasePath, viewport], queryFn: () => getNavigationMapData(viewport), enabled: navigation.data?.ready, retry: 0, staleTime: 15_000 });
  const flightPlans = useQuery({ queryKey: ["flight-plans"], queryFn: listFlightPlans });
  const activePlan = flightPlans.data?.[0];
  const routePoints = activePlan?.routePoints ?? [];

  useEffect(() => {
    if (!container.current || map.current) return;
    const instance = new maplibregl.Map({ container: container.current, center: [114.8, 34.5], zoom: 4.5, style: baseMapStyle });
    const updateMeasurement = (points: Array<[number, number]>) => (instance.getSource("measurement") as maplibregl.GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: points.length > 1 ? [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: points } }] : [] });
    const updateViewport = () => {
      const bounds = instance.getBounds();
      setViewport({ west: Number(bounds.getWest().toFixed(3)), south: Number(bounds.getSouth().toFixed(3)), east: Number(bounds.getEast().toFixed(3)), north: Number(bounds.getNorth().toFixed(3)), zoom: Number(instance.getZoom().toFixed(1)) });
    };
    instance.on("load", () => {
      instance.addSource("navigation-airways", { type: "geojson", data: emptyFeatures() }); instance.addSource("navigation-airports", { type: "geojson", data: pointsAsFeatures(fallbackMapData.airports) }); instance.addSource("navigation-navaids", { type: "geojson", data: pointsAsFeatures(fallbackMapData.navaids) }); instance.addSource("simbrief-route", { type: "geojson", data: emptyFeatures() }); instance.addSource("simbrief-points", { type: "geojson", data: emptyFeatures() }); instance.addSource("airspace", { type: "geojson", data: airspace }); instance.addSource("traffic", { type: "geojson", data: traffic }); instance.addSource("weather", { type: "geojson", data: weather }); instance.addSource("measurement", { type: "geojson", data: emptyFeatures() });
      instance.addLayer({ id: "navigation-airways", type: "line", source: "navigation-airways", paint: { "line-color": "#55c8ef", "line-width": ["interpolate", ["linear"], ["zoom"], 4, 1, 8, 2.4], "line-opacity": .88 } });
      instance.addLayer({ id: "navigation-waypoints", type: "circle", source: "navigation-navaids", filter: ["==", ["get", "kind"], "航路点"], paint: { "circle-radius": 3, "circle-color": "#e7f6ff", "circle-stroke-color": "#249fc8", "circle-stroke-width": 1.3 } });
      instance.addLayer({ id: "navigation-navaids", type: "circle", source: "navigation-navaids", filter: ["!=", ["get", "kind"], "航路点"], paint: { "circle-radius": 4.5, "circle-color": "#9ae3ff", "circle-stroke-color": "#0a1a28", "circle-stroke-width": 1.5 } });
      instance.addLayer({ id: "navigation-waypoint-labels", type: "symbol", source: "navigation-navaids", minzoom: 5.5, filter: ["==", ["get", "kind"], "航路点"], layout: { "text-field": ["get", "label"], "text-size": ["interpolate", ["linear"], ["zoom"], 5.5, 10, 9, 14], "text-offset": [0, 1], "text-anchor": "top", "text-allow-overlap": false, "text-ignore-placement": false, "text-optional": true }, paint: { "text-color": "#d9f3ff", "text-halo-color": "#071827", "text-halo-width": 1.4 } });
      instance.addLayer({ id: "navigation-navaid-labels", type: "symbol", source: "navigation-navaids", minzoom: 5.5, filter: ["!=", ["get", "kind"], "航路点"], layout: { "text-field": ["get", "label"], "text-size": ["interpolate", ["linear"], ["zoom"], 5.5, 10, 9, 14], "text-offset": [0, 1.15], "text-anchor": "top", "text-allow-overlap": false, "text-ignore-placement": false, "text-optional": true }, paint: { "text-color": "#bceaff", "text-halo-color": "#071827", "text-halo-width": 1.5 } });
      instance.addLayer({ id: "navigation-airports", type: "circle", source: "navigation-airports", paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 4, 9, 7], "circle-color": "#ffbd65", "circle-stroke-width": 1.7, "circle-stroke-color": "#071827" } });
      instance.addLayer({ id: "navigation-airport-labels", type: "symbol", source: "navigation-airports", minzoom: 5, layout: { "text-field": ["get", "label"], "text-size": ["interpolate", ["linear"], ["zoom"], 5, 10, 9, 14], "text-offset": [0, 1.15], "text-anchor": "top", "text-allow-overlap": false, "text-ignore-placement": false, "text-optional": true }, paint: { "text-color": "#fff0d8", "text-halo-color": "#071827", "text-halo-width": 1.5 } });
      instance.addLayer({ id: "simbrief-route-casing", type: "line", source: "simbrief-route", paint: { "line-color": "#210e20", "line-width": ["interpolate", ["linear"], ["zoom"], 4, 5, 9, 9], "line-opacity": .92 } }); instance.addLayer({ id: "simbrief-route", type: "line", source: "simbrief-route", paint: { "line-color": "#ff6480", "line-width": ["interpolate", ["linear"], ["zoom"], 4, 2.5, 9, 4.5], "line-opacity": 1 } }); instance.addLayer({ id: "simbrief-route-points", type: "circle", source: "simbrief-points", paint: { "circle-radius": 4.5, "circle-color": "#ffcf77", "circle-stroke-width": 1.5, "circle-stroke-color": "#6e1c38" } }); instance.addLayer({ id: "simbrief-route-labels", type: "symbol", source: "simbrief-points", minzoom: 5.5, layout: { "text-field": ["get", "label"], "text-size": ["interpolate", ["linear"], ["zoom"], 5.5, 10, 9, 13], "text-offset": [0, -1.1], "text-anchor": "bottom", "text-allow-overlap": false, "text-ignore-placement": false, "text-optional": true }, paint: { "text-color": "#ffd5de", "text-halo-color": "#381020", "text-halo-width": 1.5 } });
      instance.addLayer({ id: "airspace-fill", type: "fill", source: "airspace", layout: { visibility: "none" }, paint: { "fill-color": "#b471f4", "fill-opacity": .12 } }); instance.addLayer({ id: "airspace-line", type: "line", source: "airspace", layout: { visibility: "none" }, paint: { "line-color": "#cd9cff", "line-width": 2, "line-dasharray": [2, 1] } }); instance.addLayer({ id: "traffic-points", type: "circle", source: "traffic", paint: { "circle-radius": 7, "circle-color": "#7fe3a8", "circle-stroke-color": "#07311c", "circle-stroke-width": 2 } }); instance.addLayer({ id: "weather-fill", type: "fill", source: "weather", layout: { visibility: "none" }, paint: { "fill-color": "#ffce63", "fill-opacity": .23 } }); instance.addLayer({ id: "weather-line", type: "line", source: "weather", layout: { visibility: "none" }, paint: { "line-color": "#ffce63", "line-width": 2 } }); instance.addLayer({ id: "measurement-line", type: "line", source: "measurement", paint: { "line-color": "#ffdc70", "line-width": 3 } });
      updateViewport(); setMapReady(true);
    });
    instance.on("moveend", () => { window.clearTimeout(moveTimeout.current); moveTimeout.current = window.setTimeout(updateViewport, 140); });
    instance.on("click", (event) => { if (!measureModeRef.current) return; const nextPoints: Array<[number, number]> = [...measurePointsRef.current, [event.lngLat.lng, event.lngLat.lat]]; measurePointsRef.current = nextPoints; updateMeasurement(nextPoints); setMeasureDistance(distanceInNm(nextPoints)); });
    map.current = instance;
    return () => { window.clearTimeout(moveTimeout.current); instance.remove(); map.current = null; };
  }, []);

  useEffect(() => { measureModeRef.current = measureMode; if (map.current) map.current.getCanvas().style.cursor = measureMode ? "crosshair" : ""; }, [measureMode]);
  useEffect(() => { if (!mapReady || !map.current) return; for (const [key, layerIds] of Object.entries(mapLayerIds) as Array<[LayerKey, string[]]>) for (const layerId of layerIds) map.current.setLayoutProperty(layerId, "visibility", layers[key] ? "visible" : "none"); }, [layers, mapReady]);
  useEffect(() => {
    if (!mapReady || !map.current) return;
    const data = navigation.data?.ready ? navigationData.data : fallbackMapData;
    if (!data) return;
    (map.current.getSource("navigation-airways") as maplibregl.GeoJSONSource).setData(airwaysAsFeatures(data));
    (map.current.getSource("navigation-airports") as maplibregl.GeoJSONSource).setData(pointsAsFeatures(data.airports));
    (map.current.getSource("navigation-navaids") as maplibregl.GeoJSONSource).setData(pointsAsFeatures(data.navaids));
  }, [mapReady, navigation.data?.ready, navigationData.data]);
  useEffect(() => {
    if (!mapReady || !map.current) return;
    (map.current.getSource("simbrief-route") as maplibregl.GeoJSONSource).setData(simbriefRouteFeatures(routePoints));
    (map.current.getSource("simbrief-points") as maplibregl.GeoJSONSource).setData(simbriefPointFeatures(routePoints));
  }, [mapReady, routePoints]);

  const zoom = (amount: number) => map.current?.zoomTo(map.current.getZoom() + amount);
  const resetMeasurement = () => { measurePointsRef.current = []; (map.current?.getSource("measurement") as maplibregl.GeoJSONSource | undefined)?.setData(emptyFeatures()); setMeasureDistance(0); };
  const toggleMeasurement = () => { setMeasureMode((active) => !active); if (!measureMode) resetMeasurement(); };
  const dataStatus = navigation.data?.ready ? `${navigationData.data?.airways.length ?? 0} 航段 · ${navigationData.data?.navaids.length ?? 0} 航路点/导航台 · ${navigationData.data?.airports.length ?? 0} 机场` : "使用内置演示数据；在设置中加载导航数据库以显示视野内航空要素。";
  const planLabel = activePlan ? `${activePlan.departure} → ${activePlan.arrival}` : "未导入飞行计划";

  return <div className="map-page"><div className="map-canvas" ref={container} />
    <div className="map-toolbar"><button onClick={() => zoom(1)} aria-label="放大"><Plus size={19} /></button><button onClick={() => zoom(-1)} aria-label="缩小"><Minus size={19} /></button><span /><button onClick={() => map.current?.flyTo({ center: [118.2, 37.5], zoom: 6.4 })} aria-label="定位到计划航路"><Crosshair size={19} /></button><button className={measureMode ? "active" : ""} onClick={toggleMeasurement} aria-label="测量距离"><Ruler size={19} /></button></div>
    <aside className="map-layers"><div className="map-layers-heading"><div><Layers size={18} /><strong>地图图层</strong></div><button onClick={() => setLayersOpen((open) => !open)} aria-label="折叠图层"><X className={layersOpen ? "" : "map-panel-closed"} size={17} /></button></div>{layersOpen && <><div className="layer-list">{layerOptions.map(({ key, label }) => <label className="layer-toggle" key={key}><span>{label}</span><input type="checkbox" checked={layers[key]} onChange={() => setLayers((current) => ({ ...current, [key]: !current[key] }))} /><i /></label>)}</div><p>{navigationData.isFetching ? "正在更新当前可视范围内的航空要素…" : dataStatus}</p>{navigationData.isError && <p className="map-error">{navigationData.error.message}</p>}</>}</aside>
    <div className="map-status-card"><div><Plane size={17} /><strong>{activePlan?.callsign || "SIMBRIEF"}</strong><span>{routePoints.length > 1 ? `${routePoints.length} 个坐标点` : "无坐标航路"}</span></div><p><MapPin size={14} />{planLabel}</p></div>
    {measureMode && <div className="measure-card"><div><Ruler size={16} /><strong>距离测量</strong></div><span>{measureDistance.toFixed(1)} NM</span><button onClick={resetMeasurement}><RotateCcw size={14} />清除</button></div>}
    <div className="map-legend"><i />导航航路 <b />SimBrief 实际航路 <span />机场</div><div className="map-attribution">地图数据 © {mapProvider}</div>
  </div>;
}

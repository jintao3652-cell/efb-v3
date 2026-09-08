import { useEffect, useRef, useState } from "react";
import maplibregl, { type Map as MapLibreMap } from "maplibre-gl";
import { Crosshair, Layers, MapPin, Minus, Plane, Plus, RotateCcw, Ruler, X } from "lucide-react";
import { airports } from "../lib/data";

type LayerKey = "route" | "airports" | "navaids" | "airspace" | "traffic" | "weather";

const layerOptions: Array<{ key: LayerKey; label: string }> = [
  { key: "route", label: "航路与航点" }, { key: "airports", label: "机场与跑道" }, { key: "navaids", label: "导航台" },
  { key: "airspace", label: "空域边界" }, { key: "traffic", label: "实时交通（演示）" }, { key: "weather", label: "天气雷达（演示）" },
];
const mapLayerIds: Record<LayerKey, string[]> = {
  route: ["route-line", "route-waypoints"], airports: ["airport-points"], navaids: ["navaid-points"], airspace: ["airspace-fill", "airspace-line"], traffic: ["traffic-points"], weather: ["weather-fill", "weather-line"],
};
const flightRoute = { type: "Feature" as const, properties: {}, geometry: { type: "LineString" as const, coordinates: [[116.5846, 40.0801], [118.2, 37.5], [119.6, 34.8], [121.8052, 31.1434]] } };
const routeWaypoints = { type: "FeatureCollection" as const, features: [
  { type: "Feature" as const, properties: { name: "RENOB" }, geometry: { type: "Point" as const, coordinates: [117.2, 39.2] } }, { type: "Feature" as const, properties: { name: "POU" }, geometry: { type: "Point" as const, coordinates: [118.2, 37.5] } }, { type: "Feature" as const, properties: { name: "DUMET" }, geometry: { type: "Point" as const, coordinates: [119.6, 34.8] } },
] };
const navaids = { type: "FeatureCollection" as const, features: [{ type: "Feature" as const, properties: { ident: "TYN" }, geometry: { type: "Point" as const, coordinates: [112.63, 37.75] } }, { type: "Feature" as const, properties: { ident: "HGH" }, geometry: { type: "Point" as const, coordinates: [120.4, 30.23] } }, { type: "Feature" as const, properties: { ident: "SHA" }, geometry: { type: "Point" as const, coordinates: [121.34, 31.2] } }] };
const airspace = { type: "FeatureCollection" as const, features: [{ type: "Feature" as const, properties: {}, geometry: { type: "Polygon" as const, coordinates: [[[115.2, 40.5], [118.4, 40.5], [118.4, 37.9], [115.2, 37.9], [115.2, 40.5]]] } }] };
const traffic = { type: "FeatureCollection" as const, features: [{ type: "Feature" as const, properties: { callsign: "CSN6981" }, geometry: { type: "Point" as const, coordinates: [118.2, 37.5] } }] };
const weather = { type: "FeatureCollection" as const, features: [{ type: "Feature" as const, properties: {}, geometry: { type: "Polygon" as const, coordinates: [[[119.0, 34.3], [120.6, 34.3], [120.6, 35.4], [119.0, 35.4], [119.0, 34.3]]] } }] };

function distanceInNm(points: Array<[number, number]>) {
  const radians = (value: number) => value * Math.PI / 180;
  return points.slice(1).reduce((total, point, index) => { const previous = points[index]; const a = Math.sin(radians(point[1] - previous[1]) / 2) ** 2 + Math.cos(radians(previous[1])) * Math.cos(radians(point[1])) * Math.sin(radians(point[0] - previous[0]) / 2) ** 2; return total + 3440.065 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)); }, 0);
}

export function MapPage() {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const measureModeRef = useRef(false);
  const measurePointsRef = useRef<Array<[number, number]>>([]);
  const [layersOpen, setLayersOpen] = useState(true);
  const [mapReady, setMapReady] = useState(false);
  const [measureMode, setMeasureMode] = useState(false);
  const [measureDistance, setMeasureDistance] = useState(0);
  const [layers, setLayers] = useState<Record<LayerKey, boolean>>({ route: true, airports: true, navaids: true, airspace: false, traffic: true, weather: false });

  useEffect(() => {
    if (!container.current || map.current) return;
    const instance = new maplibregl.Map({ container: container.current, center: [114.8, 34.5], zoom: 4.5, style: { version: 8, sources: { osm: { type: "raster", tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"], tileSize: 256, attribution: "© OpenStreetMap contributors" } }, layers: [{ id: "base", type: "raster", source: "osm" }] } });
    const updateMeasurement = (points: Array<[number, number]>) => (instance.getSource("measurement") as maplibregl.GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: points.length > 1 ? [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: points } }] : [] });
    instance.on("load", () => {
      instance.addSource("route", { type: "geojson", data: flightRoute }); instance.addSource("waypoints", { type: "geojson", data: routeWaypoints }); instance.addSource("airports", { type: "geojson", data: { type: "FeatureCollection", features: airports.map((airport) => ({ type: "Feature" as const, properties: { icao: airport.icao }, geometry: { type: "Point" as const, coordinates: [airport.longitude, airport.latitude] } })) } }); instance.addSource("navaids", { type: "geojson", data: navaids }); instance.addSource("airspace", { type: "geojson", data: airspace }); instance.addSource("traffic", { type: "geojson", data: traffic }); instance.addSource("weather", { type: "geojson", data: weather }); instance.addSource("measurement", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      instance.addLayer({ id: "route-line", type: "line", source: "route", paint: { "line-color": "#69d6ff", "line-width": 3, "line-dasharray": [2, 1] } }); instance.addLayer({ id: "route-waypoints", type: "circle", source: "waypoints", paint: { "circle-radius": 4, "circle-color": "#f3fbff", "circle-stroke-color": "#51c5f0", "circle-stroke-width": 2 } }); instance.addLayer({ id: "airport-points", type: "circle", source: "airports", paint: { "circle-radius": 6, "circle-color": "#ffb65c", "circle-stroke-width": 2, "circle-stroke-color": "#0a1726" } }); instance.addLayer({ id: "navaid-points", type: "circle", source: "navaids", paint: { "circle-radius": 4, "circle-color": "#8fdaff", "circle-stroke-color": "#0a1726", "circle-stroke-width": 1 } });
      instance.addLayer({ id: "airspace-fill", type: "fill", source: "airspace", layout: { visibility: "none" }, paint: { "fill-color": "#b471f4", "fill-opacity": .12 } }); instance.addLayer({ id: "airspace-line", type: "line", source: "airspace", layout: { visibility: "none" }, paint: { "line-color": "#cd9cff", "line-width": 2, "line-dasharray": [2, 1] } }); instance.addLayer({ id: "traffic-points", type: "circle", source: "traffic", paint: { "circle-radius": 7, "circle-color": "#7fe3a8", "circle-stroke-color": "#07311c", "circle-stroke-width": 2 } }); instance.addLayer({ id: "weather-fill", type: "fill", source: "weather", layout: { visibility: "none" }, paint: { "fill-color": "#ffce63", "fill-opacity": .23 } }); instance.addLayer({ id: "weather-line", type: "line", source: "weather", layout: { visibility: "none" }, paint: { "line-color": "#ffce63", "line-width": 2 } }); instance.addLayer({ id: "measurement-line", type: "line", source: "measurement", paint: { "line-color": "#ffdc70", "line-width": 3 } }); setMapReady(true);
    });
    instance.on("click", (event) => { if (!measureModeRef.current) return; const nextPoints: Array<[number, number]> = [...measurePointsRef.current, [event.lngLat.lng, event.lngLat.lat]]; measurePointsRef.current = nextPoints; updateMeasurement(nextPoints); setMeasureDistance(distanceInNm(nextPoints)); });
    map.current = instance;
    return () => { instance.remove(); map.current = null; };
  }, []);

  useEffect(() => { measureModeRef.current = measureMode; if (map.current) map.current.getCanvas().style.cursor = measureMode ? "crosshair" : ""; }, [measureMode]);
  useEffect(() => { if (!mapReady || !map.current) return; for (const [key, layerIds] of Object.entries(mapLayerIds) as Array<[LayerKey, string[]]>) for (const layerId of layerIds) map.current.setLayoutProperty(layerId, "visibility", layers[key] ? "visible" : "none"); }, [layers, mapReady]);
  const zoom = (amount: number) => map.current?.zoomTo(map.current.getZoom() + amount);
  const resetMeasurement = () => { measurePointsRef.current = []; (map.current?.getSource("measurement") as maplibregl.GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: [] }); setMeasureDistance(0); };
  const toggleMeasurement = () => { setMeasureMode((active) => !active); if (!measureMode) resetMeasurement(); };
  return <div className="map-page"><div className="map-canvas" ref={container} />
    <div className="map-toolbar"><button onClick={() => zoom(1)} aria-label="放大"><Plus size={19} /></button><button onClick={() => zoom(-1)} aria-label="缩小"><Minus size={19} /></button><span /><button onClick={() => map.current?.flyTo({ center: [118.2, 37.5], zoom: 6.4 })} aria-label="定位到计划航路"><Crosshair size={19} /></button><button className={measureMode ? "active" : ""} onClick={toggleMeasurement} aria-label="测量距离"><Ruler size={19} /></button></div>
    <aside className="map-layers"><div className="map-layers-heading"><div><Layers size={18} /><strong>地图图层</strong></div><button onClick={() => setLayersOpen((open) => !open)} aria-label="折叠图层"><X className={layersOpen ? "" : "map-panel-closed"} size={17} /></button></div>{layersOpen && <><div className="layer-list">{layerOptions.map(({ key, label }) => <label className="layer-toggle" key={key}><span>{label}</span><input type="checkbox" checked={layers[key]} onChange={() => setLayers((current) => ({ ...current, [key]: !current[key] }))} /><i /></label>)}</div><p>航空要素使用内置演示数据；基础底图需要网络。</p></>}</aside>
    <div className="map-status-card"><div><Plane size={17} /><strong>CSN6981</strong><span>FL340 · GS 442 kt</span></div><p><MapPin size={14} />计划航路 ZBAA → ZSPD</p></div>{measureMode && <div className="measure-card"><div><Ruler size={16} /><strong>距离测量</strong></div><span>{measureDistance.toFixed(1)} NM</span><button onClick={resetMeasurement}><RotateCcw size={14} />清除</button></div>}<div className="map-legend"><i />计划航路 <span />机场</div>
  </div>;
}

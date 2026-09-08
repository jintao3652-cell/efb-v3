import { useEffect, useRef, useState } from "react";
import maplibregl, { type Map as MapLibreMap } from "maplibre-gl";
import { Crosshair, Eye, Layers, Minus, Plus, Ruler, X } from "lucide-react";
import { airports } from "../lib/data";

const line = { type: "Feature" as const, properties: {}, geometry: { type: "LineString" as const, coordinates: [[116.5846, 40.0801], [118.2, 37.5], [119.6, 34.8], [121.8052, 31.1434]] } };

export function MapPage() {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const [layersOpen, setLayersOpen] = useState(true);

  useEffect(() => {
    if (!container.current || map.current) return;
    const instance = new maplibregl.Map({
      container: container.current, center: [114.8, 34.5], zoom: 4.5,
      style: { version: 8, sources: { osm: { type: "raster", tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"], tileSize: 256, attribution: "© OpenStreetMap contributors" } }, layers: [{ id: "base", type: "raster", source: "osm" }] },
    });
    instance.on("load", () => {
      instance.addSource("route", { type: "geojson", data: line });
      instance.addLayer({ id: "route-line", type: "line", source: "route", paint: { "line-color": "#69d6ff", "line-width": 3, "line-dasharray": [2, 1] } });
      instance.addSource("airports", { type: "geojson", data: { type: "FeatureCollection", features: airports.map((airport) => ({ type: "Feature" as const, properties: { icao: airport.icao, name: airport.name }, geometry: { type: "Point" as const, coordinates: [airport.longitude, airport.latitude] } })) } });
      instance.addLayer({ id: "airport-points", type: "circle", source: "airports", paint: { "circle-radius": 6, "circle-color": "#ffb65c", "circle-stroke-width": 2, "circle-stroke-color": "#0a1726" } });
      instance.addLayer({ id: "airport-labels", type: "symbol", source: "airports", layout: { "text-field": ["get", "icao"], "text-font": ["Open Sans Bold"], "text-size": 12, "text-offset": [0, 1.2] }, paint: { "text-color": "#e6f2ff", "text-halo-color": "#0a1726", "text-halo-width": 1.5 } });
    });
    map.current = instance;
    return () => { instance.remove(); map.current = null; };
  }, []);

  const zoom = (amount: number) => map.current?.zoomTo(map.current.getZoom() + amount);
  return <div className="map-page"><div className="map-canvas" ref={container} />
    <div className="map-toolbar"><button onClick={() => zoom(1)} aria-label="放大"><Plus size={19} /></button><button onClick={() => zoom(-1)} aria-label="缩小"><Minus size={19} /></button><span /><button aria-label="定位"><Crosshair size={19} /></button><button aria-label="测量"><Ruler size={19} /></button></div>
    <aside className={`map-layers ${layersOpen ? "" : "closed"}`}><div className="map-layers-heading"><div><Layers size={18} /><strong>地图图层</strong></div><button onClick={() => setLayersOpen(false)} aria-label="关闭"><X size={17} /></button></div>
      {["航路与航点", "机场与跑道", "导航台", "空域边界", "实时交通", "天气雷达"].map((name, index) => <label className="layer-toggle" key={name}><span>{name}</span><input type="checkbox" defaultChecked={index < 3} /><i /></label>)}
      <p>基础地图在线加载；航空要素由本地 AIRAC 数据提供。</p>
    </aside>
    {!layersOpen && <button className="floating-layer-button" onClick={() => setLayersOpen(true)}><Eye size={18} /> 图层</button>}
    <div className="map-legend"><i />计划航路 <span />机场</div>
  </div>;
}

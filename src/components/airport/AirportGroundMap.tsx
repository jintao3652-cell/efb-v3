import { useEffect, useRef, useState } from "react";
import maplibregl, { type Map as MapLibreMap, type StyleSpecification } from "maplibre-gl";
import type { Airport } from "../../types";
import type { XflyAirportData } from "../../lib/tauri";

const groundStyle: StyleSpecification = {
  version: 8,
  sources: { base: { type: "raster", tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"], tileSize: 256, attribution: "© OpenStreetMap contributors" } },
  layers: [{ id: "base", type: "raster", source: "base", paint: { "raster-brightness-max": 0.58, "raster-saturation": -0.45 } }],
};

const emptyCollection = () => ({ type: "FeatureCollection" as const, features: [] });

export function AirportGroundMap({ airport, data, selectedStand, onSelectStand }: { airport: Airport; data?: XflyAirportData; selectedStand: string; onSelectStand: (stand: string) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const [mapReady, setMapReady] = useState(false);

  useEffect(() => {
    if (!container.current || map.current) return;
    setMapReady(false);
    const instance = new maplibregl.Map({ container: container.current, center: [airport.longitude, airport.latitude], zoom: 14.8, style: groundStyle, attributionControl: false });
    instance.addControl(new maplibregl.NavigationControl({ showCompass: true }), "top-right");
    instance.on("load", () => {
      instance.addSource("airport-runways", { type: "geojson", data: emptyCollection() });
      instance.addSource("airport-gates", { type: "geojson", data: emptyCollection() });
      instance.addLayer({ id: "airport-runway-casing", type: "line", source: "airport-runways", paint: { "line-color": "#0b1822", "line-width": ["interpolate", ["linear"], ["zoom"], 13, 5, 17, 17] } });
      instance.addLayer({ id: "airport-runways", type: "line", source: "airport-runways", paint: { "line-color": "#d2dbe0", "line-width": ["interpolate", ["linear"], ["zoom"], 13, 2.5, 17, 11], "line-dasharray": [2, 1] } });
      instance.addLayer({ id: "airport-gates", type: "circle", source: "airport-gates", minzoom: 14.8, paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 14.8, 2.5, 18, 6], "circle-color": ["case", ["==", ["get", "ref"], selectedStand], "#ffbd62", "#69d7ff"], "circle-stroke-color": "#092033", "circle-stroke-width": 1.4 } });
      instance.addLayer({ id: "airport-gate-labels", type: "symbol", source: "airport-gates", minzoom: 16.2, layout: { "text-field": ["get", "ref"], "text-size": 10, "text-offset": [0, 1], "text-anchor": "top", "text-allow-overlap": false }, paint: { "text-color": "#e7f7ff", "text-halo-color": "#071827", "text-halo-width": 1.5 } });
      instance.on("click", "airport-gates", (event) => { const ref = event.features?.[0]?.properties?.ref; if (ref) onSelectStand(String(ref)); });
      instance.on("mouseenter", "airport-gates", () => { instance.getCanvas().style.cursor = "pointer"; });
      instance.on("mouseleave", "airport-gates", () => { instance.getCanvas().style.cursor = ""; });
      setMapReady(true);
    });
    map.current = instance;
    return () => { instance.remove(); map.current = null; };
  }, [airport.icao]);

  useEffect(() => {
    const instance = map.current;
    if (!mapReady || !instance?.isStyleLoaded() || !data) return;
    const gates = { type: "FeatureCollection" as const, features: data.gates.map((gate) => ({ type: "Feature" as const, properties: { ref: gate.gateRef, type: gate.gateType }, geometry: { type: "Point" as const, coordinates: [gate.longitude, gate.latitude] } })) };
    const runways = { type: "FeatureCollection" as const, features: data.runways.map((runway) => ({ type: "Feature" as const, properties: { label: `${runway.leIdent}/${runway.heIdent}` }, geometry: { type: "LineString" as const, coordinates: [[Number(runway.leLongitudeDeg), Number(runway.leLatitudeDeg)], [Number(runway.heLongitudeDeg), Number(runway.heLatitudeDeg)]] } })) };
    (instance.getSource("airport-gates") as maplibregl.GeoJSONSource | undefined)?.setData(gates);
    (instance.getSource("airport-runways") as maplibregl.GeoJSONSource | undefined)?.setData(runways);
    if (data.gates.length || data.runways.length) {
      const bounds = new maplibregl.LngLatBounds();
      data.gates.forEach((gate) => bounds.extend([gate.longitude, gate.latitude]));
      data.runways.forEach((runway) => { bounds.extend([Number(runway.leLongitudeDeg), Number(runway.leLatitudeDeg)]); bounds.extend([Number(runway.heLongitudeDeg), Number(runway.heLatitudeDeg)]); });
      if (!bounds.isEmpty()) instance.fitBounds(bounds, { padding: 42, maxZoom: 16.4, duration: 500 });
    }
  }, [data, airport.icao, mapReady]);

  useEffect(() => {
    if (map.current?.getLayer("airport-gates")) map.current.setPaintProperty("airport-gates", "circle-color", ["case", ["==", ["get", "ref"], selectedStand], "#ffbd62", "#69d7ff"]);
  }, [selectedStand]);

  return <div className="ground-map"><div className="ground-map-header"><div><strong>{airport.icao} 机位与跑道</strong><span>XFlySim API · 放大至 16.2 级显示机位编号</span></div><span>{selectedStand ? `已选择：${selectedStand}` : `${data?.gates.length ?? 0} 个机位`}</span></div><div className="airport-ground-canvas" ref={container} /><div className="ground-map-legend"><span><i className="stand-symbol" />机位</span><span><i className="stand-symbol selected" />当前选择</span><span><i className="line-symbol" />跑道中心线</span></div></div>;
}

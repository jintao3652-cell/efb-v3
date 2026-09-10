import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import * as maplibregl from "maplibre-gl";
import type { Map as MapLibreMap, StyleSpecification } from "maplibre-gl";
import type { Airport } from "../../types";
import type { XflyAirportData } from "../../lib/tauri";
import { loadOsmAirportGround, normalizeAirportGroundBounds } from "../../lib/osm-airport";

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
  const airportGroundBounds = useMemo(() => normalizeAirportGroundBounds({ west: airport.longitude - .12, south: airport.latitude - .12, east: airport.longitude + .12, north: airport.latitude + .12 }), [airport.latitude, airport.longitude]);
  const osmGround = useQuery({ queryKey: ["airport-detail-osm-ground", airportGroundBounds], queryFn: ({ signal }) => loadOsmAirportGround(airportGroundBounds, signal), staleTime: 30 * 60_000, retry: 0, networkMode: "always", placeholderData: (previousData) => previousData });

  useEffect(() => {
    if (!container.current || map.current) return;
    setMapReady(false);
    const instance = new maplibregl.Map({ container: container.current, center: [airport.longitude, airport.latitude], zoom: 14.8, style: groundStyle, attributionControl: false });
    instance.addControl(new maplibregl.NavigationControl({ showCompass: true }), "top-right");
    instance.on("load", () => {
      instance.addSource("airport-runways", { type: "geojson", data: emptyCollection() });
      instance.addSource("airport-gates", { type: "geojson", data: emptyCollection() });
      instance.addSource("airport-osm-ground", { type: "geojson", data: emptyCollection() });
      instance.addLayer({ id: "airport-runway-casing", type: "line", source: "airport-runways", paint: { "line-color": "#0b1822", "line-width": ["interpolate", ["linear"], ["zoom"], 13, 5, 17, 17] } });
      instance.addLayer({ id: "airport-runways", type: "line", source: "airport-runways", paint: { "line-color": "#d2dbe0", "line-width": ["interpolate", ["linear"], ["zoom"], 13, 2.5, 17, 11], "line-dasharray": [2, 1] } });
      instance.addLayer({ id: "airport-runway-labels", type: "symbol", source: "airport-runways", minzoom: 13, layout: { "symbol-placement": "line", "text-field": ["get", "label"], "text-size": ["interpolate", ["linear"], ["zoom"], 13, 12, 17, 17], "symbol-spacing": 360, "text-letter-spacing": .08, "text-allow-overlap": true, "text-rotation-alignment": "map", "text-pitch-alignment": "map" }, paint: { "text-color": "#58f3ff", "text-halo-color": "#071015", "text-halo-width": 2.6 } });
      instance.addLayer({ id: "airport-osm-runway-labels", type: "symbol", source: "airport-osm-ground", minzoom: 13, filter: ["all", ["==", ["get", "kind"], "runway"], ["!=", ["get", "label"], ""]], layout: { "symbol-placement": "line", "text-field": ["get", "label"], "text-size": ["interpolate", ["linear"], ["zoom"], 13, 12, 17, 17], "symbol-spacing": 360, "text-allow-overlap": false, "text-rotation-alignment": "map", "text-pitch-alignment": "map" }, paint: { "text-color": "#58f3ff", "text-halo-color": "#071015", "text-halo-width": 2.6 } });
      instance.addLayer({ id: "airport-taxiway-labels", type: "symbol", source: "airport-osm-ground", minzoom: 13.5, filter: ["all", ["in", ["get", "kind"], ["literal", ["taxiway", "taxilane"]]], ["!=", ["get", "label"], ""]], layout: { "symbol-placement": "line", "text-field": ["get", "label"], "text-size": ["interpolate", ["linear"], ["zoom"], 13.5, 10, 18, 15], "symbol-spacing": 115, "text-max-angle": 45, "text-allow-overlap": false, "text-rotation-alignment": "map", "text-pitch-alignment": "map", "text-keep-upright": true }, paint: { "text-color": "#f7fbff", "text-halo-color": "#071015", "text-halo-width": 2.4 } });
      instance.addLayer({ id: "airport-gates", type: "circle", source: "airport-gates", minzoom: 10, paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 3, 14.8, 5, 18, 7], "circle-color": ["case", ["==", ["get", "ref"], selectedStand], "#ffbd62", "#12d99b"], "circle-stroke-color": "#f1fff9", "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 10, 1.2, 16, 2] } });
      instance.addLayer({ id: "airport-gate-labels", type: "symbol", source: "airport-gates", minzoom: 14, layout: { "text-field": ["get", "ref"], "text-size": ["interpolate", ["linear"], ["zoom"], 14, 9, 18, 12], "text-offset": [0, 1], "text-anchor": "top", "text-allow-overlap": false }, paint: { "text-color": "#12d99b", "text-halo-color": "#061a13", "text-halo-width": 1.8 } });
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
    const runways = { type: "FeatureCollection" as const, features: data.runways.map((runway) => ({ type: "Feature" as const, properties: { label: `RW${runway.leIdent}  RW${runway.heIdent}` }, geometry: { type: "LineString" as const, coordinates: [[Number(runway.leLongitudeDeg), Number(runway.leLatitudeDeg)], [Number(runway.heLongitudeDeg), Number(runway.heLatitudeDeg)]] } })) };
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
    const instance = map.current;
    if (!mapReady || !instance?.isStyleLoaded() || !osmGround.data) return;
    (instance.getSource("airport-osm-ground") as maplibregl.GeoJSONSource | undefined)?.setData(osmGround.data as never);
  }, [mapReady, osmGround.data]);

  useEffect(() => {
    if (map.current?.getLayer("airport-gates")) map.current.setPaintProperty("airport-gates", "circle-color", ["case", ["==", ["get", "ref"], selectedStand], "#ffbd62", "#12d99b"]);
  }, [selectedStand]);

  return <div className="ground-map"><div className="ground-map-header"><div><strong>{airport.icao} 机位、跑道与滑行道</strong><span>XFlySim 跑道/机位 · OpenStreetMap 滑行道名称 · 放大后显示详细编号</span></div><span>{osmGround.isFetching ? "正在加载地面标注" : selectedStand ? `已选择：${selectedStand}` : `${data?.gates.length ?? 0} 个机位`}</span></div><div className="airport-ground-canvas" ref={container} /><div className="ground-map-legend"><span><i className="stand-symbol" />机位</span><span><i className="stand-symbol selected" />当前选择</span><span><i className="line-symbol" />跑道中心线</span><span>RW：跑道 · 字母/数字：滑行道</span></div></div>;
}

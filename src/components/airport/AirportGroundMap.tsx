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

function isGroundCoordinateValid(airport: Airport, longitude: number, latitude: number) {
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || Math.abs(longitude) > 180 || Math.abs(latitude) > 90) return false;
  const latitudeKm = Math.abs(latitude - airport.latitude) * 111.32;
  const longitudeKm = Math.abs(longitude - airport.longitude) * 111.32 * Math.max(.1, Math.cos(airport.latitude * Math.PI / 180));
  return Math.hypot(latitudeKm, longitudeKm) <= 45;
}

export function AirportGroundMap({ airport, data, selectedStand, onSelectStand }: { airport: Airport; data?: XflyAirportData; selectedStand: string; onSelectStand: (stand: string) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const airportGroundBounds = useMemo(() => normalizeAirportGroundBounds({ west: airport.longitude - .12, south: airport.latitude - .12, east: airport.longitude + .12, north: airport.latitude + .12 }), [airport.latitude, airport.longitude]);
  const osmGround = useQuery({ queryKey: ["airport-detail-osm-ground", airportGroundBounds], queryFn: ({ signal }) => loadOsmAirportGround(airportGroundBounds, signal), staleTime: 30 * 60_000, retry: 0, networkMode: "always" });
  const osmTaxiwayCount = osmGround.data?.features.filter((feature) => feature.properties.kind === "taxiway" || feature.properties.kind === "taxilane").length ?? 0;
  const osmStandCount = osmGround.data?.features.filter((feature) => feature.properties.kind === "parking_position" || feature.properties.kind === "gate").length ?? 0;

  useEffect(() => {
    if (!container.current || map.current) return;
    setMapReady(false);
    const instance = new maplibregl.Map({ container: container.current, center: [airport.longitude, airport.latitude], zoom: 14.8, style: groundStyle, attributionControl: false });
    instance.addControl(new maplibregl.NavigationControl({ showCompass: true }), "top-right");
    instance.on("load", () => {
      instance.addSource("airport-runways", { type: "geojson", data: emptyCollection() });
      instance.addSource("airport-runway-ends", { type: "geojson", data: emptyCollection() });
      instance.addSource("airport-gates", { type: "geojson", data: emptyCollection() });
      instance.addSource("airport-osm-ground", { type: "geojson", data: emptyCollection() });
      instance.addLayer({ id: "airport-osm-apron-fill", type: "fill", source: "airport-osm-ground", minzoom: 11.5, filter: ["==", ["get", "kind"], "apron"], paint: { "fill-color": "#627482", "fill-opacity": .68 } });
      instance.addLayer({ id: "airport-osm-apron-line", type: "line", source: "airport-osm-ground", minzoom: 11.5, filter: ["==", ["get", "kind"], "apron"], paint: { "line-color": "#a7bbc7", "line-width": 1.2 } });
      instance.addLayer({ id: "airport-osm-terminal-fill", type: "fill", source: "airport-osm-ground", minzoom: 11.5, filter: ["==", ["get", "kind"], "terminal"], paint: { "fill-color": "#263d50", "fill-opacity": .9 } });
      instance.addLayer({ id: "airport-osm-terminal-line", type: "line", source: "airport-osm-ground", minzoom: 11.5, filter: ["==", ["get", "kind"], "terminal"], paint: { "line-color": "#9fc5d8", "line-width": 1.5 } });
      instance.addLayer({ id: "airport-osm-runway-casing", type: "line", source: "airport-osm-ground", minzoom: 11.5, filter: ["==", ["get", "kind"], "runway"], paint: { "line-color": "#111a21", "line-width": ["interpolate", ["linear"], ["zoom"], 11.5, 8, 16, 28] } });
      instance.addLayer({ id: "airport-osm-runway-line", type: "line", source: "airport-osm-ground", minzoom: 11.5, filter: ["==", ["get", "kind"], "runway"], paint: { "line-color": "#cbd4d9", "line-width": ["interpolate", ["linear"], ["zoom"], 11.5, 5, 16, 22] } });
      instance.addLayer({ id: "airport-osm-taxiway-casing", type: "line", source: "airport-osm-ground", minzoom: 11.5, filter: ["in", ["get", "kind"], ["literal", ["taxiway", "taxilane"]]], paint: { "line-color": "#3d3011", "line-width": ["interpolate", ["linear"], ["zoom"], 11.5, 3, 17, 12] } });
      instance.addLayer({ id: "airport-osm-taxiway-line", type: "line", source: "airport-osm-ground", minzoom: 11.5, filter: ["in", ["get", "kind"], ["literal", ["taxiway", "taxilane"]]], paint: { "line-color": "#f0c44e", "line-width": ["interpolate", ["linear"], ["zoom"], 11.5, 1.4, 17, 6] } });
      instance.addLayer({ id: "airport-runway-casing", type: "line", source: "airport-runways", paint: { "line-color": "#0b1822", "line-width": ["interpolate", ["linear"], ["zoom"], 13, 5, 17, 17] } });
      instance.addLayer({ id: "airport-runways", type: "line", source: "airport-runways", paint: { "line-color": "#d2dbe0", "line-width": ["interpolate", ["linear"], ["zoom"], 13, 2.5, 17, 11], "line-dasharray": [2, 1] } });
      // 跑道号显示在各自跑道头（端点标签），不再沿跑道线重复。
      instance.addLayer({ id: "airport-runway-labels", type: "symbol", source: "airport-runway-ends", minzoom: 13, layout: { "text-field": ["get", "label"], "text-size": ["interpolate", ["linear"], ["zoom"], 13, 12, 17, 17], "text-letter-spacing": .08, "text-allow-overlap": true, "text-ignore-placement": true }, paint: { "text-color": "#58f3ff", "text-halo-color": "#071015", "text-halo-width": 2.6 } });
      instance.addLayer({ id: "airport-osm-runway-labels", type: "symbol", source: "airport-osm-ground", minzoom: 13, filter: ["==", ["get", "kind"], "runway-end"], layout: { "text-field": ["get", "label"], "text-size": ["interpolate", ["linear"], ["zoom"], 13, 12, 17, 17], "text-allow-overlap": true, "text-ignore-placement": true }, paint: { "text-color": "#58f3ff", "text-halo-color": "#071015", "text-halo-width": 2.6 } });
      instance.addLayer({ id: "airport-taxiway-labels", type: "symbol", source: "airport-osm-ground", minzoom: 13.5, filter: ["all", ["in", ["get", "kind"], ["literal", ["taxiway", "taxilane"]]], ["!=", ["get", "label"], ""]], layout: { "symbol-placement": "line", "text-field": ["get", "label"], "text-size": ["interpolate", ["linear"], ["zoom"], 13.5, 10, 18, 15], "symbol-spacing": 115, "text-max-angle": 45, "text-allow-overlap": false, "text-rotation-alignment": "map", "text-pitch-alignment": "map", "text-keep-upright": true }, paint: { "text-color": "#f7fbff", "text-halo-color": "#071015", "text-halo-width": 2.4 } });
      instance.addLayer({ id: "airport-osm-stand-points", type: "circle", source: "airport-osm-ground", minzoom: 12.5, filter: ["in", ["get", "kind"], ["literal", ["parking_position", "gate"]]], paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 12.5, 2.5, 15, 4.5, 18, 6], "circle-color": "#64d7ff", "circle-opacity": .8, "circle-stroke-color": "#092334", "circle-stroke-width": 1.2 } });
      instance.addLayer({ id: "airport-osm-stand-labels", type: "symbol", source: "airport-osm-ground", minzoom: 15, filter: ["all", ["in", ["get", "kind"], ["literal", ["parking_position", "gate"]]], ["!=", ["get", "label"], ""]], layout: { "text-field": ["get", "label"], "text-size": ["interpolate", ["linear"], ["zoom"], 15, 9, 18, 12], "text-offset": [0, 1], "text-anchor": "top", "text-allow-overlap": false }, paint: { "text-color": "#ccefff", "text-halo-color": "#092334", "text-halo-width": 1.5 } });
      instance.addLayer({ id: "airport-gates", type: "circle", source: "airport-gates", minzoom: 10, paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 4, 14.8, 6, 18, 8], "circle-color": ["case", ["==", ["get", "ref"], selectedStand], "#ffbd62", "#12d99b"], "circle-stroke-color": "#f1fff9", "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 10, 1.4, 16, 2.2] } });
      instance.addLayer({ id: "airport-gate-labels", type: "symbol", source: "airport-gates", minzoom: 13.5, layout: { "text-field": ["get", "ref"], "text-size": ["interpolate", ["linear"], ["zoom"], 13.5, 9, 18, 12], "text-offset": [0, 1], "text-anchor": "top", "text-allow-overlap": false, "text-optional": true }, paint: { "text-color": "#12d99b", "text-halo-color": "#061a13", "text-halo-width": 1.8 } });
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
    if (!mapReady || !instance || !data) return;
    const validGates = data.gates.filter((gate) => isGroundCoordinateValid(airport, Number(gate.longitude), Number(gate.latitude)));
    const validRunways = data.runways.filter((runway) => isGroundCoordinateValid(airport, Number(runway.leLongitudeDeg), Number(runway.leLatitudeDeg)) && isGroundCoordinateValid(airport, Number(runway.heLongitudeDeg), Number(runway.heLatitudeDeg)));
    const gates = { type: "FeatureCollection" as const, features: validGates.map((gate) => ({ type: "Feature" as const, properties: { ref: gate.gateRef, type: gate.gateType }, geometry: { type: "Point" as const, coordinates: [Number(gate.longitude), Number(gate.latitude)] } })) };
    const runways = { type: "FeatureCollection" as const, features: validRunways.map((runway) => ({ type: "Feature" as const, properties: { label: `RW${runway.leIdent}  RW${runway.heIdent}` }, geometry: { type: "LineString" as const, coordinates: [[Number(runway.leLongitudeDeg), Number(runway.leLatitudeDeg)], [Number(runway.heLongitudeDeg), Number(runway.heLatitudeDeg)]] } })) };
    // le/he 字段与两端坐标一一对应，跑道号直接放在各自跑道头。
    const runwayEnds = { type: "FeatureCollection" as const, features: validRunways.flatMap((runway) => [
      { type: "Feature" as const, properties: { label: `RW${runway.leIdent}` }, geometry: { type: "Point" as const, coordinates: [Number(runway.leLongitudeDeg), Number(runway.leLatitudeDeg)] } },
      { type: "Feature" as const, properties: { label: `RW${runway.heIdent}` }, geometry: { type: "Point" as const, coordinates: [Number(runway.heLongitudeDeg), Number(runway.heLatitudeDeg)] } },
    ]) };
    (instance.getSource("airport-gates") as maplibregl.GeoJSONSource | undefined)?.setData(gates);
    (instance.getSource("airport-runways") as maplibregl.GeoJSONSource | undefined)?.setData(runways);
    (instance.getSource("airport-runway-ends") as maplibregl.GeoJSONSource | undefined)?.setData(runwayEnds);
    if (validGates.length || validRunways.length) {
      const bounds = new maplibregl.LngLatBounds();
      validGates.forEach((gate) => bounds.extend([Number(gate.longitude), Number(gate.latitude)]));
      validRunways.forEach((runway) => { bounds.extend([Number(runway.leLongitudeDeg), Number(runway.leLatitudeDeg)]); bounds.extend([Number(runway.heLongitudeDeg), Number(runway.heLatitudeDeg)]); });
      if (!bounds.isEmpty()) instance.fitBounds(bounds, { padding: 42, maxZoom: 16.4, duration: 500 });
    }
  }, [data, airport.icao, mapReady]);

  useEffect(() => {
    const instance = map.current;
    if (!mapReady || !instance || !osmGround.data) return;
    (instance.getSource("airport-osm-ground") as maplibregl.GeoJSONSource | undefined)?.setData(osmGround.data as never);
  }, [mapReady, osmGround.data]);

  useEffect(() => {
    if (map.current?.getLayer("airport-gates")) map.current.setPaintProperty("airport-gates", "circle-color", ["case", ["==", ["get", "ref"], selectedStand], "#ffbd62", "#12d99b"]);
  }, [selectedStand]);

  const groundStatus = osmGround.isFetching ? "正在加载 OSM 地面设施" : osmGround.isError ? "OSM 滑行道加载失败" : selectedStand ? `已选择：${selectedStand}` : `${osmTaxiwayCount} 段滑行道 · ${osmStandCount} 个 OSM 机位`;

  return <div className="ground-map"><div className="ground-map-header"><div><strong>{airport.icao} 机位、跑道与滑行道</strong><span>XFlySim 跑道/机位 · OpenStreetMap 地面设施 · 放大后显示详细编号</span></div><span>{groundStatus}</span></div>{osmGround.isError && <p className="chartfox-state error">无法读取 OpenStreetMap 滑行道数据：{osmGround.error.message}</p>}<div className="airport-ground-canvas" ref={container} /><div className="ground-map-legend"><span><i className="stand-symbol" />XFlySim 机位</span><span><i className="osm-stand-symbol" />OSM 机位</span><span><i className="stand-symbol selected" />当前选择</span><span><i className="runway-line-symbol" />跑道</span><span><i className="line-symbol" />滑行道</span><span><i className="apron-symbol" />机坪/航站楼</span><span>RW：跑道 · 字母/数字：滑行道</span></div></div>;
}

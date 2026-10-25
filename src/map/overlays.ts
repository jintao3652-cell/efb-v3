import type { Map as MapLibreMap, LayerSpecification } from "maplibre-gl";
import type { MapLayerKey, Theme } from "../stores/app-store";
import { TRAFFIC_PLANE_ICON } from "./traffic-plane";

export interface OverlayTheme {
  airway: string;
  airwayLabel: string;
  waypoint: string;
  waypointLabel: string;
  airport: string;
  airportLabel: string;
  procedure: string;
  route: string;
  /** 选中机组的已飞轨迹（实线，橙色，和计划航路的蓝色虚线区分开） */
  track: string;
  airspace: string;
  control: string;
  traffic: string;
  halo: string;
  ground: string;
}

export function overlayTheme(theme: Theme): OverlayTheme {
  return theme === "dark"
    ? {
        airway: "#7d8590",
        airwayLabel: "#b9c2cd",
        waypoint: "#c8d2de",
        waypointLabel: "#dbe3ec",
        airport: "#e8eef6",
        airportLabel: "#f0f5fb",
        procedure: "#ff5f9e",
        route: "#4da3f0",
        track: "#ff9f45",
        airspace: "#f0b64d",
        control: "#9d8bff",
        traffic: "#5ad0a0",
        halo: "rgba(12,16,21,.92)",
        ground: "#2a3038",
      }
    : {
        airway: "#98a0ab",
        airwayLabel: "#6b7178",
        waypoint: "#7c848e",
        waypointLabel: "#4a4f57",
        airport: "#3d4450",
        airportLabel: "#2b3037",
        procedure: "#d81b60",
        route: "#127dd1",
        track: "#d9611a",
        airspace: "#e2a12a",
        control: "#7a5cf0",
        traffic: "#1f9d63",
        halo: "rgba(255,255,255,.94)",
        ground: "#d7dbe0",
      };
}

const EMPTY = { type: "FeatureCollection" as const, features: [] as unknown[] };

export const OVERLAY_SOURCES = [
  "ov-airways",
  "ov-waypoints",
  "ov-airports",
  "ov-airspace",
  "ov-control",
  "ov-procedure",
  "ov-procedure-points",
  "ov-proc-runway",
  "ov-route",
  "ov-track",
  "ov-pilot-route",
  "ov-traffic",
  "ov-ground",
] as const;

export const OVERLAY_GROUPS: Record<MapLayerKey, string[]> = {
  airways: ["ov-airway-line", "ov-airway-label"],
  waypoints: ["ov-waypoint", "ov-waypoint-label"],
  airports: ["ov-airport", "ov-airport-label-major", "ov-airport-label"],
  airspace: ["ov-airspace-fill", "ov-airspace-line", "ov-airspace-label"],
  onlineControl: ["ov-control-fill", "ov-control-line", "ov-control-label"],
  traffic: ["ov-traffic", "ov-traffic-label"],
  ground: ["ov-ground-apron", "ov-ground-runway", "ov-ground-taxiway", "ov-ground-stand", "ov-ground-label"],
  route: ["ov-route-casing", "ov-route-line", "ov-pilot-route-casing", "ov-pilot-route-line", "ov-track-casing", "ov-track-line"],
  // 航图栅格层由 chart-overlay.ts 动态加（要等 PDF 渲染完），这里只管可见性
  chart: ["ov-chart"],
  weather: ["weather-radar"],
};

function layerSpecs(t: OverlayTheme, theme: Theme): LayerSpecification[] {
  const dark = theme === "dark";
  return [
    {
      id: "ov-airway-line",
      type: "line",
      source: "ov-airways",
      minzoom: 4,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": t.airway,
        "line-width": ["interpolate", ["linear"], ["zoom"], 4, 0.5, 8, 0.85, 12, 1.25],
        "line-opacity": ["interpolate", ["linear"], ["zoom"], 4, 0.55, 9, 0.9],
      },
    },
    {
      id: "ov-airway-label",
      type: "symbol",
      source: "ov-airways",
      minzoom: 6,
      layout: {
        "symbol-placement": "line",
        "symbol-spacing": 260,
        "text-field": ["concat", ["get", "name"], "  ", ["get", "length"]],
        "text-font": ["Noto Sans Regular"],
        "text-size": 9.5,
        "text-letter-spacing": 0.04,
        "text-padding": 2,
      },
      paint: { "text-color": t.airwayLabel, "text-halo-color": t.halo, "text-halo-width": 1.1 },
    },
    {
      id: "ov-waypoint",
      type: "circle",
      source: "ov-waypoints",
      minzoom: 5,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 5, 2, 10, 3.2, 14, 4.4],
        "circle-color": dark ? "#0f1419" : "#ffffff",
        "circle-stroke-color": t.waypoint,
        "circle-stroke-width": 1.2,
      },
    },
    {
      id: "ov-waypoint-label",
      type: "symbol",
      source: "ov-waypoints",
      minzoom: 7,
      layout: {
        "text-field": ["get", "ident"],
        "text-font": ["Noto Sans Bold"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 7, 9, 12, 11],
        "text-offset": [0, 0.9],
        "text-anchor": "top",
        "text-padding": 3,
      },
      paint: { "text-color": t.waypointLabel, "text-halo-color": t.halo, "text-halo-width": 1.2 },
    },
    {
      id: "ov-airport",
      type: "circle",
      source: "ov-airports",
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 2.6, 9, 4.2, 13, 6],
        "circle-color": dark ? "#101820" : "#ffffff",
        "circle-stroke-color": t.airport,
        "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 4, 1.4, 10, 2],
      },
    },
    {
      id: "ov-airport-label-major",
      type: "symbol",
      source: "ov-airports",
      minzoom: 3.4,
      filter: ["==", ["get", "major"], true],
      layout: {
        // label：国内机场两行「ICAO + 中文名」（AD_HP），国外只有 ICAO
        "text-field": ["get", "label"],
        "text-font": ["Noto Sans Bold"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 4, 9.5, 9, 11, 13, 12.5],
        "text-offset": [0, 1.06],
        "text-anchor": "top",
        "text-padding": 5,
        "text-allow-overlap": false,
      },
      paint: { "text-color": t.airportLabel, "text-halo-color": t.halo, "text-halo-width": 1.4 },
    },
    {
      id: "ov-airport-label",
      type: "symbol",
      source: "ov-airports",
      minzoom: 6.4,
      layout: {
        // 与 major 层一致：国内机场两行「ICAO + 中文名」
        "text-field": ["get", "label"],
        "text-font": ["Noto Sans Bold"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 6.4, 9.5, 10, 11, 13, 12.5],
        "text-offset": [0, 1.06],
        "text-anchor": "top",
        "text-padding": 4,
        "text-allow-overlap": false,
      },
      paint: { "text-color": t.airportLabel, "text-halo-color": t.halo, "text-halo-width": 1.4 },
    },
    {
      id: "ov-airspace-fill",
      type: "fill",
      source: "ov-airspace",
      paint: { "fill-color": t.airspace, "fill-opacity": 0.18 },
    },
    {
      id: "ov-airspace-line",
      type: "line",
      source: "ov-airspace",
      paint: { "line-color": t.airspace, "line-width": 1.6, "line-opacity": 0.9 },
    },
    {
      id: "ov-airspace-label",
      type: "symbol",
      source: "ov-airspace",
      layout: {
        "text-field": ["get", "label"],
        "text-font": ["Noto Sans Bold"],
        "text-size": 10,
        "symbol-placement": "point",
      },
      paint: { "text-color": t.airspace, "text-halo-color": t.halo, "text-halo-width": 1.2 },
    },
    {
      id: "ov-control-fill",
      type: "fill",
      source: "ov-control",
      paint: { "fill-color": t.control, "fill-opacity": 0.1 },
    },
    {
      id: "ov-control-line",
      type: "line",
      source: "ov-control",
      paint: { "line-color": t.control, "line-width": 1.1, "line-opacity": 0.65 },
    },
    {
      id: "ov-control-label",
      type: "symbol",
      source: "ov-control",
      minzoom: 5,
      layout: { "text-field": ["get", "label"], "text-font": ["Noto Sans Regular"], "text-size": 9.5 },
      paint: { "text-color": t.control, "text-halo-color": t.halo, "text-halo-width": 1.1 },
    },
    {
      id: "ov-procedure-casing",
      type: "line",
      source: "ov-procedure",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": dark ? "rgba(255,255,255,.55)" : "rgba(255,255,255,.95)", "line-width": ["interpolate", ["linear"], ["zoom"], 6, 4.6, 12, 7] },
    },
    {
      id: "ov-procedure-line",
      type: "line",
      source: "ov-procedure",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": t.procedure, "line-width": ["interpolate", ["linear"], ["zoom"], 6, 2.4, 12, 3.4], "line-opacity": 0.95 },
    },
    {
      id: "ov-procedure-point",
      type: "circle",
      source: "ov-procedure-points",
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, 3.4, 12, 4.8],
        "circle-color": dark ? "#0f1419" : "#ffffff",
        "circle-stroke-color": t.procedure,
        "circle-stroke-width": 1.6,
      },
    },
    {
      id: "ov-procedure-label",
      type: "symbol",
      source: "ov-procedure-points",
      minzoom: 7,
      layout: {
        "text-field": ["coalesce", ["get", "label"], ["get", "ident"]],
        "text-font": ["Noto Sans Bold"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 7, 9.5, 12, 11],
        "text-offset": [0, -1.05],
        "text-anchor": "bottom",
      },
      paint: { "text-color": t.procedure, "text-halo-color": t.halo, "text-halo-width": 1.3 },
    },
    // 程序跑道：沥青色实线 + 两端 RW 标注，随选中程序一起出现。
    {
      id: "ov-proc-runway-casing",
      type: "line",
      source: "ov-proc-runway",
      filter: ["==", ["geometry-type"], "LineString"],
      layout: { "line-cap": "butt" },
      paint: { "line-color": dark ? "rgba(0,0,0,.6)" : "rgba(18,22,26,.5)", "line-width": ["interpolate", ["linear"], ["zoom"], 10, 6.5, 14, 15] },
    },
    {
      id: "ov-proc-runway",
      type: "line",
      source: "ov-proc-runway",
      filter: ["==", ["geometry-type"], "LineString"],
      layout: { "line-cap": "butt" },
      paint: { "line-color": dark ? "#dfe3e8" : "#33383e", "line-width": ["interpolate", ["linear"], ["zoom"], 10, 4, 14, 10] },
    },
    {
      id: "ov-proc-runway-label",
      type: "symbol",
      source: "ov-proc-runway",
      filter: ["==", ["geometry-type"], "Point"],
      minzoom: 8.5,
      layout: {
        "text-field": ["get", "label"],
        "text-font": ["Noto Sans Bold"],
        "text-size": 10,
        "text-offset": [0, -1],
        "text-anchor": "bottom",
        "text-allow-overlap": true,
      },
      paint: { "text-color": t.airport, "text-halo-color": t.halo, "text-halo-width": 1.3 },
    },
    {
      id: "ov-route-casing",
      type: "line",
      source: "ov-route",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": dark ? "rgba(255,255,255,.35)" : "rgba(255,255,255,.9)", "line-width": ["interpolate", ["linear"], ["zoom"], 3, 3.4, 9, 6] },
    },
    {
      id: "ov-route-line",
      type: "line",
      source: "ov-route",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": t.route, "line-width": ["interpolate", ["linear"], ["zoom"], 3, 1.6, 9, 3], "line-dasharray": [2, 0] },
    },
    {
      // 计划航路：蓝色虚线。和实线的已飞轨迹叠在一起看，偏航一眼能看出来。
      id: "ov-pilot-route-casing",
      type: "line",
      source: "ov-pilot-route",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": dark ? "rgba(255,255,255,.22)" : "rgba(255,255,255,.85)", "line-width": ["interpolate", ["linear"], ["zoom"], 3, 3, 9, 5] },
    },
    {
      id: "ov-pilot-route-line",
      type: "line",
      source: "ov-pilot-route",
      layout: { "line-cap": "butt", "line-join": "round" },
      paint: {
        "line-color": t.route,
        "line-width": ["interpolate", ["linear"], ["zoom"], 3, 1.3, 9, 2.3],
        "line-dasharray": [1.6, 1.6],
        "line-opacity": 0.95,
      },
    },
    {
      id: "ov-track-casing",
      type: "line",
      source: "ov-track",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": dark ? "rgba(0,0,0,.5)" : "rgba(255,255,255,.92)", "line-width": ["interpolate", ["linear"], ["zoom"], 3, 4, 9, 6.4] },
    },
    {
      // 已飞轨迹：实线橙色，压在计划航路之上，用来核对机组实际走的航路。
      id: "ov-track-line",
      type: "line",
      source: "ov-track",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": t.track,
        "line-width": ["interpolate", ["linear"], ["zoom"], 3, 1.8, 9, 3.2],
        "line-opacity": 0.95,
      },
    },
    {
      // 飞机剪影按航向旋转：默认蓝色，选中后换成琥珀色（见 traffic-plane.ts）。
      id: "ov-traffic",
      type: "symbol",
      source: "ov-traffic",
      layout: {
        "icon-image": TRAFFIC_PLANE_ICON,
        "icon-size": ["interpolate", ["linear"], ["zoom"], 2, 0.34, 6, 0.46, 10, 0.62, 13, 0.8],
        "icon-rotate": ["coalesce", ["get", "heading"], 0],
        "icon-rotation-alignment": "map",
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
      },
    },
    {
      id: "ov-traffic-label",
      type: "symbol",
      source: "ov-traffic",
      minzoom: 5.5,
      layout: {
        "text-field": ["concat", ["get", "callsign"], "\n", ["get", "detail"]],
        "text-font": ["Noto Sans Regular"],
        "text-size": 9.5,
        "text-offset": [0, 1],
        "text-anchor": "top",
        "text-line-height": 1.15,
      },
      paint: { "text-color": t.traffic, "text-halo-color": t.halo, "text-halo-width": 1.2 },
    },
    {
      id: "ov-ground-apron",
      type: "fill",
      source: "ov-ground",
      filter: ["==", ["get", "kind"], "apron"],
      paint: { "fill-color": dark ? "#20262d" : "#dfe3e8", "fill-opacity": 0.9 },
    },
    {
      id: "ov-ground-runway",
      type: "line",
      source: "ov-ground",
      filter: ["in", ["get", "kind"], ["literal", ["runway", "taxiway"]]] as never,
      paint: {
        "line-color": ["match", ["get", "kind"], "runway", dark ? "#7c848d" : "#7e868f", dark ? "#f0c14b" : "#e8b83c"],
        "line-width": ["match", ["get", "kind"], "runway", 9, 3.4],
      },
    },
    {
      id: "ov-ground-taxiway",
      type: "line",
      source: "ov-ground",
      filter: ["==", ["get", "kind"], "taxiway-dash"],
      paint: { "line-color": dark ? "#f0c14b" : "#d9a324", "line-width": 1.4, "line-dasharray": [3, 2] },
    },
    {
      id: "ov-ground-stand",
      type: "circle",
      source: "ov-ground",
      minzoom: 11.5,
      filter: ["==", ["get", "kind"], "stand"],
      paint: { "circle-radius": 2.4, "circle-color": dark ? "#f2c94c" : "#e0a90f" },
    },
    {
      // 廊桥/登机口：比远机位大一点、用品牌蓝，滑行时一眼能分清。
      id: "ov-ground-gate",
      type: "circle",
      source: "ov-ground",
      minzoom: 11.5,
      filter: ["==", ["get", "kind"], "gate"],
      paint: {
        "circle-radius": 3,
        "circle-color": dark ? "#7fb6ff" : "#2f6fdc",
        "circle-stroke-color": dark ? "#0f1720" : "#ffffff",
        "circle-stroke-width": 1,
      },
    },
    {
      id: "ov-ground-label",
      type: "symbol",
      source: "ov-ground",
      minzoom: 12.8,
      filter: ["==", ["get", "kind"], "label"],
      layout: {
        "text-field": ["get", "label"],
        "text-font": ["Noto Sans Bold"],
        "text-size": 10,
        "text-padding": 2,
      },
      paint: { "text-color": dark ? "#f5d98a" : "#5a5f66", "text-halo-color": t.halo, "text-halo-width": 1.2 },
    },
  ] as LayerSpecification[];
}

export function addOverlays(map: MapLibreMap, theme: Theme, radarTiles?: string) {
  const t = overlayTheme(theme);
  for (const id of OVERLAY_SOURCES) {
    if (!map.getSource(id)) map.addSource(id, { type: "geojson", data: EMPTY as never });
  }
  if (radarTiles && !map.getSource("weather-radar")) {
    map.addSource("weather-radar", { type: "raster", tiles: [radarTiles], tileSize: 256, attribution: "© OpenWeather" });
  }
  const layers = layerSpecs(t, theme);
  if (radarTiles) {
    layers.unshift({ id: "weather-radar", type: "raster", source: "weather-radar", layout: { visibility: "none" }, paint: { "raster-opacity": 0.6, "raster-fade-duration": 0 } });
  }
  for (const layer of layers) {
    if (!map.getLayer(layer.id)) map.addLayer(layer);
  }
}

/** 主题切换：不重建样式，只改涂料，避免航路数据重新加载。 */
export function recolorOverlays(map: MapLibreMap, theme: Theme) {
  const t = overlayTheme(theme);
  const dark = theme === "dark";
  const set = (id: string, prop: string, value: unknown) => {
    if (map.getLayer(id)) map.setPaintProperty(id, prop as never, value as never);
  };
  set("ov-airway-line", "line-color", t.airway);
  set("ov-airway-label", "text-color", t.airwayLabel);
  set("ov-waypoint", "circle-color", dark ? "#0f1419" : "#ffffff");
  set("ov-waypoint", "circle-stroke-color", t.waypoint);
  set("ov-waypoint-label", "text-color", t.waypointLabel);
  set("ov-airport", "circle-color", dark ? "#101820" : "#ffffff");
  set("ov-airport", "circle-stroke-color", t.airport);
  set("ov-airport-label", "text-color", t.airportLabel);
  set("ov-airport-label-major", "text-color", t.airportLabel);
  set("ov-airspace-fill", "fill-color", t.airspace);
  set("ov-airspace-line", "line-color", t.airspace);
  set("ov-airspace-label", "text-color", t.airspace);
  set("ov-control-fill", "fill-color", t.control);
  set("ov-control-line", "line-color", t.control);
  set("ov-control-label", "text-color", t.control);
  set("ov-procedure-line", "line-color", t.procedure);
  set("ov-procedure-casing", "line-color", dark ? "rgba(255,255,255,.55)" : "rgba(255,255,255,.95)");
  set("ov-procedure-point", "circle-stroke-color", t.procedure);
  set("ov-procedure-point", "circle-color", dark ? "#0f1419" : "#ffffff");
  set("ov-procedure-label", "text-color", t.procedure);
  set("ov-route-line", "line-color", t.route);
  set("ov-pilot-route-line", "line-color", t.route);
  set("ov-pilot-route-casing", "line-color", dark ? "rgba(255,255,255,.22)" : "rgba(255,255,255,.85)");
  set("ov-track-line", "line-color", t.track);
  set("ov-track-casing", "line-color", dark ? "rgba(0,0,0,.5)" : "rgba(255,255,255,.92)");
  set("ov-traffic", "circle-color", t.traffic);
  set("ov-traffic", "circle-stroke-color", dark ? "#0f1419" : "#ffffff");
  set("ov-traffic-label", "text-color", t.traffic);
  set("ov-ground-runway", "line-color", ["match", ["get", "kind"], "runway", dark ? "#7c848d" : "#7e868f", dark ? "#f0c14b" : "#e8b83c"]);
  set("ov-ground-apron", "fill-color", dark ? "#20262d" : "#dfe3e8");
  set("ov-ground-label", "text-color", dark ? "#f5d98a" : "#5a5f66");
}

export function syncOverlayVisibility(map: MapLibreMap, layers: Record<MapLayerKey, boolean>) {
  for (const [key, ids] of Object.entries(OVERLAY_GROUPS) as Array<[MapLayerKey, string[]]>) {
    const visible = layers[key];
    for (const id of ids) {
      if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
    }
  }
}

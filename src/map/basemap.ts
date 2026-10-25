import type { Map, StyleSpecification } from "maplibre-gl";
import type { BaseMap, Theme } from "../stores/app-store";

/**
 * 底图：矢量用的是 OpenFreeMap 官方样式（Positron 浅灰 / Dark 深色），
 * 与 eAIP 的「低饱和陆地 + 浅蓝水域 + 细灰路网」阅读习惯一致，且无需 API Key。
 * 卫星用 Esri World Imagery 栅格。
 */
const VECTOR_LIGHT = import.meta.env.VITE_BASEMAP_LIGHT?.trim() || "https://tiles.openfreemap.org/styles/positron";
const VECTOR_DARK = import.meta.env.VITE_BASEMAP_DARK?.trim() || "https://tiles.openfreemap.org/styles/dark";
const SATELLITE_TILES = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";

export function buildBaseStyle(theme: Theme, baseMap: BaseMap): StyleSpecification | string {
  if (baseMap === "satellite") {
    return {
      version: 8,
      sources: {
        "base-raster": {
          type: "raster",
          tiles: [SATELLITE_TILES],
          tileSize: 256,
          attribution: "© Esri · Maxar · Earthstar Geographics",
        },
      },
      layers: [
        { id: "background", type: "background", paint: { "background-color": theme === "dark" ? "#12161b" : "#f2f4f7" } },
        {
          id: "base-raster",
          type: "raster",
          source: "base-raster",
          paint: {
            "raster-saturation": theme === "dark" ? -0.35 : -0.2,
            "raster-brightness-max": theme === "dark" ? 0.55 : 0.98,
            "raster-contrast": 0.05,
          },
        },
      ],
    };
  }
  return theme === "dark" ? VECTOR_DARK : VECTOR_LIGHT;
}

/**
 * 官方样式落在航空场景里偏灰，这里按 eAIP 的观感做一次轻量重着色：
 * 陆地提亮、水域转浅蓝、道路与建筑压淡、标注转冷灰。
 * 只改 paint，不触碰图层结构，因此不会破坏样式有效性。
 */
export function tintBaseMap(map: Map, theme: Theme) {
  const dark = theme === "dark";
  const paint = (id: string, prop: string, value: unknown) => {
    if (map.getLayer(id)) map.setPaintProperty(id, prop as never, value as never);
  };

  paint("background", "background-color", dark ? "#12161b" : "#f4f6f9");
  paint("water", "fill-color", dark ? "#0e1c2a" : "#cfe3f3");
  paint("waterway", "line-color", dark ? "#16324a" : "#bcd8ee");
  paint("park", "fill-color", dark ? "#152019" : "#eaf1e6");
  paint("landcover_wood", "fill-color", dark ? "#151d18" : "#e9f0e5");
  paint("landuse_residential", "fill-color", dark ? "#161b21" : "#f7f8fa");
  paint("building", "fill-color", dark ? "#1b2128" : "#e8ebef");
  paint("aeroway-area", "fill-color", dark ? "#1c222a" : "#e9ebef");
  paint("aeroway-runway", "line-color", dark ? "#8792a0" : "#c8cdd5");
  paint("aeroway-runway-casing", "line-color", dark ? "#242c35" : "#dfe3e9");
  paint("aeroway-taxiway", "line-color", dark ? "#2a323b" : "#e2e6eb");
  paint("boundary_2", "line-color", dark ? "#3a4450" : "#bcc4ce");
  paint("boundary_3", "line-color", dark ? "#2f3843" : "#ccd3db");
  paint("highway_major_inner", "line-color", dark ? "#2b333d" : "#ffffff");
  paint("highway_major_casing", "line-color", dark ? "#1b222a" : "#e3e7ec");
  paint("highway_minor", "line-color", dark ? "#262e37" : "#f7f8fa");

  for (const id of ["label_city", "label_town", "label_village", "label_state", "label_other"]) {
    paint(id, "text-color", dark ? "#93a0ae" : "#5d636b");
    paint(id, "text-halo-color", dark ? "rgba(12,16,21,.9)" : "rgba(255,255,255,.95)");
    paint(id, "text-halo-width", 1.2);
  }
  for (const id of ["water_name_point_label", "water_name_line_label", "waterway_line_label"]) {
    paint(id, "text-color", dark ? "#5c7f9c" : "#7d9db8");
  }
  paint("airport", "text-color", dark ? "#8b98a6" : "#6c727a");
  // 底图的机场标注（含标高、外文名）在低缩放级别噪音很大，航空图层统一由 overlay 控制。
  if (map.getLayer("airport")) map.setLayoutProperty("airport", "visibility", "none");
}

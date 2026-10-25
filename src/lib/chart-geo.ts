/**
 * 航图地理配准换算。
 *
 * JeppQuery 的 `/charts/{icao}/geo/bounds/{filename}` 给两组像素矩形加一个地理范围：
 *   page_pixels      整页栅格的像素矩形（航图原始出图尺寸，不是 A4）
 *   coverage_pixels  其中真正画了地图的那块子矩形（整页含标题块、页边，不能直接用）
 *   coverage         子矩形对应的经纬度范围（北向上）
 *
 * 因为服务端只给轴对齐的 bbox，换算按「经度随 x 线性、纬度随 y 线性」处理：
 * 先由 coverage 段解出像素→经纬度的线性系数，再外推到整页四角。
 * 返回的四角交给 MapLibre 的 image source，非等比缩放由投影自动校正。
 */
import type { JeppGeoBounds } from "./jepp";

export type LngLat = [number, number];

export interface ChartQuad {
  /** MapLibre image source 的四角顺序：左上、右上、右下、左下 */
  coordinates: [LngLat, LngLat, LngLat, LngLat];
  /** 覆盖区西南角 / 东北角，给「定位到航图」用 */
  southwest: LngLat;
  northeast: LngLat;
  /** 覆盖区中心，叠加后想回看时先飞到这儿 */
  center: LngLat;
}

interface PixelRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/** 兼容服务端偶尔只给 left/top/right/bottom 的情况。 */
function normalizeRect(rect: PixelRect | undefined) {
  if (!rect) return null;
  const left = Number(rect.left);
  const top = Number(rect.top);
  const right = Number(rect.right ?? left + Number(rect.width));
  const bottom = Number(rect.bottom ?? top + Number(rect.height));
  if (![left, top, right, bottom].every(Number.isFinite)) return null;
  if (right - left <= 0 || bottom - top <= 0) return null;
  return { left, top, right, bottom };
}

/**
 * 整页栅格四角 → 经纬度。
 * 只有 `georeferenced` 且三组数据齐全时才返回；否则返回 null（该图不能叠加）。
 */
export function chartQuad(bounds: JeppGeoBounds | null | undefined): ChartQuad | null {
  if (!bounds?.georeferenced) return null;
  const page = normalizeRect(bounds.page_pixels);
  const cover = normalizeRect(bounds.coverage_pixels);
  const geo = bounds.coverage;
  if (!page || !cover || !geo) return null;
  const latSpan = geo.lat_max - geo.lat_min;
  const lonSpan = geo.lon_max - geo.lon_min;
  if (!(latSpan > 0) || !(lonSpan > 0)) return null;

  const lonAt = (x: number) => geo.lon_min + ((x - cover.left) / (cover.right - cover.left)) * lonSpan;
  // 像素 y 向下、纬度向上：coverage.top 对应 lat_max。
  const latAt = (y: number) => geo.lat_max - ((y - cover.top) / (cover.bottom - cover.top)) * latSpan;

  const topLeft: LngLat = [lonAt(page.left), latAt(page.top)];
  const topRight: LngLat = [lonAt(page.right), latAt(page.top)];
  const bottomRight: LngLat = [lonAt(page.right), latAt(page.bottom)];
  const bottomLeft: LngLat = [lonAt(page.left), latAt(page.bottom)];

  return {
    coordinates: [topLeft, topRight, bottomRight, bottomLeft],
    southwest: [geo.lon_min, geo.lat_min],
    northeast: [geo.lon_max, geo.lat_max],
    center: [(geo.lon_min + geo.lon_max) / 2, (geo.lat_min + geo.lat_max) / 2],
  };
}

/** 覆盖区在经度 / 纬度两个方向上的跨度，用于提示「这张图铺多大」。 */
export function chartSpanNm(bounds: JeppGeoBounds | null | undefined) {
  const geo = bounds?.coverage;
  if (!geo) return null;
  const midLat = ((geo.lat_min + geo.lat_max) / 2) * (Math.PI / 180);
  const heightNm = (geo.lat_max - geo.lat_min) * 60;
  const widthNm = (geo.lon_max - geo.lon_min) * 60 * Math.cos(midLat);
  return { widthNm, heightNm };
}

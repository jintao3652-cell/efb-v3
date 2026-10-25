import { pathLengthNm } from "./route-calc";

export interface TerrainSample {
  distanceNm: number;
  latitude: number;
  longitude: number;
  elevationFt: number | null;
}

function interpolate(points: Array<{ latitude: number; longitude: number }>, fraction: number) {
  if (points.length === 1) return points[0];
  const segmentLengths: number[] = [];
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    const length = pathLengthNm([points[index - 1], points[index]]);
    segmentLengths.push(length);
    total += length;
  }
  let target = total * fraction;
  for (let index = 0; index < segmentLengths.length; index += 1) {
    if (target <= segmentLengths[index] || index === segmentLengths.length - 1) {
      const ratio = segmentLengths[index] === 0 ? 0 : Math.min(1, target / segmentLengths[index]);
      const a = points[index];
      const b = points[index + 1];
      return { latitude: a.latitude + (b.latitude - a.latitude) * ratio, longitude: a.longitude + (b.longitude - a.longitude) * ratio };
    }
    target -= segmentLengths[index];
  }
  return points[points.length - 1];
}

/**
 * 沿航路等距采样地形高程（Open-Meteo Elevation，公开且支持 CORS）。
 * 取不到数据时返回 elevationFt = null 的样本，由界面显示「地形数据不可用」而不是伪造数值。
 */
export async function loadRouteTerrain(points: Array<{ latitude: number; longitude: number }>, samples = 64): Promise<TerrainSample[]> {
  if (points.length < 2) return [];
  const total = pathLengthNm(points);
  const picks = Array.from({ length: samples }, (_, index) => interpolate(points, index / (samples - 1)));
  const results: TerrainSample[] = picks.map((point, index) => ({
    distanceNm: Number(((total * index) / (samples - 1)).toFixed(1)),
    latitude: point.latitude,
    longitude: point.longitude,
    elevationFt: null,
  }));

  const chunkSize = 80;
  for (let start = 0; start < picks.length; start += chunkSize) {
    const chunk = picks.slice(start, start + chunkSize);
    const url = `https://api.open-meteo.com/v1/elevation?latitude=${chunk.map((point) => point.latitude.toFixed(4)).join(",")}&longitude=${chunk.map((point) => point.longitude.toFixed(4)).join(",")}`;
    try {
      const response = await fetch(url);
      if (!response.ok) continue;
      const payload = (await response.json()) as { elevation?: number[] };
      (payload.elevation ?? []).forEach((meters, index) => {
        const target = results[start + index];
        if (target && Number.isFinite(meters)) target.elevationFt = Math.round(meters * 3.28084);
      });
    } catch {
      /* 单批失败保留 null，继续下一批 */
    }
  }
  return results;
}

import type { FlightRoutePoint } from "../types";
import { getNavigationMapData, isTauri, type NavigationAirway, type NavigationMapPoint } from "./tauri";

export interface CandidateRoute {
  id: string;
  name: string;
  routeText: string;
  points: FlightRoutePoint[];
  distanceNm: number;
}

export interface AircraftSpec {
  type: string;
  engine: string;
  oew: number;
  cruiseTas: number;
  burnPerHour: number;
  maxPax: number;
}

export const AIRCRAFT: AircraftSpec[] = [
  { type: "A320", engine: "CFM56-5B4", oew: 43780, cruiseTas: 452, burnPerHour: 2450, maxPax: 180 },
  { type: "A321", engine: "CFM56-5B3", oew: 48500, cruiseTas: 455, burnPerHour: 2680, maxPax: 220 },
  { type: "A333", engine: "Trent 772B", oew: 124500, cruiseTas: 470, burnPerHour: 5600, maxPax: 290 },
  { type: "B738", engine: "CFM56-7B26", oew: 41413, cruiseTas: 450, burnPerHour: 2500, maxPax: 189 },
  { type: "B77W", engine: "GE90-115B", oew: 167800, cruiseTas: 480, burnPerHour: 7300, maxPax: 368 },
];

const NM_PER_DEG = 60;

export function haversineNm(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) {
  const R = 3440.065;
  const toRad = (value: number) => (value * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function pathLengthNm(points: Array<{ latitude: number; longitude: number }>) {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) total += haversineNm(points[index - 1], points[index]);
  return total;
}

/** 大圆插值：t=0 起点、t=1 终点。 */
export function greatCirclePoint(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }, t: number) {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const toDeg = (value: number) => (value * 180) / Math.PI;
  const lat1 = toRad(a.latitude);
  const lon1 = toRad(a.longitude);
  const lat2 = toRad(b.latitude);
  const lon2 = toRad(b.longitude);
  const d = 2 * Math.asin(Math.sqrt(Math.sin((lat2 - lat1) / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2));
  if (d === 0) return { latitude: a.latitude, longitude: a.longitude };
  const A = Math.sin((1 - t) * d) / Math.sin(d);
  const B = Math.sin(t * d) / Math.sin(d);
  const x = A * Math.cos(lat1) * Math.cos(lon1) + B * Math.cos(lat2) * Math.cos(lon2);
  const y = A * Math.cos(lat1) * Math.sin(lon1) + B * Math.cos(lat2) * Math.sin(lon2);
  const z = A * Math.sin(lat1) + B * Math.sin(lat2);
  return { latitude: toDeg(Math.atan2(z, Math.sqrt(x * x + y * y))), longitude: toDeg(Math.atan2(y, x)) };
}

function offsetPoint(point: { latitude: number; longitude: number }, bearingDeg: number, distanceNm: number) {
  const R = 3440.065;
  const toRad = (value: number) => (value * Math.PI) / 180;
  const toDeg = (value: number) => (value * 180) / Math.PI;
  const bearing = toRad(bearingDeg);
  const lat1 = toRad(point.latitude);
  const lon1 = toRad(point.longitude);
  const angular = distanceNm / R;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(angular) + Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing));
  const lon2 = lon1 + Math.atan2(Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1), Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2));
  return { latitude: toDeg(lat2), longitude: ((toDeg(lon2) + 540) % 360) - 180 };
}

function bearingBetween(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const toDeg = (value: number) => (value * 180) / Math.PI;
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function airwayBetween(airways: NavigationAirway[], a: NavigationMapPoint, b: NavigationMapPoint) {
  const near = (coordinates: number[][], point: NavigationMapPoint) =>
    coordinates.some(([longitude, latitude]) => Math.abs(longitude - point.longitude) < 0.06 && Math.abs(latitude - point.latitude) < 0.06);
  for (const airway of airways) {
    if (airway.coordinates.length < 2) continue;
    if (near(airway.coordinates, a) && near(airway.coordinates, b)) return airway.name;
  }
  return "";
}

function nearestWaypoint(waypoints: NavigationMapPoint[], target: { latitude: number; longitude: number }, maxNm: number) {
  let best: NavigationMapPoint | null = null;
  let bestDistance = maxNm;
  for (const waypoint of waypoints) {
    const distance = haversineNm(waypoint, target);
    if (distance < bestDistance) { bestDistance = distance; best = waypoint; }
  }
  return best;
}

/**
 * 生成候选航路：以起降大圆为骨架，沿线吸附导航数据库中的航路点，
 * 再用航路点之间的航路匹配（坐标邻近）拼出 `WPT AIRWAY WPT` 形式的航路文本。
 * 三条候选分别取骨架、左偏 25 NM、右偏 35 NM，供签派比较距离差异。
 */
export async function buildCandidateRoutes(
  dep: { ident: string; latitude: number; longitude: number },
  arr: { ident: string; latitude: number; longitude: number },
  label: string,
): Promise<CandidateRoute[]> {
  const directDistance = haversineNm(dep, arr);
  const variants: Array<{ suffix: string; offsetNm: number; note: string }> = [
    { suffix: "01", offsetNm: 0, note: "大圆基准" },
    { suffix: "03X", offsetNm: 25, note: "左偏" },
    { suffix: "01X", offsetNm: -35, note: "右偏" },
  ];

  let waypoints: NavigationMapPoint[] = [];
  let airways: NavigationAirway[] = [];
  if (isTauri()) {
    try {
      const pad = Math.max(2.5, directDistance / NM_PER_DEG * 0.25);
      const data = await getNavigationMapData({
        west: Math.min(dep.longitude, arr.longitude) - pad,
        south: Math.min(dep.latitude, arr.latitude) - pad,
        east: Math.max(dep.longitude, arr.longitude) + pad,
        north: Math.max(dep.latitude, arr.latitude) + pad,
        zoom: 5,
      });
      waypoints = data.navaids.filter((point) => point.latitude && point.longitude);
      airways = data.airways;
    } catch {
      waypoints = [];
    }
  }

  const bearing = bearingBetween(dep, arr);
  const samples = Math.max(3, Math.min(14, Math.round(directDistance / 70)));

  return variants.map((variant) => {
    const points: FlightRoutePoint[] = [{ ident: dep.ident, name: dep.ident, latitude: dep.latitude, longitude: dep.longitude }];
    const picked: NavigationMapPoint[] = [];
    for (let index = 1; index < samples; index += 1) {
      const base = greatCirclePoint(dep, arr, index / samples);
      const target = variant.offsetNm ? offsetPoint(base, bearing + 90, variant.offsetNm) : base;
      if (!waypoints.length) {
        points.push({ ident: `DCT${index}`, name: "", latitude: target.latitude, longitude: target.longitude });
        continue;
      }
      const waypoint = nearestWaypoint(waypoints, target, 90);
      if (!waypoint) continue;
      if (picked.some((item) => item.ident === waypoint.ident)) continue;
      picked.push(waypoint);
      points.push({ ident: waypoint.ident, name: waypoint.name, latitude: waypoint.latitude, longitude: waypoint.longitude });
    }
    points.push({ ident: arr.ident, name: arr.ident, latitude: arr.latitude, longitude: arr.longitude });

    const tokens: string[] = [dep.ident];
    for (let index = 1; index < points.length; index += 1) {
      const previous = picked[index - 1];
      const current = picked[index];
      const airway = previous && current ? airwayBetween(airways, previous, current) : "";
      if (airway) tokens.push(airway);
      const ident = points[index].ident;
      if (!/^DCT\d+$/.test(ident)) tokens.push(ident);
    }
    const text = tokens.join(" ");
    return {
      id: `${dep.ident}-${arr.ident}-${variant.suffix}`,
      name: `${label}-${variant.suffix}`,
      routeText: waypoints.length ? text : `${dep.ident} DCT ${arr.ident}`,
      points,
      distanceNm: Number(pathLengthNm(points).toFixed(1)),
    };
  });
}

export interface Performance {
  distanceNm: number;
  airMinutes: number;
  cruiseAltFt: number;
  cruiseAltMeters: number;
  tripFuel: number;
  taxiFuel: number;
  contingencyFuel: number;
  alternateFuel: number;
  reserveFuel: number;
  blockFuel: number;
  oew: number;
  payload: number;
  zfw: number;
  tow: number;
  lw: number;
  pax: number;
  alternateNm: number;
}

export function parseCruiseAltitude(value: string, fallbackFeet = 33100) {
  const text = value.trim().toUpperCase();
  const flightLevel = /^FL\s?(\d{2,3})$/.exec(text);
  if (flightLevel) return Number(flightLevel[1]) * 100;
  const feet = /^(\d{2,5})\s*(FT|FEET)?$/.exec(text);
  if (feet) return Number(feet[1]);
  const meters = /^(\d{3,5})\s*M$/.exec(text);
  if (meters) return Math.round(Number(meters[1]) * 3.28084);
  return fallbackFeet;
}

/** 简化性能模型：爬升/下降按固定段，巡航按 TAS 与小时耗油，燃油与重量逐层叠加。 */
export function computePerformance(options: {
  distanceNm: number;
  aircraft: AircraftSpec;
  cruiseAltFt: number;
  pax: number;
  alternateNm: number;
  contingencyPercent?: number;
}): Performance {
  const { distanceNm, aircraft, cruiseAltFt, pax, alternateNm } = options;
  const contingencyPercent = options.contingencyPercent ?? 5;
  const climbMinutes = 22;
  const descentMinutes = 26;
  const climbNm = 105;
  const descentNm = 125;
  const cruiseNm = Math.max(0, distanceNm - climbNm - descentNm);
  const cruiseMinutes = (cruiseNm / aircraft.cruiseTas) * 60;
  const airMinutes = Math.round(climbMinutes + cruiseMinutes + descentMinutes);
  const burnPerMinute = aircraft.burnPerHour / 60;
  const tripFuel = Math.round(burnPerMinute * airMinutes * 1.035);
  const taxiFuel = 291;
  const contingencyFuel = Math.round(tripFuel * (contingencyPercent / 100));
  const alternateFuel = Math.round((alternateNm / aircraft.cruiseTas) * aircraft.burnPerHour + 260);
  const reserveFuel = Math.round(burnPerMinute * 30 * 1.1);
  const blockFuel = taxiFuel + tripFuel + contingencyFuel + alternateFuel + reserveFuel;
  const payload = Math.round(pax * 95);
  const zfw = aircraft.oew + payload;
  const tow = zfw + blockFuel;
  const lw = tow - tripFuel - taxiFuel;
  return {
    distanceNm,
    airMinutes,
    cruiseAltFt,
    cruiseAltMeters: Math.round(cruiseAltFt * 0.3048),
    tripFuel,
    taxiFuel,
    contingencyFuel,
    alternateFuel,
    reserveFuel,
    blockFuel,
    oew: aircraft.oew,
    payload,
    zfw,
    tow,
    lw,
    pax,
    alternateNm,
  };
}

export function formatDuration(minutes: number) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

export function formatWeight(value: number) {
  return value.toLocaleString("en-US");
}

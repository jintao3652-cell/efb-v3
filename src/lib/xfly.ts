import { apiResult, apiText } from "./api";

/**
 * XFlySim 开放接口客户端。
 *
 * 文档：https://docs.xflysim.com/api/efb.html
 * 基础地址：https://api.xflysim.com/pilot
 *
 * 所有接口统一返回 `{ code, data, message }`，code=20000 为成功。
 */
const BASE = "https://api.xflysim.com/pilot";

/* ------------------------------------------------------------------ 机场 */

export interface XflyAirport {
  gpsCode: string;
  /** 部分记录与 gpsCode 相同，少数机场只有 ICAO */
  ident: string;
  iataCode: string | null;
  cnName: string | null;
  enName: string | null;
  municipality: string | null;
  municipalityCn: string | null;
  isoCountry: string;
  isoRegion: string;
  continent: string;
  /** large_airport / medium_airport / small_airport / heliport / seaplane_base */
  type: string;
  elevationFt: number | null;
  latitudeDeg: number;
  longitudeDeg: number;
}

export interface XflyRunway {
  airportIdent: string;
  leIdent: string;
  heIdent: string;
  lengthFt: string;
  widthFt: string;
  surface: string;
  lighted: string;
  closed: string;
  leElevationFt: string;
  heElevationFt: string;
  leHeadingDegt: string;
  heHeadingDegt: string;
  leLatitudeDeg: string;
  leLongitudeDeg: string;
  heLatitudeDeg: string;
  heLongitudeDeg: string;
}

export interface XflyFrequency {
  airportIdent: string;
  /** ATIS / CLD / GND / TWR / APP / DEP / CTR … */
  type: string;
  description: string;
  frequencyMhz: string;
}

export interface XflyGate {
  icao: string;
  gateRef: string;
  gateType: string;
  latitude: number;
  longitude: number;
}

/** 跑道面层代码 → 常见缩写，接口返回的是 AWC 的两位代码。 */
const surfaceCodes: Record<string, string> = {
  ASP: "沥青",
  ASPH: "沥青",
  BIT: "沥青",
  PEM: "沥青",
  CON: "混凝土",
  CONC: "混凝土",
  "CON/G": "混凝土",
  COM: "复合道面",
  GRE: "草地",
  GRS: "草地",
  WATER: "水面",
  SAN: "沙地",
  SAND: "沙地",
  MAC: "碎石",
  LAT: "红土",
};

export function surfaceLabel(code: string) {
  const key = (code ?? "").trim().toUpperCase();
  return surfaceCodes[key] ?? (key || "—");
}

export function searchAirports(text: string) {
  return apiResult<XflyAirport[]>(`${BASE}/api/efb/airports/search/${encodeURIComponent(text.trim())}`);
}

export function getAirport(icao: string) {
  return apiResult<XflyAirport>(`${BASE}/api/efb/airports/${encodeURIComponent(icao.trim().toUpperCase())}`);
}

export function getRunways(icao: string) {
  return apiResult<XflyRunway[]>(`${BASE}/api/efb/runway/${encodeURIComponent(icao.trim().toUpperCase())}`);
}

export function getFrequencies(icao: string) {
  return apiResult<XflyFrequency[]>(`${BASE}/api/efb/frequency/${encodeURIComponent(icao.trim().toUpperCase())}`);
}

export function getGates(icao: string) {
  return apiResult<XflyGate[]>(`${BASE}/api/efb/gates/${encodeURIComponent(icao.trim().toUpperCase())}`);
}

/** XFS 的机位只有两类：`gate` 廊桥/登机口，`parking_position` 远机位。 */
export function gateKindLabel(type: string) {
  if (type === "gate") return "登机口";
  if (type === "parking_position") return "远机位";
  return type || "机位";
}

const gateCollator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/** 编号自然排序，避免 `A10` 被排到 `A9` 前面；接口原始顺序是按入库时间来的。 */
export function sortGates(rows: XflyGate[]) {
  return [...rows].sort((a, b) => gateCollator.compare(a.gateRef ?? "", b.gateRef ?? ""));
}

/* ------------------------------------------------------- 空域边界（FIR） */

/** 接口返回的坐标是 JSON 字符串，层级不固定，这里递归压平成环列表。 */
function flattenRings(raw: unknown): Array<Array<[number, number]>> {
  const rings: Array<Array<[number, number]>> = [];
  const isPoint = (value: unknown): value is [number, number] =>
    Array.isArray(value) && value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number";

  const walk = (node: unknown) => {
    if (Array.isArray(node)) {
      if (node.length > 0 && node.every(isPoint)) {
        if (node.length >= 3) rings.push(node as Array<[number, number]>);
        return;
      }
      node.forEach(walk);
    }
  };
  walk(raw);
  return rings;
}

async function boundary(scope: "firBoundary" | "traconBoundary", icao: string) {
  const data = await apiResult<{ coordinates: string } | null>(
    `${BASE}/api/efb/${scope}/${encodeURIComponent(icao.trim().toUpperCase())}`,
  );
  if (!data?.coordinates) return [];
  try {
    return flattenRings(JSON.parse(data.coordinates));
  } catch {
    return [];
  }
}

export const getFirBoundary = (icao: string) => boundary("firBoundary", icao);
export const getTraconBoundary = (icao: string) => boundary("traconBoundary", icao);

/* ---------------------------------------------------------------- 气象 */

export interface XflyMetar {
  stationId: string;
  rawText: string;
  observationTime: string;
  windDirDegrees: string;
  windSpeedKt: string;
  windGustKt: string;
  visibilityStatuteMi: string;
  tempC: string;
  dewpointC: string;
  altimInHg: string;
  /** JSON 字符串：[{ sky_cover, cloud_base_ft_agl }] */
  skyCondition: string;
  wxString: string;
  qualityControlFlags: string;
}

export interface XflyTafForecastSegment {
  fcst_time_from: string;
  fcst_time_to: string;
  wind_dir_degrees: string;
  wind_speed_kt: string;
  visibility_statute_mi: string;
  wx_string: string;
  sky_condition: Array<{ sky_cover: string; cloud_base_ft_agl: string }>;
}

export interface XflyTaf {
  stationId: string;
  rawText: string;
  issueTime: string;
  validTimeFrom: string;
  validTimeTo: string;
  /** JSON 字符串 */
  forecast: string;
  latitude: number;
  longitude: number;
  elevationM: number;
  remarks: string;
}

export function getMetar(icao: string) {
  return apiResult<XflyMetar>(`${BASE}/api/efb/weather/metar/${encodeURIComponent(icao.trim().toUpperCase())}`);
}

export function getTaf(icao: string) {
  return apiResult<XflyTaf>(`${BASE}/api/efb/weather/taf/${encodeURIComponent(icao.trim().toUpperCase())}`);
}

export function parseXflySky(raw: string) {
  if (!raw) return [] as Array<{ cover: string; baseFt: number | null }>;
  try {
    const rows = JSON.parse(raw) as Array<{ sky_cover: string; cloud_base_ft_agl: string }>;
    return rows.map((row) => ({
      cover: row.sky_cover,
      baseFt: row.cloud_base_ft_agl ? Number(row.cloud_base_ft_agl) : null,
    }));
  } catch {
    return [];
  }
}

export function parseXflyForecast(raw: string): XflyTafForecastSegment[] {
  if (!raw) return [];
  try {
    return JSON.parse(raw) as XflyTafForecastSegment[];
  } catch {
    return [];
  }
}

/* ---------------------------------------------------------------- 航路 */

export function getRouteCycles() {
  return apiResult<string[]>(`${BASE}/api/efb/getRouteCycle`);
}

export interface XflyRouteResult {
  data_version: string;
  route: string;
  /** 接口按公里返回（实测 ZBAA→ZSAM 1824.24 = 航段累加 983.9 NM），换算见 distanceNm */
  distance: number;
  /** 海里，已由 distance 换算 */
  distanceNm: number;
  /** [[ident, lat, lon], ...] */
  nodeinformation: Array<[string, number, number]>;
  total_time?: number;
}

export interface XflyParsedRoute {
  cycle: string;
  route: string;
  warnings: string[];
  waypoints: Array<{ name: string; lat: number; lon: number }>;
}

/** 按起降机场查询建议航路（含节点坐标与距离）。 */
export async function queryRoute(dep: string, arr: string, cycle?: string) {
  const params = new URLSearchParams({ dep: dep.toUpperCase(), arr: arr.toUpperCase() });
  if (cycle) params.set("cycle", cycle);
  const text = await apiText(`${BASE}/api/efb/route?${params.toString()}`, { method: "POST" });
  const payload = JSON.parse(text) as { code: number; data: XflyRouteResult | Record<string, never>; message: string };
  if (payload.code !== 20000) throw new Error(payload.message || `接口业务码 ${payload.code}`);
  const data = payload.data as XflyRouteResult;
  if (!data || !data.route) throw new Error("未找到可用航路");
  return { ...data, distanceNm: data.distance / 1.852 };
}

/** 把手工输入的航路串解析成航点序列。 */
export function parseRoute(route: string, cycle?: string) {
  return apiResult<XflyParsedRoute>(`${BASE}/api/efb/parseRoute`, {
    method: "POST",
    form: { route: route.toUpperCase(), cycle },
  });
}

/** 一条航路（airway）及其航点序列；`type` 为 one-way / both-way。 */
export interface XflyAirway {
  name: string;
  type: string;
  data: Array<{ name: string; lat: number; lon: number }>;
}

/** 航路网络约 6 MB，同一周期只拉一次；进程内缓存，切页不重复下载。 */
const routeNetworkCache = new Map<string, XflyAirway[]>();

/**
 * 指定 AIRAC 周期的**全部航路**（airway + 航点坐标），对应 `GET /api/efb/routes/{cycle}`。
 *
 * 注意它返回的是航路网络（A1/A461…），不是班机航路列表；班机航路来自本地
 * `FLIGHT_AIRLINE.csv`，按起降场查询用 `search_flight_routes`。
 * 这里拿到的数据用于校验手输航路串里的航路/航点是否属于该周期。
 */
export async function getRouteNetwork(cycle: string) {
  const key = cycle.trim();
  if (!key) throw new Error("缺少 AIRAC 周期");
  const cached = routeNetworkCache.get(key);
  if (cached) return cached;
  const list = await apiResult<XflyAirway[]>(`${BASE}/api/efb/routes/${encodeURIComponent(key)}`, {
    timeoutMs: 60_000,
  });
  const airways = Array.isArray(list) ? list : [];
  routeNetworkCache.set(key, airways);
  return airways;
}

/** 航路网络里的全部 token（航路名 + 航点名），转成大写集合便于校验。 */
export function routeNetworkTokens(airways: XflyAirway[]) {
  const tokens = new Set<string>();
  for (const airway of airways) {
    if (airway.name) tokens.add(airway.name.toUpperCase());
    for (const point of airway.data ?? []) {
      if (point?.name) tokens.add(point.name.toUpperCase());
    }
  }
  return tokens;
}

/* ------------------------------------------------------------ 在线用户 */

/**
 * 在线飞行员与管制员。
 * 接口：GET /pilot/api/fsd/list/allOnlineUser
 */
export interface XfsFlightPlan {
  planType: string | null;
  aircraft: string | null;
  tascruise: string | null;
  depAirport: string | null;
  depTime: string | null;
  actDepTime: string | null;
  alt: string | null;
  destAirport: string | null;
  hrsEnroute: string | null;
  minEnroute: string | null;
  hrsFuel: string | null;
  minFuel: string | null;
  altAirport: string | null;
  remarks: string | null;
  route: string | null;
  revision: string | null;
}

export interface XfsPilot {
  cid: string;
  name: string;
  callsign: string;
  logonTime: string;
  rating: number;
  lastUpdated: string;
  latitude: number;
  longitude: number;
  /** 英尺 */
  altitude: number;
  /**
   * FSD 的 PBH 位域整数（不是 0.01 度）。可能缺失。
   * 位域布局与解码见 `decodePbh()`。
   */
  pbh?: number;
  groundSpeed: number;
  transponder: string;
  flightPlan: XfsFlightPlan | null;
  aircraft: {
    equipment?: string;
    airline?: string;
    livery?: string;
    onGround?: boolean;
    gearDown?: boolean;
    engines?: Record<string, { on: boolean }>;
  } | null;
  controller: string | null;
}

export interface XfsController {
  cid: string;
  name: string;
  callsign: string;
  logonTime: string;
  rating: number;
  lastUpdated: string;
  /** 主频率（MHz），部分记录放在 frequency 字段 */
  frequency?: string;
  facility?: number;
  latitude?: number;
  longitude?: number;
  visualRange?: number;
  textAtis?: string[] | null;
  server?: string | null;
}

export interface XfsOnlineSnapshot {
  pilots: XfsPilot[];
  controllers: XfsController[];
}

export async function getOnlineUsers(): Promise<XfsOnlineSnapshot> {
  const data = await apiResult<{ pilots: XfsPilot[] | null; controllers: XfsController[] | null }>(
    `${BASE}/api/fsd/list/allOnlineUser`,
  );
  return { pilots: data?.pilots ?? [], controllers: data?.controllers ?? [] };
}

/**
 * FSD PBH 位域解码（pbh.h）。
 *
 * 32 位整数按下列位域打包，swift / vPilot 与 XFlySim 的 FSD 服务端都遵循这一套：
 *   bit 0       未用
 *   bit 1       onGround
 *   bits 2-11   heading（10 bit，无符号）
 *   bits 12-21  bank（10 bit，有符号）
 *   bits 22-31  pitch（10 bit，有符号）
 *
 * 编码侧（visualpilotdataupdate.cpp）：
 *   pitch = qFloor(pitch * -256 / 90)    // 90° 对应 256
 *   bank  = qFloor(bank  * -512 / 180)   // 180° 对应 512
 *   hdg   = heading * 1024 / 360         // 360° 对应 1024
 * 所以解码时 pitch / bank 要取负还原，heading 直接乘 360/1024。
 *
 * 三个易错点：
 *   1. bit 0 未用，heading 从 bit 2 起——少移一位航向就差 180°；
 *   2. `pbh` 是 32 位有符号数（接口里常见负数），先 `>>> 0` 转无符号再取位；
 *   3. 不能按 `pbh / 100` 之类当角度用，那样出来的值毫无意义。
 *
 * XShare-Client 的 packet.py 用 `heading * 1023 / 360` 且不反转符号，与本文档
 * 有细微差异；接 swift 服务端时以本实现（按协议文档）为准。
 */
export interface PilotAttitude {
  /** 真航向，0–360 度 */
  heading: number;
  /** 坡度，右倾为正，-180–180 度 */
  bank: number;
  /** 俯仰，抬头为正，-90–90 度 */
  pitch: number;
  onGround: boolean;
}

/** 10 bit 二补码 → 有符号整数 */
function signed10(value: number) {
  return value >= 512 ? value - 1024 : value;
}

export function decodePbh(pbh: number): PilotAttitude {
  const bits = pbh >>> 0;
  return {
    heading: (((bits >>> 2) & 0x3ff) * 360) / 1024,
    bank: (-signed10((bits >>> 12) & 0x3ff) * 180) / 512,
    pitch: (-signed10((bits >>> 22) & 0x3ff) * 90) / 256,
    onGround: (bits & 2) !== 0,
  };
}

/** 只取航向；`pbh` 缺失时给 0，避免箭头乱转。 */
export function pilotHeading(pilot: XfsPilot) {
  if (typeof pilot.pbh !== "number" || !Number.isFinite(pilot.pbh)) return 0;
  return decodePbh(pilot.pbh).heading;
}

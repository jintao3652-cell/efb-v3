import { apiText } from "./api";
import type { VatsimPilot } from "./airspace";
import type { TrafficSource } from "../stores/app-store";
import { getRouteCycles, parseRoute } from "./xfly";

/**
 * 点开一架在线航班时的「计划航路 + 历史轨迹」。
 *
 * 两家的取法完全不同：
 *
 * **VATSIM（vataware）**
 *   1. `GET /pilots/{cid}`，带 `Accept: application/json`（不带就回 HTML 页面），
 *      返回该 CID 最近 50 条连线记录；
 *   2. 取最新一条（同呼号优先、`departure_time` 倒序）的 `id`；
 *   3. `GET /flights/{id}/positions` 拿历史轨迹；
 *   4. 在线快照的 flight_plan 没有航路串时，再取 `/flights/{id}/flightplans`，
 *      取 revision 最高的一份。
 *
 * **XFS**
 *   `GET /pilot/api/fsd/flight/{cid}/{logonTime}`，`logonTime` 必须与在线列表里
 *   的字符串**完全一致**（含毫秒，`2026-10-24T16:22:34.548`）；截断到秒会回
 *   `51000 未找到飞行轨迹`。一次返回整趟连线（实测 10 小时 4760 点 / 2.4 MB），
 *   每个点带当时坐标与 flightPlan，航路串取最后一份非空计划。
 *
 * 轨迹点在这里统一成 `TrackPoint`，只用于画线，不参与任何位置推算。
 */

const VATAWARE = "https://vataware.net";
const XFLY_PILOT = "https://api.xflysim.com/pilot";

/** vataware 靠内容协商区分 JSON / HTML，桌面端代理已自带，浏览器端显式声明。 */
const JSON_ACCEPT = { Accept: "application/json" };

async function getJson<T>(url: string, timeoutMs = 30_000): Promise<T> {
  const text = await apiText(url, { headers: JSON_ACCEPT, timeoutMs });
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("接口返回的不是有效 JSON");
  }
}

/* ---------------------------------------------------------------- 类型 */

export interface TrackPoint {
  /** 采样时刻（毫秒）。XFS 的时间戳不带时区，只用于算时长，绝对值不可跨源比较。 */
  time: number;
  latitude: number;
  longitude: number;
  /** 英尺 */
  altitude: number;
  /** 节 */
  speed: number;
}

export interface PilotTrack {
  source: TrafficSource;
  callsign: string;
  cid: number;
  /** 按时间升序，已去掉长时间停放的重复点 */
  points: TrackPoint[];
  /** 压缩前的原始点数，卡片上用来表示数据量级 */
  rawCount: number;
  /** 数据源自带的航路串（在线快照没给时兜底） */
  routeText: string;
  departure: string;
  arrival: string;
  aircraft: string;
  /** 这趟连线在数据源里的标识：vataware flight id / XFS logonTime */
  anchor: string;
  /** 数据来源说明，卡片脚注用 */
  note: string;
}

export interface PilotPlan {
  departure: string;
  arrival: string;
  aircraft: string;
  route: string;
}

export interface PilotTrackRequest {
  source: TrafficSource;
  cid: number;
  callsign: string;
  /** XFS 必填，且必须带毫秒 */
  logonTime: string;
  /** 机组当前坐标，用来在多条连线里挑出「就是这一趟」 */
  latitude?: number;
  longitude?: number;
  plan: PilotPlan | null;
}

interface VatawareFlight {
  id: string;
  callsign?: string;
  state?: number;
  departure_time?: string;
  arrival_time?: string;
  aircraft_type?: { icao?: string } | null;
  departure?: { icao?: string } | null;
  arrival?: { icao?: string } | null;
  /** 该连线最后一次记录的位置 */
  latitude?: number;
  longitude?: number;
  positions_url?: string;
  flightplans_url?: string;
}

interface VatawareProfile {
  pilot?: { cid?: number; name?: string };
  flights?: VatawareFlight[] | null;
}

interface VatawarePosition {
  timestamp?: string;
  altitude?: number;
  speed?: number;
  latitude?: number;
  longitude?: number;
}

interface VatawareFlightPlan {
  revision_id?: number;
  route?: string;
  created_at?: string;
}

interface XfsTrackSample {
  altitude?: number;
  updatedTime?: string;
  groundSpeed?: number;
  latitude?: number;
  longitude?: number;
  flightPlan?: {
    route?: string | null;
    depAirport?: string | null;
    destAirport?: string | null;
    aircraft?: string | null;
  } | null;
}

interface XfsTrackPayload {
  code: number;
  message: string;
  data: {
    flightData?: XfsTrackSample[];
    callsign?: string;
    cid?: string;
    logonTime?: string;
  } | null;
}

/* ---------------------------------------------------------------- 工具 */

function toNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** vataware 的 in-progress 连线 `arrival_time` 是 null，排序时按 0 处理。 */
function toTime(value?: string) {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * 压缩轨迹：同一位置（约 250 m 内）连续重复的采样点只留第一个。
 *
 * XFS 在地面停机时每 8 秒照发一个点，10 小时能堆出几千个重合点；不压掉的话
 * 既浪费 GeoJSON 体积，也会让「已飞距离」全是 0 段。
 */
function compress(points: TrackPoint[], toleranceDeg = 0.0025, limit = 4000) {
  const out: TrackPoint[] = [];
  for (const point of points) {
    const last = out[out.length - 1];
    if (!last || Math.abs(point.latitude - last.latitude) > toleranceDeg || Math.abs(point.longitude - last.longitude) > toleranceDeg) {
      out.push(point);
    }
  }
  const tail = points[points.length - 1];
  if (tail && out[out.length - 1] !== tail) out.push(tail);
  if (out.length <= limit) return out;
  const step = out.length / limit;
  const sampled = Array.from({ length: limit }, (_, index) => out[Math.min(out.length - 1, Math.floor(index * step))]);
  sampled[sampled.length - 1] = out[out.length - 1];
  return sampled;
}

/** 轨迹总距（海里）。点偶发跳变（重连）会把距离拉飞，单段超过 400 NM 的丢掉。 */
function trackDistanceNm(points: TrackPoint[]) {
  const R = 3440.065;
  const toRad = (value: number) => (value * Math.PI) / 180;
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1];
    const b = points[index];
    const dLat = toRad(b.latitude - a.latitude);
    const dLon = toRad(b.longitude - a.longitude);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2;
    const leg = 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
    if (leg <= 400) total += leg;
  }
  return total;
}

export interface TrackStats {
  points: number;
  rawCount: number;
  distanceNm: number;
  minutes: number;
}

/**
 * 轨迹末点到机组当前位置的距离（海里）。
 *
 * vataware 在机组重新连线后要过一会儿才建新的连线记录，这段时间里取到的是
 * 上一趟，末点会离当前位置很远——卡片据此提示，免得把旧航迹当成当前这趟。
 */
export function trackGapNm(track: PilotTrack, latitude: number, longitude: number) {
  const last = track.points[track.points.length - 1];
  if (!last || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return 0;
  return nmBetween(last, { latitude, longitude });
}

/** 卡片的「已飞 XX NM · 时长 H:MM」；点不够时返回 0。 */
export function trackStats(track: PilotTrack | undefined | null): TrackStats | null {
  if (!track || track.points.length < 2) return null;
  const first = track.points[0];
  const last = track.points[track.points.length - 1];
  return {
    points: track.points.length,
    rawCount: track.rawCount,
    distanceNm: trackDistanceNm(track.points),
    minutes: Math.max(0, Math.round((last.time - first.time) / 60_000)),
  };
}

/* ---------------------------------------------------------------- VATSIM */

/** 两点大圆距离（海里）。只用于在候选中挑连线，不参与绘图。 */
function nmBetween(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * 3440.065 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** `2026-10-24T12:40:24+00:00` → `10-24 12:40Z`（脚注用，短且明确是 UTC）。 */
function stampLabel(value?: string) {
  const time = Date.parse(value ?? "");
  if (!Number.isFinite(time)) return "";
  const date = new Date(time);
  return `${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")} ${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}Z`;
}

async function vatawareRoute(flight: VatawareFlight) {
  const url = flight.flightplans_url || `${VATAWARE}/flights/${flight.id}/flightplans`;
  try {
    const payload = await getJson<{ flightplans?: VatawareFlightPlan[] | null }>(url);
    const plans = (payload.flightplans ?? []).filter((plan) => plan?.route);
    if (!plans.length) return "";
    plans.sort((a, b) => (b.revision_id ?? 0) - (a.revision_id ?? 0) || toTime(b.created_at) - toTime(a.created_at));
    return plans[0].route ?? "";
  } catch {
    // 计划接口挂了不影响轨迹，卡片只显示航路为空。
    return "";
  }
}

async function loadVatsimTrack(request: PilotTrackRequest): Promise<PilotTrack> {
  if (!request.cid) throw new Error("该机组没有 CID，查不到连线记录");
  const profile = await getJson<VatawareProfile>(`${VATAWARE}/pilots/${request.cid}`);
  const flights = (profile.flights ?? []).filter((flight) => Boolean(flight?.id));
  if (!flights.length) throw new Error("vataware 里没有该 CID 的连线记录");

  // 一个 CID 会攒下几十条历史连线：先按呼号筛，再按「这条连线最后位置与机组当前位置
  // 的距离」挑最近的那趟。刚上线时 vataware 可能还没建这趟记录，此时会落到上一趟，
  // 脚注写明起飞时刻，别让人把旧航迹当成当前这趟。
  const sameCallsign = flights.filter((flight) => (flight.callsign ?? "").toUpperCase() === request.callsign.toUpperCase());
  const pool = sameCallsign.length ? sameCallsign : flights;
  const byTime = () => [...pool].sort((a, b) => toTime(b.departure_time) - toTime(a.departure_time))[0];
  let flight = byTime();
  if (Number.isFinite(request.latitude) && Number.isFinite(request.longitude) && (request.latitude || request.longitude)) {
    const here = { latitude: request.latitude ?? 0, longitude: request.longitude ?? 0 };
    let best = Number.POSITIVE_INFINITY;
    for (const candidate of pool) {
      const latitude = Number(candidate.latitude);
      const longitude = Number(candidate.longitude);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
      const distance = nmBetween(here, { latitude, longitude });
      if (distance < best) { best = distance; flight = candidate; }
    }
    // 全都在千里之外说明位置对不上（换了节点 / 坐标异常），还是按时间取最新。
    if (best > 400) flight = byTime();
  }

  const positionsUrl = flight.positions_url || `${VATAWARE}/flights/${flight.id}/positions`;
  const payload = await getJson<{ positions?: VatawarePosition[] | null }>(positionsUrl);
  const rows = (payload.positions ?? []).filter(
    (row) => Number.isFinite(Number(row.latitude)) && Number.isFinite(Number(row.longitude)),
  );
  if (!rows.length) throw new Error("这趟连线还没有位置记录");

  const points: TrackPoint[] = rows
    .map((row) => ({
      time: Date.parse(row.timestamp ?? ""),
      latitude: toNumber(row.latitude),
      longitude: toNumber(row.longitude),
      altitude: toNumber(row.altitude),
      speed: toNumber(row.speed),
    }))
    .filter((point, index, list) => Number.isFinite(point.time) && (index === 0 || point.time >= list[index - 1].time));

  const routeText = request.plan?.route?.trim() || (await vatawareRoute(flight));
  return {
    source: "vatsim",
    callsign: flight.callsign || request.callsign,
    cid: request.cid,
    points: compress(points),
    rawCount: points.length,
    routeText,
    departure: flight.departure?.icao ?? request.plan?.departure ?? "",
    arrival: flight.arrival?.icao ?? request.plan?.arrival ?? "",
    aircraft: flight.aircraft_type?.icao ?? request.plan?.aircraft ?? "",
    anchor: flight.id,
    note: `vataware · ${rows.length} 个位置点${stampLabel(flight.departure_time) ? ` · ${stampLabel(flight.departure_time)} 起` : ""}`,
  };
}

/* ---------------------------------------------------------------- XFS */

async function loadXfsTrack(request: PilotTrackRequest): Promise<PilotTrack> {
  if (!request.cid) throw new Error("该机组没有 CID，查不到轨迹");
  const logonTime = request.logonTime?.trim();
  if (!logonTime) throw new Error("在线列表里没有该机组的上线时间，无法定位轨迹");

  // 冒号保留原样：XFS 网关对 %3A 也认，但原样更接近在线列表里的字符串。
  const payload = await getJson<XfsTrackPayload>(
    `${XFLY_PILOT}/api/fsd/flight/${request.cid}/${logonTime}`,
    40_000,
  );
  if (payload.code !== 20000 || !payload.data) {
    // 51000 = 该 logonTime 下没有采样点：刚上线还没积累、或连的是别的节点。
    if (payload.code === 51000) throw new Error("XFS 暂无这趟连线的轨迹（刚上线或已断线重连）");
    throw new Error(payload.message || `接口业务码 ${payload.code}`);
  }

  const samples = payload.data.flightData ?? [];
  const points: TrackPoint[] = samples
    .filter((sample) => Number.isFinite(Number(sample.latitude)) && Number.isFinite(Number(sample.longitude)))
    .map((sample) => ({
      time: Date.parse(sample.updatedTime ?? ""),
      latitude: toNumber(sample.latitude),
      longitude: toNumber(sample.longitude),
      altitude: toNumber(sample.altitude),
      speed: toNumber(sample.groundSpeed),
    }))
    .filter((point) => Number.isFinite(point.time));
  if (!points.length) throw new Error("这趟连线还没有位置记录");

  // 计划会随修订更新，取最后一份非空的最贴近现状。
  let plan: XfsTrackSample["flightPlan"] = null;
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    const candidate = samples[index]?.flightPlan;
    if (candidate?.route) { plan = candidate; break; }
  }

  return {
    source: "xfs",
    callsign: payload.data.callsign || request.callsign,
    cid: request.cid,
    points: compress(points),
    rawCount: points.length,
    routeText: plan?.route?.trim() || request.plan?.route?.trim() || "",
    departure: plan?.depAirport || request.plan?.departure || "",
    arrival: plan?.destAirport || request.plan?.arrival || "",
    aircraft: plan?.aircraft || request.plan?.aircraft || "",
    anchor: logonTime,
    note: `XFS · ${points.length} 个位置点`,
  };
}

/* ---------------------------------------------------------------- 对外 */

export function loadPilotTrack(request: PilotTrackRequest) {
  return request.source === "vatsim" ? loadVatsimTrack(request) : loadXfsTrack(request);
}

/** 机组卡片与地图共用同一份 query，key 一致时只会发一次请求。 */
export function pilotTrackQueryOptions(pilot: VatsimPilot | null, source: TrafficSource) {
  const plan = pilot?.flight_plan;
  return {
    queryKey: ["pilot-track", source, pilot?.cid ?? 0, pilot?.logon_time ?? ""] as const,
    queryFn: () => {
      if (!pilot) throw new Error("未选择机组");
      return loadPilotTrack({
        source,
        cid: pilot.cid,
        callsign: pilot.callsign,
        logonTime: pilot.logon_time,
        latitude: pilot.latitude,
        longitude: pilot.longitude,
        plan: plan ? {
          departure: plan.departure ?? "",
          arrival: plan.arrival ?? "",
          aircraft: plan.aircraft_short || plan.aircraft || "",
          route: plan.route ?? "",
        } : null,
      });
    },
    staleTime: 5 * 60_000,
    retry: 0,
    enabled: Boolean(pilot && pilot.cid > 0),
  };
}

/* ------------------------------------------------------------ 航路解析 */

export interface PilotRoutePoint {
  ident: string;
  latitude: number;
  longitude: number;
}

export interface PilotRoute {
  cycle: string;
  points: PilotRoutePoint[];
  warnings: string[];
}

/**
 * `parseRoute` 只认航点 / 航路名，遇到 `INPUD2N/26R`、`GUNPA/M085F380` 这种
 * 带后缀的 token 会错位（实测会把后面的航段全判成 DCT），所以先按 `/` 截断。
 */
function routeTokens(routeText: string) {
  return routeText
    .toUpperCase()
    .replace(/[()[\]{}]/g, " ")
    .split(/[\s,]+/)
    .map((token) => token.split("/")[0].trim())
    .filter((token) => Boolean(token))
    .filter((token) => !["DCT", "IFR", "VFR", "TOC", "TOD", "UNKN"].includes(token))
    .filter((token) => !/^\d+$/.test(token))
    // 高度层 / 速度组：M085F380、K0854S1190 这类不是航点，交给解析器会错位。
    .filter((token) => !/^[KM]\d{3,4}[FS]\d{3,4}$/.test(token));
}

function signed(value: number, hemisphere: string) {
  return hemisphere === "S" || hemisphere === "W" ? -value : value;
}

/**
 * 北大西洋航路里的经纬度点：`64N010W` / `6530N02000W`。
 * `5820N` 这种只有纬度的沿航迹点算不出去向，交给解析器忽略。
 */
function coordinatePoint(token: string): PilotRoutePoint | null {
  const compact = /^(\d{2})(\d{2})([NS])(\d{3})(\d{2})([EW])$/.exec(token);
  if (compact) {
    return {
      ident: token,
      latitude: signed(Number(compact[1]) + Number(compact[2]) / 60, compact[3]),
      longitude: signed(Number(compact[4]) + Number(compact[5]) / 60, compact[6]),
    };
  }
  const short = /^(\d{2})([NS])(\d{3})([EW])$/.exec(token);
  if (short) {
    return {
      ident: token,
      latitude: signed(Number(short[1]), short[2]),
      longitude: signed(Number(short[3]), short[4]),
    };
  }
  const mixed = /^(\d{2})(\d{2})([NS])(\d{3})([EW])$/.exec(token);
  if (mixed) {
    return {
      ident: token,
      latitude: signed(Number(mixed[1]) + Number(mixed[2]) / 60, mixed[3]),
      longitude: signed(Number(mixed[4]), mixed[5]),
    };
  }
  return null;
}

let cycleCache: { at: number; cycle: string } | null = null;

/** 航路周期（`2610`）。解析接口必须带，半年内不会再变，缓存 6 小时。 */
async function currentCycle() {
  if (cycleCache && Date.now() - cycleCache.at < 6 * 60 * 60_000) return cycleCache.cycle;
  const list = await getRouteCycles();
  const cycle = list?.[0] ?? "";
  if (cycle) cycleCache = { at: Date.now(), cycle };
  return cycle;
}

/**
 * 把计划航路串解析成航点坐标。
 *
 * 服务端 `POST /api/efb/parseRoute` 会补齐航路中间的节点，但认不出
 * `6530N02000W` 这类经纬度写法；本地先算出这几个点，再按 token 顺序把两边
 * 的结果合并，保证不出现「跨大西洋被拉成一条直线」。
 */
export async function parsePilotRoute(routeText: string): Promise<PilotRoute> {
  const tokens = routeTokens(routeText);
  if (!tokens.length) return { cycle: "", points: [], warnings: [] };

  // 解析接口必须带周期；周期接口挂了就直接把原因写进 warnings，别让卡片停在「解析中」。
  let cycle = "";
  try {
    cycle = await currentCycle();
  } catch (error) {
    return { cycle: "", points: [], warnings: [`航路周期获取失败：${(error as Error).message || "接口不可用"}`] };
  }

  let resolved: PilotRoutePoint[] = [];
  let warnings: string[] = [];
  try {
    const parsed = await parseRoute(tokens.join(" "), cycle || undefined);
    resolved = (parsed.waypoints ?? [])
      .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lon))
      .map((point) => ({ ident: String(point.name ?? "").toUpperCase(), latitude: point.lat, longitude: point.lon }));
    warnings = parsed.warnings ?? [];
  } catch (error) {
    warnings = [`航路解析失败：${(error as Error).message || "接口不可用"}`];
  }

  const points: PilotRoutePoint[] = [];
  const push = (point: PilotRoutePoint) => {
    const last = points[points.length - 1];
    if (last && last.ident === point.ident) return;
    points.push(point);
  };

  let cursor = 0;
  for (const token of tokens) {
    const local = coordinatePoint(token);
    if (local) { push(local); continue; }
    let index = -1;
    for (let scan = cursor; scan < resolved.length; scan += 1) {
      if (resolved[scan].ident === token) { index = scan; break; }
    }
    if (index < 0) continue;
    for (let scan = cursor; scan <= index; scan += 1) push(resolved[scan]);
    cursor = index + 1;
  }
  for (let scan = cursor; scan < resolved.length; scan += 1) push(resolved[scan]);

  return { cycle, points, warnings };
}

export function pilotRouteQueryOptions(routeText: string) {
  const text = routeText.trim();
  return {
    queryKey: ["pilot-route", text] as const,
    queryFn: () => parsePilotRoute(text),
    staleTime: 6 * 60 * 60_000,
    retry: 0,
    enabled: text.length > 0,
  };
}

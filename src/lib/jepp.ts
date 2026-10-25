/**
 * JeppQuery 终端航图服务客户端。
 *
 * 服务是本机 / 内网部署的 Jeppesen 只读出口，经 nginx 反代并强制校验 `?token=`。
 *
 * 端点（全部以 `/api/v1` 开头）：
 *   GET /airports/{icao}                      机场总览（J3N 导航库 + Airports.dbf 合并）
 *   GET /airports?search=                     机场子串检索
 *   GET /charts/{icao}[?geo=1]                航图平铺目录
 *   GET /charts/{icao}/all                    按分类分组的目录
 *   GET /charts/{icao}/export/{filename}      取单张航图（application/pdf）
 *   GET /charts/{icao}/geo/bounds/{filename}  航图地理覆盖范围
 *   GET /sidstar/{icao}                       SID / STAR 程序目录与路径点
 *   GET /runways/{icao} · /ils/{icao}         跑道 / ILS（旧端点，保留兜底）
 *   GET /health                               各依赖可用性（不在 /api/v1 下）
 *
 * **服务地址与令牌都不在本文件**：桌面端由 Rust 的 `jepp_get` / `jepp_chart_pdf`
 * 补上（`src-tauri/src/commands/jepp.rs`），浏览器端由 Vite 的 `/jepp` 反代补上。
 * 前端只认路径，所以 JS 产物里既没有域名也没有令牌；换服务只能重新发包。
 */

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { isTauri } from "./tauri";

/** `/api/v1` 前缀；真正的域名由传输层拼。 */
const API = "/api/v1";

export type JeppCategory = "AIRPORT" | "DEPARTURE" | "ARRIVAL" | "APPROACH" | "AIRSPACE" | string;

export interface JeppGeoCoverage {
  lat_min: number;
  lat_max: number;
  lon_min: number;
  lon_max: number;
  /** GeoJSON 顺序：[西, 南, 东, 北] */
  bbox: [number, number, number, number];
}

export interface JeppGeoBounds {
  filename: string;
  georeferenced: boolean;
  page_pixels?: { left: number; top: number; right: number; bottom: number; width: number; height: number };
  /** 真正能换算经纬度的子矩形（整页含标题块、页边，不能直接用）。 */
  coverage_pixels?: { left: number; top: number; right: number; bottom: number; width: number; height: number };
  coverage?: JeppGeoCoverage;
  cached?: boolean;
  error?: string;
}

export interface JeppChart {
  filename: string;
  icao: string;
  chart_type: string;
  type_name: string;
  category: JeppCategory;
  index_no: string;
  proc_id: string;
  date_eff: string;
  date_rev: string;
  sheet_id: string;
  trim_size: string;
  is_georeferenced: boolean;
  precision_approach: boolean;
  has_tcl: boolean;
  is_vfr: boolean;
  /** 需要 `?geo=1`；只读缓存，未预热时为 null。 */
  geo_bounds?: JeppGeoBounds | null;
  /**
   * 该图适用的跑道。服务版本差异：2610 起是字符串数组 `["18L","18R"]`，
   * 2621 起是单个字符串 `"18L, 18R"`。统一走 `chartRunways()` 取用。
   */
  runways?: string | string[];
  /** 2621：取值依据（`title` / `chart`）；2610：直接是人读的跑道列表。 */
  runways_note?: string;
  runways_source?: string;
  /** 2610：`by_atc`；2621：`byAtc`。`BY ATC` 字样（管制放行图）。 */
  by_atc?: boolean;
  byAtc?: boolean;
  /** 进近图的 ILS 频率文本。 */
  ilsText?: string;
}

export interface JeppChartIndex {
  icao: string;
  total: number;
  charts: JeppChart[];
}

export interface JeppChartGroup {
  category: JeppCategory;
  count: number;
  charts: JeppChart[];
}

export interface JeppChartGroups {
  icao: string;
  total: number;
  categories: JeppChartGroup[];
}

export interface JeppRunway {
  ident: string;
  length_ft: number;
  length_m: number;
  width_ft: number;
  width_m: number;
  true_heading: number;
  magnetic_heading: number;
  magnetic_variation: number;
  latitude: number;
  longitude: number;
  surface_code: number;
  elevation_ft: number;
  airport_ident: string;
}

export interface JeppIls {
  ident: string;
  frequency_mhz: number;
  true_course: number;
  magnetic_course: number;
  glide_slope: number;
  magnetic_variation: number;
  latitude: number;
  longitude: number;
  runway: string;
  airport_ident: string;
}

/** AirportComm.J3N 的类型码已由服务端翻成中文：ATIS / 塔台 / 地面 / 放行 / 进近离场 / 机坪 / UNICOM。 */
export interface JeppComm {
  type_code: number;
  type: string;
  frequency_mhz: number;
}

export interface JeppCycle {
  effective: string;
  expiration: string;
  datacycle: string;
  datacycleyear?: string;
  version?: string;
}

export interface JeppAirportOverview {
  icao: string;
  iata: string;
  name: string;
  city: string;
  country: string;
  region: string;
  latitude: number;
  longitude: number;
  /**
   * 全场跑道入口标高的**最高值**（J3N 只有跑道级标高，没有单独的 ARP 标高）。
   * 想要 ARP 标高看 `Airports.dbf` 合并进来的 `site_elevation_ft`（若存在）。
   */
  elevation_ft: number;
  runways: JeppRunway[];
  comms: JeppComm[];
  ils: JeppIls[];
  cycle: JeppCycle | null;
  /** 以下字段来自 Airports.dbf，导航库缺项时才有。 */
  ident?: string;
  state?: string;
  state_name?: string;
  country_name?: string;
  runway_ft?: number;
  magnetic_variation?: string;
  utc_offset?: string;
  precision_approach?: boolean;
  chart_index?: number;
}

export interface JeppNotam {
  icao: string;
  country: string;
  country_name: string;
  region: string;
  notam_type: string;
  /** 截断预览，完整正文在源 notams.dbt。 */
  text: string;
  temporary: boolean;
  until_further_notice: boolean;
  when_in_effect: boolean;
  effective_date: string;
  effective_fixed: boolean;
  end_date: string;
  end_fixed: boolean;
  index_no: string;
}

export interface JeppAirportRecord {
  ident: string;
  iata: string;
  name: string;
  city: string;
  state: string;
  state_name: string;
  country: string;
  country_name: string;
  region: string;
  latitude: number;
  longitude: number;
  elevation_ft: number;
  runway_ft: number;
  magnetic_variation: string;
  utc_offset: string;
  precision_approach: boolean;
  chart_index: number;
}

export interface JeppProcedurePathPoint {
  ident: string | null;
  latitude: number | null;
  longitude: number | null;
  kind: "TERM" | "ENRT" | string | null;
}

export interface JeppProcedure {
  name: string;
  runway: string;
  points: number;
  path: JeppProcedurePathPoint[];
}

export interface JeppSidStar {
  icao: string;
  sid: JeppProcedure[];
  star: JeppProcedure[];
}

export interface JeppHealthCheck {
  ok: boolean;
  [key: string]: unknown;
}

export interface JeppHealth {
  status: "ok" | "degraded" | string;
  ready: boolean;
  essential: string[];
  checks: Record<string, JeppHealthCheck>;
}

export const jeppCategoryLabels: Record<string, string> = {
  AIRPORT: "机场",
  DEPARTURE: "离场",
  ARRIVAL: "进场",
  APPROACH: "进近",
  AIRSPACE: "空域",
};

/** 服务端错误，带 HTTP 状态以便区分 token / 渲染 / 背压。 */
export class JeppError extends Error {
  status: number;
  retryable: boolean;

  constructor(message: string, status: number, retryable = false) {
    super(message);
    this.name = "JeppError";
    this.status = status;
    this.retryable = retryable;
  }
}

function statusMessage(status: number, detail: string) {
  if (status === 401 || status === 403) return "航图服务令牌校验失败";
  if (status === 404) return "服务上没有该资源";
  if (status === 502) return "航图渲染失败：缺少 tcl2emf.exe 或 Jeppesen 字体";
  if (status === 503) return "渲染队列已满，稍后重试";
  return detail || `航图服务返回 ${status}`;
}

interface JeppRawResponse {
  status: number;
  contentType: string;
  body: string;
}

/**
 * 传输层：桌面端经 Rust 走 `jepp_get`（地址与令牌在 Rust 侧拼好），
 * 浏览器端经 Vite 的 `/jepp` 反代（令牌由反代追加）。
 */
/** IPC 被 ACL 拒绝（页面来源不是 localhost）时的报错特征。 */
function isAclRejection(message: string) {
  return /not allowed|Plugin not found|not found by ACL|不在允许列表/.test(message);
}

async function request(path: string): Promise<JeppRawResponse> {
  if (isTauri()) {
    try {
      return await invoke<JeppRawResponse>("jepp_get", { path });
    } catch (error) {
      const message = typeof error === "string" ? error : error instanceof Error ? error.message : "";
      // 来源不匹配时 IPC 会被拒；开发服务器还开着 /jepp 反代，退一步走 HTTP。
      if (!isAclRejection(message)) throw error;
      console.warn("[jepp] 桌面端拒绝了 IPC 调用，改走 /jepp 反代：", message);
    }
  }
  const response = await fetch(`/jepp${path}`, { headers: { Accept: "application/json" } });
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    body: await response.text(),
  };
}

/** Rust 侧的错误是纯字符串，浏览器侧是 Error/TypeError，统一收成 JeppError。 */
function toJeppError(error: unknown): JeppError {
  if (error instanceof JeppError) return error;
  const message =
    typeof error === "string" ? error : error instanceof Error ? error.message : "";
  if (isAclRejection(message)) {
    return new JeppError("桌面端拒绝了航图请求：当前页面来源不在允许列表内（请用 localhost 打开，别用 127.0.0.1 或局域网 IP）", 0);
  }
  if (/timeout|超时/i.test(message)) return new JeppError("航图服务响应超时", 0);
  if (/failed to fetch|networkerror/i.test(message)) return new JeppError("无法连接航图服务，请检查网络", 0);
  return new JeppError(message || "无法连接航图服务", 0);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new JeppError("航图服务响应超时", 0)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(toJeppError(error)); },
    );
  });
}

async function getJson<T>(path: string, timeoutMs = 20_000): Promise<T> {
  const response = await withTimeout(request(path), timeoutMs);
  if (response.status < 200 || response.status >= 300) {
    let detail = "";
    let retryable = response.status === 503;
    try {
      const body = JSON.parse(response.body) as { error?: string; retryable?: boolean };
      detail = body.error ?? "";
      retryable = retryable || body.retryable === true;
    } catch {
      // 非 JSON 错误体（如 nginx 的 forbidden 纯文本）
    }
    throw new JeppError(statusMessage(response.status, detail), response.status, retryable);
  }
  try {
    return JSON.parse(response.body) as T;
  } catch {
    throw new JeppError("航图服务返回的不是有效 JSON", response.status);
  }
}

/** 机场总览：一次拿到跑道、全部通讯频率、ILS 与数据周期。未知机场返回 null。 */
export async function jeppAirportOverview(icao: string) {
  const code = encodeURIComponent(icao.trim().toUpperCase());
  try {
    return await getJson<JeppAirportOverview>(`${API}/airports/${code}`, 25_000);
  } catch (error) {
    if (error instanceof JeppError && error.status === 404) return null;
    throw error;
  }
}

/**
 * `geo = true` 时为每张图附上已缓存的地理覆盖范围（服务端默认就开，不触发引擎探测）。
 * 要关掉必须显式传 `?geo=0`——不带参数等于开启。
 */
export function jeppCharts(icao: string, geo = true) {
  const code = encodeURIComponent(icao.trim().toUpperCase());
  return getJson<JeppChartIndex>(`${API}/charts/${code}?geo=${geo ? 1 : 0}`, 30_000);
}

/** 按分类分组，顺序与查看器一致。 */
export function jeppChartsGrouped(icao: string) {
  const code = encodeURIComponent(icao.trim().toUpperCase());
  return getJson<JeppChartGroups>(`${API}/charts/${code}/all`, 30_000);
}

/** geo/bounds 结果缓存：同一张图的配准不变，重复选图 / 切主题不该再等一次 HTTP。 */
const geoBoundsCache = new Map<string, Promise<JeppGeoBounds>>();

export function jeppGeoBounds(icao: string, filename: string, refresh = false) {
  const code = encodeURIComponent(icao.trim().toUpperCase());
  if (!refresh) {
    const key = `${code}/${filename}`;
    const hit = geoBoundsCache.get(key);
    if (hit) return hit;
    const task = getJson<JeppGeoBounds>(
      `${API}/charts/${code}/geo/bounds/${encodeURIComponent(filename)}`,
      40_000,
    );
    geoBoundsCache.set(key, task);
    void task.catch(() => {
      if (geoBoundsCache.get(key) === task) geoBoundsCache.delete(key);
    });
    if (geoBoundsCache.size > 80) {
      const oldest = geoBoundsCache.keys().next().value;
      if (oldest && oldest !== key) geoBoundsCache.delete(oldest);
    }
    return task;
  }
  return getJson<JeppGeoBounds>(
    `${API}/charts/${code}/geo/bounds/${encodeURIComponent(filename)}?refresh=1`,
    40_000,
  );
}

export function jeppSidStar(icao: string) {
  const code = encodeURIComponent(icao.trim().toUpperCase());
  return getJson<JeppSidStar>(`${API}/sidstar/${code}`, 30_000);
}

export function jeppHealth() {
  return getJson<JeppHealth>("/health", 12_000);
}

/** 只要通讯频率时用它；与机场总览的 `comms` 同源。无频率记录的机场返回 404。 */
export async function jeppComms(icao: string) {
  const code = encodeURIComponent(icao.trim().toUpperCase());
  try {
    return await getJson<{ icao: string; total: number; comms: JeppComm[] }>(`${API}/comms/${code}`);
  } catch (error) {
    if (error instanceof JeppError && error.status === 404) return { icao: icao.toUpperCase(), total: 0, comms: [] as JeppComm[] };
    throw error;
  }
}

/** 机场 NOTAM；不存在的机场返回空列表。`limit` 仅对按国家查询生效。 */
export async function jeppNotams(icao: string) {
  const code = encodeURIComponent(icao.trim().toUpperCase());
  try {
    return await getJson<{ icao: string; total: number; notams: JeppNotam[] }>(
      `${API}/notams?icao=${code}`,
      20_000,
    );
  } catch (error) {
    if (error instanceof JeppError && error.status === 404) return { icao: icao.toUpperCase(), total: 0, notams: [] as JeppNotam[] };
    throw error;
  }
}

/** 全部航图类型字典（97 条），把 `chart_type` 码翻成名称与分类。 */
export function jeppChartTypes() {
  return getJson<{ types: { code: string; name: string; category: JeppCategory; precision?: string }[] }>(
    `${API}/chart-types`,
  );
}

export function jeppRunways(icao: string) {
  const code = encodeURIComponent(icao.trim().toUpperCase());
  return getJson<{ icao: string; total: number; runways: JeppRunway[] }>(`${API}/runways/${code}`);
}

export function jeppIls(icao: string) {
  const code = encodeURIComponent(icao.trim().toUpperCase());
  return getJson<{ icao: string; total: number; ils: JeppIls[] }>(`${API}/ils/${code}`);
}

export function jeppAirports(search: string, limit?: number) {
  const suffix = limit ? `&limit=${limit}` : "";
  return getJson<{ query: string; total: number; airports: JeppAirportRecord[] }>(
    `${API}/airports?search=${encodeURIComponent(search)}${suffix}`,
  );
}

/**
 * 该图适用跑道的人读文本。
 * 2610 返回 `runways: ["18L","18R"]` + `runways_note: "18L/R, 19"`；
 * 2621 返回 `runways: "18L, 18R"` + `runways_note: "title"`（取值依据，不是跑道）。
 */
export function chartRunways(chart: JeppChart): string {
  const value = chart.runways;
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "string" && value.trim()) return value.trim();
  const note = chart.runways_note?.trim() ?? "";
  return /^(title|chart)$/i.test(note) ? "" : note;
}

/**
 * 单张航图的 PDF 地址：`filename` 是 DBF 文件名（不透明哈希），不是图号。
 *
 * 桌面端由 Rust 取回并缓存成 `<本地数据目录>/jepp-chart-cache/*.pdf`，返回
 * `asset:` 地址；浏览器端经 `/jepp` 反代取回 PDF 再转 blob 地址。两条路都不
 * 经过 WebView 的直连（也就没有地址与令牌泄露）。
 *
 * 用完记得调 `releaseChartFile(url)`。
 */
export async function jeppChartFile(icao: string, filename: string): Promise<string> {
  const code = icao.trim().toUpperCase();
  if (isTauri()) {
    try {
      const path = await withTimeout(
        invoke<string>("jepp_chart_pdf", { icao: code, filename }),
        90_000,
      );
      return convertFileSrc(path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isAclRejection(message)) throw error;
      console.warn("[jepp] 桌面端拒绝了取图请求，改走 /jepp 反代：", message);
    }
  }
  const response = await withTimeout(
    fetch(`/jepp${API}/charts/${encodeURIComponent(code)}/export/${encodeURIComponent(filename)}`),
    90_000,
  );
  if (!response.ok) throw new JeppError(statusMessage(response.status, ""), response.status);
  return URL.createObjectURL(await response.blob());
}

/** 释放 blob: 地址；`asset:` 指向磁盘缓存，无需（也不能）释放。 */
export function releaseChartFile(url: string) {
  if (url.startsWith("blob:")) URL.revokeObjectURL(url);
}

/** 进行中的预热任务，避免同一张图重复下载。 */
const chartPrefetch = new Map<string, Promise<void>>();

/**
 * 悬停预热单张航图：用户扫过列表时就偷偷把 PDF 拉到本地，
 * 真正点开时桌面端命中 Rust 磁盘缓存（毫秒级）、浏览器端命中预热好的 blob。
 * 预热失败静默——点选时再走正式通道报错。
 */
export function prefetchChartFile(icao: string, filename: string): void {
  const code = icao.trim().toUpperCase();
  if (!code || code.length !== 4 || !filename) return;
  const key = `${code}/${filename}`;
  if (chartPrefetch.has(key)) return;
  const task = (async () => {
    if (isTauri()) {
      try {
        await invoke<string>("jepp_chart_pdf", { icao: code, filename });
      } catch {
        /* 预热失败不影响点选 */
      }
      return;
    }
    try {
      const response = await fetch(
        `/jepp${API}/charts/${encodeURIComponent(code)}/export/${encodeURIComponent(filename)}`,
      );
      if (!response.ok) return;
      const url = URL.createObjectURL(await response.blob());
      // 悬停不一定变成点选，2 分钟后没人用就释放。
      window.setTimeout(() => URL.revokeObjectURL(url), 120_000);
    } catch {
      /* 忽略 */
    }
  })();
  chartPrefetch.set(key, task);
  void task.finally(() => chartPrefetch.delete(key));
}

/** 去重后的通讯频率，按类型聚合，类型顺序固定。 */
export function groupComms(comms: JeppComm[]) {
  const order = ["ATIS", "放行", "地面", "塔台", "进近/离场", "机坪", "UNICOM"];
  const buckets = new Map<string, number[]>();
  for (const row of comms) {
    const key = row.type || "其他";
    const list = buckets.get(key) ?? [];
    if (!list.includes(row.frequency_mhz)) list.push(row.frequency_mhz);
    buckets.set(key, list);
  }
  return [...buckets.entries()]
    .map(([type, values]) => ({ type, values: values.sort((a, b) => a - b) }))
    .sort((a, b) => {
      const left = order.indexOf(a.type);
      const right = order.indexOf(b.type);
      return (left === -1 ? order.length : left) - (right === -1 ? order.length : right) || a.type.localeCompare(b.type);
    });
}

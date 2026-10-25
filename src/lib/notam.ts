import { apiText } from "./api";

/**
 * ATIS View 的 NOTAM 接口。
 *
 * `GET https://atisview.com/api/v1/notams?icao={icao}&limit=n`
 * - 站点前置 Cloudflare，带 `x-atisview-crawler-guard`：非浏览器 UA 直接 403
 *   （`Request blocked.`），因此桌面端也要用浏览器 UA（见 `proxy.rs`）。
 * - 响应不带 `Access-Control-Allow-Origin`，浏览器必须经反代（`/natis`）。
 * - 返回体是 `{ success, meta, notams: [...] }`，`meta.active_only` 恒为 true，
 *   即已过滤掉过期与取消的记录；每条仍带 `validity_state` / `is_effective_now`
 *   用来区分「现在生效」与「按时段生效但当前不在窗口内」。
 */
const ATISVIEW_ORIGIN = "https://atisview.com";

/** 接口里 Q 行与时限的原始字段，尽量原样保留，避免二次解释丢信息。 */
export interface NotamRecord {
  id: number;
  /** 数据来源，如 `jp-swim` / `icao-api` / `kr-koca-intl`。 */
  source: string;
  kind: string;
  /** 完整编号，如 `E4178/26`。 */
  number: string;
  series: string | null;
  /** `N` 新建 / `R` 替换 / `C` 取消。 */
  type: string | null;
  fir: string | null;
  location: string;
  affectedLocations: string;
  qCode: string | null;
  traffic: string | null;
  purpose: string | null;
  scope: string | null;
  lowerLimit: string | null;
  upperLimit: string | null;
  coordinates: string | null;
  radiusNm: string | null;
  /** `YYYY-MM-DD HH:mm:ss`（UTC）。 */
  validFromUtc: string;
  validUntilUtc: string | null;
  /** D) 时段，如 `1500-2300 DLY`。 */
  schedule: string | null;
  isEstimatedEnd: boolean;
  isCancelled: boolean;
  /** `active` / `schedule_unknown` / `pending` / `expired` … */
  validityState: string;
  isEffectiveNow: boolean;
  nextWindowStartUtc: string | null;
  /** E) 项正文（已去掉 Q/A/B/C/D 行与首尾括号）。 */
  text: string;
  /** 原始电报，用于 `E)` 缺失时兜底。 */
  raw: string;
}

export interface NotamFeed {
  icao: string;
  total: number;
  notams: NotamRecord[];
}

interface RawNotam extends Partial<NotamRecord> {
  display_text?: string;
  raw_text?: string;
  valid_from_utc?: string;
  valid_until_utc?: string;
  is_estimated_end?: boolean;
  is_cancelled?: boolean;
  is_effective_now?: boolean;
  validity_state?: string;
  next_window_start_utc?: string | null;
  q_code?: string;
  lower_limit?: string;
  upper_limit?: string;
  radius_nm?: string;
  affected_locations?: string;
}

/** 从电报正文中取 E) 项；没有 E) 时退回整段可读文本。 */
function extractBody(text: string) {
  const match = /(?:^|\n|\s)E\)\s*([\s\S]*?)(?=(?:\s+[A-G]\)\s)|\n\)?\s*$)/.exec(text);
  if (match?.[1]) {
    return match[1].replace(/\s*\n\s*/g, " ").replace(/\s+/g, " ").trim();
  }
  return text.replace(/\s+/g, " ").trim();
}

function toRecord(row: RawNotam): NotamRecord {
  const raw = (row.raw_text || row.display_text || "").trim();
  return {
    id: row.id ?? 0,
    source: row.source ?? "",
    kind: row.kind ?? "NOTAM",
    number: row.number ?? "",
    series: row.series ?? null,
    type: row.type ?? null,
    fir: row.fir ?? null,
    location: row.location ?? "",
    affectedLocations: row.affected_locations ?? "",
    qCode: row.q_code ?? null,
    traffic: row.traffic ?? null,
    purpose: row.purpose ?? null,
    scope: row.scope ?? null,
    lowerLimit: row.lower_limit ?? null,
    upperLimit: row.upper_limit ?? null,
    coordinates: row.coordinates ?? null,
    radiusNm: row.radius_nm ?? null,
    validFromUtc: row.valid_from_utc ?? "",
    validUntilUtc: row.valid_until_utc ?? null,
    schedule: row.schedule ?? null,
    isEstimatedEnd: Boolean(row.is_estimated_end),
    isCancelled: Boolean(row.is_cancelled),
    validityState: row.validity_state ?? "",
    isEffectiveNow: Boolean(row.is_effective_now),
    nextWindowStartUtc: row.next_window_start_utc ?? null,
    text: raw ? extractBody(raw) : "",
    raw,
  };
}

interface RawFeed {
  success?: boolean;
  message?: string;
  notams?: RawNotam[];
}

/** 机场当前有效 NOTAM；机场不存在或无通告时返回空列表。 */
export async function fetchNotams(icao: string, limit = 10): Promise<NotamFeed> {
  const code = icao.trim().toUpperCase();
  const url = `${ATISVIEW_ORIGIN}/api/v1/notams?icao=${encodeURIComponent(code)}&limit=${limit}`;

  let text: string;
  try {
    text = await apiText(url, { timeoutMs: 20_000 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("403")) throw new Error("NOTAM 服务拒绝了请求（爬虫拦截或来源受限），请稍后重试");
    if (message.includes("429")) throw new Error("NOTAM 服务限流，请稍后重试");
    throw error;
  }

  let payload: RawFeed;
  try {
    payload = JSON.parse(text) as RawFeed;
  } catch {
    throw new Error("NOTAM 服务返回的不是有效 JSON");
  }
  if (payload.success === false) throw new Error(payload.message || "NOTAM 服务拒绝了请求");

  const rows = (payload.notams ?? []).map(toRecord).filter((row) => row.number || row.text);
  return { icao: code, total: rows.length, notams: rows };
}

/** `2026-10-23 15:00:00` → `10-23 15:00Z`。 */
export function shortUtc(value: string | null | undefined) {
  if (!value) return "—";
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(value);
  if (!match) return value;
  return `${match[2]}-${match[3]} ${match[4]}:${match[5]}Z`;
}

/** 状态文案：区分「当前生效」「按时段生效」「已取消」。 */
export function notamStateLabel(row: NotamRecord) {
  if (row.isCancelled || row.validityState === "cancelled") return "已取消";
  if (row.isEffectiveNow) return "生效中";
  if (row.schedule) return "时段生效";
  if (row.validityState === "schedule_unknown") return "时段未知";
  if (row.validityState === "pending") return "未开始";
  return "";
}

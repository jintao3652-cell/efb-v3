import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./tauri";

/**
 * 统一的外部接口通道。
 *
 * - 桌面端：走 Rust 侧 `api_proxy`，不受 WebView 同源策略约束，也不带 Origin 头
 *   （XFlySim 的接口见到 Origin 会直接 403）。
 * - 浏览器：走 Vite 的 `/xapi` 反代（dev 与 preview 都配了），效果等价。
 */
const XFLY_ORIGIN = "https://api.xflysim.com";
const ATISVIEW_ORIGIN = "https://atisview.com";
const AWC_ORIGIN = "https://aviationweather.gov";
const VATAWARE_ORIGIN = "https://vataware.net";

/** 浏览器环境下把绝对地址折叠成同源反代路径。 */
function toBrowserUrl(url: string) {
  if (url.startsWith(XFLY_ORIGIN)) return `/xapi${url.slice(XFLY_ORIGIN.length)}`;
  // vataware 的内容协商靠 Accept 头，浏览器直连没有 CORS 头，只能走反代。
  if (url.startsWith(VATAWARE_ORIGIN)) return `/vata${url.slice(VATAWARE_ORIGIN.length)}`;
  // ATIS View 不带 CORS 头，且 Cloudflare 的 crawler guard 只放行浏览器 UA，
  // 所以只能经 Vite 反代（转发的是浏览器自己的 UA）。
  if (url.startsWith(ATISVIEW_ORIGIN)) return `/natis${url.slice(ATISVIEW_ORIGIN.length)}`;
  // aviationweather.gov 不带 CORS 头，公开气象源的 TAF 也要走反代。
  if (url.startsWith(AWC_ORIGIN)) return `/awc${url.slice(AWC_ORIGIN.length)}`;
  return url;
}

interface ApiInit {
  method?: "GET" | "POST";
  /** 表单体（application/x-www-form-urlencoded） */
  form?: Record<string, string | number | undefined | null>;
  /** JSON 体 */
  json?: unknown;
  /** 额外请求头（浏览器模式生效；桌面端由 Rust 代理统一带 Accept） */
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface ProxyResponse {
  status: number;
  contentType: string;
  body: string;
}

function encodeForm(form: Record<string, string | number | undefined | null>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(form)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  return params.toString();
}

/** 返回原始响应文本；非 2xx 时抛出带状态码的错误。 */
export async function apiText(url: string, init: ApiInit = {}): Promise<string> {
  const method = init.method ?? "GET";
  const body = init.json !== undefined ? JSON.stringify(init.json) : init.form ? encodeForm(init.form) : undefined;
  const contentType = init.json !== undefined ? "application/json" : "application/x-www-form-urlencoded";

  if (isTauri()) {
    const response = await invoke<ProxyResponse>("api_proxy", {
      url,
      method,
      body: body ?? null,
      contentType,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`接口返回 ${response.status}`);
    }
    return response.body;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 20_000);
  init.signal?.addEventListener("abort", () => controller.abort());
  try {
    const response = await fetch(toBrowserUrl(url), {
      method,
      headers: {
        ...(method === "POST" ? { "Content-Type": contentType } : {}),
        ...init.headers,
      },
      body,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`接口返回 ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

export interface ApiResult<T> {
  code: number;
  data: T;
  message: string;
}

/** 解析 `{ code, data, message }` 包装体并校验业务码。 */
export async function apiResult<T>(url: string, init: ApiInit = {}): Promise<T> {
  const text = await apiText(url, init);
  let payload: ApiResult<T>;
  try {
    payload = JSON.parse(text) as ApiResult<T>;
  } catch {
    throw new Error("接口返回的不是有效 JSON");
  }
  if (payload.code !== 20000) {
    throw new Error(payload.message || `接口业务码 ${payload.code}`);
  }
  return payload.data;
}

/** JeppQuery 等直连服务：返回文本，不做包装体校验。 */
export function withQuery(baseUrl: string, path: string, params: Record<string, string>) {
  const trimmed = baseUrl.replace(/\/+$/, "");
  const search = new URLSearchParams(params).toString();
  return `${trimmed}${path}${search ? `?${search}` : ""}`;
}

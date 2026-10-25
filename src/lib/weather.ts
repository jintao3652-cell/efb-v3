import { getWeather, isTauri } from "./tauri";
import { getMetar, getTaf } from "./xfly";
import { apiText } from "./api";

/** 气象数据源地区：中国境内机场 / 境外机场。 */
export type WeatherRegion = "cn" | "intl";
/**
 * 实际取数通道。
 * - naip   ruri   中国民航航空气象（naip.ruri8557.top），带中文解读
 * - xfly   xflysim XFlySim 气象接口（api.xflysim.com）
 * - vataim vataim  VATSIM 公开 METAR（metar.vatsim.net），只有 METAR
 * - faa    faa     FAA 航空气象（aviationweather.gov），METAR + TAF
 * - caac   caac    CAAC 航空气象：走本机后端，中国气象局 → FAA → OpenWeather 逐级兜底
 */
export type WeatherSourceId = "naip" | "xfly" | "vataim" | "faa" | "caac";
/** 用户偏好：auto 表示按地区推荐顺序自动挑选。 */
export type WeatherSourcePreference = "auto" | WeatherSourceId;

export const NAIP_WEATHER_BASE = "https://naip.ruri8557.top/weather/get_weather.php";

export interface WeatherSourceOption {
  id: WeatherSourcePreference;
  label: string;
  /** 设置页用的长描述 */
  detail: string;
  /** 气象页芯片用的短名 */
  short: string;
  /** 只能走桌面端本机后端，浏览器预览里不出现 */
  desktopOnly?: boolean;
}

export const WEATHER_SOURCE_OPTIONS: WeatherSourceOption[] = [
  { id: "auto", label: "自动", short: "自动", detail: "中国机场优先 ruri，境外机场优先 xflysim，首选源超时即换源" },
  { id: "naip", label: "ruri", short: "ruri", detail: "ruri 中国民航航空气象（naip.ruri8557.top），报文附中文解读与 NOTAM；服务端回源，响应约 2–10 秒" },
  { id: "xfly", label: "xflysim", short: "xflysim", detail: "xflysim XFlySim 气象接口（api.xflysim.com），全球机场覆盖，METAR 与 TAF 同源" },
  { id: "vataim", label: "vataim", short: "vataim", detail: "vataim VATSIM 公开 METAR（metar.vatsim.net），全球实时，只有 METAR 没有 TAF" },
  { id: "faa", label: "faa 气象源", short: "faa", detail: "faa FAA 航空气象（aviationweather.gov），全球 METAR + TAF 原始报文" },
  { id: "caac", label: "caac 航空气象", short: "caac", desktopOnly: true, detail: "caac 航空气象：本机后端取数，中国气象局（avimet.nmc.cn）优先，缺报转 faa，最后 OpenWeather" },
];

/** 浏览器预览里把只能走本机后端的源过滤掉。 */
export function weatherSourceOptions(): WeatherSourceOption[] {
  return WEATHER_SOURCE_OPTIONS.filter((option) => !option.desktopOnly || isTauri());
}

export function weatherSourceLabel(id: WeatherSourcePreference): string {
  return WEATHER_SOURCE_OPTIONS.find((option) => option.id === id)?.label ?? id;
}

/**
 * 中国境内机场的 ICAO 前缀：Z 为中国大陆，V 为中国香港 / 中国澳门，RC 为中国台湾。
 * 其余一律按境外机场处理。
 */
const CHINA_PREFIXES = ["Z", "V", "RC"];

export function weatherRegion(icao: string): WeatherRegion {
  const code = icao.trim().toUpperCase();
  return CHINA_PREFIXES.some((prefix) => code.startsWith(prefix)) ? "cn" : "intl";
}

export function weatherRegionLabel(region: WeatherRegion): string {
  return region === "cn" ? "中国机场" : "境外机场";
}

export interface StationWeather {
  station: string;
  raw: string;
  taf: string;
  observedAt: string;
  /** 人读的数据源名称 */
  source: string;
  /** 报告发布时间（ISO），TAF 为发布时间 */
  issuedAt?: string;
  /** 中文解读，逐行「字段: 内容」，NAIP 专有 */
  decodedMetar?: string[];
  decodedTaf?: string[];
  /** 数据源直接给出的飞行类别（NAIP basic.airplane_mode） */
  flightCategory?: string;
  /** 数据源给出的中文摘要，如「阴，明天午夜 2 点后转小雨」 */
  summary?: string;
  /** 数据源标注的中国境内机场 */
  china?: boolean;
  /** 扫描串里的 QNH，NAIP 的 basic 已给出时可直接用 */
  qnhHint?: string;
  /** 首选源失败时的回退说明 */
  fallbackNote?: string;
  /** 数据源本身不提供 TAF 时的说明（vataim） */
  tafNote?: string;
}

/** 报文里结尾的等号与多余空白对解析没用，展示时也一并去掉。 */
function cleanReport(text?: string | null): string {
  return (text ?? "").replace(/\s*=\s*$/, "").replace(/\s+/g, " ").trim();
}

/** 报文第二段的 DDHHMMZ，与 WeatherPage 里展示的观测时刻同一口径。 */
function reportStamp(raw: string): string {
  return raw.split(/\s+/).find((token) => /^\d{6}Z$/.test(token)) ?? "";
}

/** 报文里的 DDHHMMZ 换成可读时间；失败时返回空串。 */
function stampLabel(iso: string) {
  if (!iso) return "";
  const date = new Date(iso.endsWith("Z") ? iso : `${iso}Z`);
  if (Number.isNaN(date.getTime())) return "";
  return `${String(date.getUTCDate()).padStart(2, "0")}${String(date.getUTCHours()).padStart(2, "0")}${String(date.getUTCMinutes()).padStart(2, "0")}Z`;
}

async function fetchText(url: string, timeoutMs = 15_000): Promise<string> {
  const text = await apiText(url, { timeoutMs });
  return text.trim();
}

/* ───────────────────────── NAIP ───────────────────────── */

interface NaipBasic {
  is_china?: number;
  airport_name?: string;
  airplane_mode?: string;
  temperature?: string;
  weather?: string;
  weather_desc?: string;
  wind?: string;
  wind_angle?: string;
  visibility?: string;
  hpa?: string;
  status?: number;
}

interface NaipReport {
  text?: string;
  wob?: string;
  time?: number;
}

interface NaipStation {
  basic?: NaipBasic;
  parsed?: { station?: string; time?: string; temperature?: number };
  raw?: string;
  source?: string;
  wob?: { metar?: NaipReport; taf?: NaipReport; notam?: NaipReport };
  error?: string;
}

/** 「发布时间:…|风向风速:…|能见度:…」切成逐行条目。 */
function splitDecoded(text?: string): string[] {
  if (!text) return [];
  return text
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);
}

async function fetchNaip(icao: string): Promise<StationWeather> {
  const response = await fetch(`${NAIP_WEATHER_BASE}?icao=${encodeURIComponent(icao)}`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = (await response.json()) as Record<string, NaipStation | undefined>;
  const row = payload[icao] ?? Object.values(payload).find((item) => item && (item.raw || item.basic));
  if (!row) throw new Error(payload[icao]?.error ?? "未返回该机场数据");
  if (row.error) throw new Error(row.error);

  const raw = cleanReport(row.raw ?? row.wob?.metar?.wob);
  if (!raw) throw new Error("未返回 METAR 报文");
  const taf = cleanReport(row.wob?.taf?.wob);
  const basic = row.basic;

  return {
    station: icao,
    raw,
    taf,
    observedAt: reportStamp(raw) || (row.parsed?.time ?? "").replace(/^.*?(\d{2}:\d{2}).*$/, "$1"),
    source: "ruri",
    decodedMetar: splitDecoded(row.wob?.metar?.text),
    decodedTaf: splitDecoded(row.wob?.taf?.text),
    flightCategory: basic?.airplane_mode || undefined,
    summary: basic?.weather_desc || basic?.weather || undefined,
    china: basic?.is_china === 1,
    qnhHint: basic?.hpa || undefined,
  };
}

/* ───────────────────────── XFlySim ───────────────────────── */

async function fetchXfly(icao: string): Promise<StationWeather> {
  const [metar, taf] = await Promise.all([
    getMetar(icao).catch(() => null),
    getTaf(icao).catch(() => null),
  ]);
  if (!metar?.rawText) throw new Error("xflysim 未返回该机场 METAR");
  return {
    station: icao,
    raw: cleanReport(metar.rawText),
    taf: cleanReport(taf?.rawText),
    observedAt: stampLabel(metar.observationTime),
    issuedAt: metar.observationTime,
    source: "xflysim",
  };
}

/* ───────────────────────── vataim ───────────────────────── */

/**
 * aviationweather.gov 的 TAF 会把长报文折行（续行以空格开头，如 `  BECMG 2417/2418 …`），
 * 直接按行过滤会只剩首行。这里把不属于新报文开头的行拼回上一条。
 */
function joinTafBlocks(text: string): string[] {
  const blocks: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^TAF\b/.test(line) || blocks.length === 0) blocks.push(line);
    else blocks[blocks.length - 1] += ` ${line}`;
  }
  return blocks;
}

/** 报文首行：vataim 不带 `METAR ` 前缀，faa 带，两种都要认。 */
function firstReportLine(text: string): string {
  const lines = text.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  return lines.find((item) => /^METAR\b/.test(item)) ?? lines.find((item) => /^[A-Z]{4}\s/.test(item)) ?? lines[0] ?? "";
}

async function fetchVataim(icao: string): Promise<StationWeather> {
  const raw = await fetchText(`https://metar.vatsim.net/${icao}`, 12_000);
  const line = firstReportLine(raw);
  if (!line) throw new Error("vataim 未返回该机场 METAR");
  const observed = reportStamp(line) || (line.split(/\s+/).find((token) => /^\d{6}Z$/.test(token)) ?? "");
  return {
    station: icao,
    raw: cleanReport(line),
    taf: "",
    observedAt: observed,
    source: "vataim",
    tafNote: "vataim 只提供 METAR，需要 TAF 请切到 faa 或 xflysim",
  };
}

/* ───────────────────────── faa ───────────────────────── */

async function fetchFaa(icao: string): Promise<StationWeather> {
  const [metarText, tafText] = await Promise.all([
    fetchText(`https://aviationweather.gov/api/data/metar?ids=${icao}&format=raw`, 15_000).catch(() => ""),
    fetchText(`https://aviationweather.gov/api/data/taf?ids=${icao}&format=raw`, 18_000).catch(() => ""),
  ]);
  const line = firstReportLine(metarText);
  if (!line) throw new Error("faa 未返回该机场 METAR");
  return {
    station: icao,
    raw: cleanReport(line),
    taf: joinTafBlocks(tafText).map((item) => cleanReport(item)).join("\n"),
    observedAt: reportStamp(line),
    source: "faa",
  };
}

/* ───────────────────────── caac（本机后端） ───────────────────────── */

async function fetchCaac(icao: string): Promise<StationWeather> {
  const report = await getWeather(icao, false);
  return {
    station: icao,
    raw: cleanReport(report.raw),
    taf: cleanReport(report.taf),
    observedAt: report.observedAt,
    source: report.source || "caac",
  };
}

const FETCHERS: Record<WeatherSourceId, (icao: string) => Promise<StationWeather>> = {
  naip: fetchNaip,
  xfly: fetchXfly,
  vataim: fetchVataim,
  faa: fetchFaa,
  caac: fetchCaac,
};

/**
 * 单次取数的时间预算。NAIP 服务端要回源拉取，实测 TTFB 2–9 秒，
 * 自动模式下只给它 5 秒，超时就换源，避免整页气象空白十几秒。
 * 用户显式指定某个源时放宽到 20 秒，等它把数据取回来。
 */
const BUDGET: Record<WeatherSourceId, { auto: number; explicit: number }> = {
  naip: { auto: 5_000, explicit: 20_000 },
  xfly: { auto: 9_000, explicit: 20_000 },
  vataim: { auto: 9_000, explicit: 20_000 },
  faa: { auto: 9_000, explicit: 20_000 },
  caac: { auto: 14_000, explicit: 24_000 },
};

function withBudget<T>(task: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 响应超时（${Math.round(ms / 1000)} 秒）`)), ms);
    task.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

/** 自动模式的候选顺序：境内以 ruri 为默认（带中文解读），境外以 xflysim 为默认。 */
function autoChain(region: WeatherRegion): WeatherSourceId[] {
  return region === "cn" ? ["naip", "xfly", "faa", "vataim"] : ["xfly", "naip", "faa", "vataim"];
}

/** 旧版偏好里的 `public`（VATSIM METAR + AWC TAF 合体）拆成了 vataim / faa，落到 faa。 */
function normalizePreference(preference: WeatherSourcePreference): WeatherSourcePreference {
  if (preference === ("public" as WeatherSourcePreference)) return "faa";
  return preference;
}

/** 选定源 + 回退顺序；caac 依赖本机后端，浏览器预览里剔除。 */
function buildChain(preference: WeatherSourcePreference, region: WeatherRegion): WeatherSourceId[] {
  const ordered = preference === "auto"
    ? autoChain(region)
    : [preference as WeatherSourceId, ...autoChain(region).filter((id) => id !== preference)];
  const usable = ordered.filter((id) => id !== "caac" || isTauri());
  if (isTauri() && !usable.includes("caac")) usable.push("caac");
  return usable;
}

/**
 * 按用户选定（或按地区自动挑选）的数据源取 METAR / TAF。
 * 首选源失败或超时会依次回退到同级其他源，并在 `fallbackNote` 里留下原因，
 * 避免某一个源宕机时整页气象空白。
 */
export async function loadStationWeather(
  station: string,
  options: { preference?: WeatherSourcePreference; preferCache?: boolean } = {},
): Promise<StationWeather> {
  const icao = station.trim().toUpperCase();
  if (!icao) throw new Error("请填写 ICAO 代码");

  const region = weatherRegion(icao);
  const requested = normalizePreference(options.preference ?? "auto");
  // caac 只能走本机后端；浏览器预览里读到旧偏好就退回自动，别让整块气象直接报错。
  const preference = requested === "caac" && !isTauri() ? "auto" : requested;

  const chain = buildChain(preference, region);

  const failures: string[] = [];
  for (const [index, id] of chain.entries()) {
    // 自动模式下第一顺位用紧凑预算；显式指定且排在第一位的源给足时间。
    const budget = preference === "auto" || index > 0 ? BUDGET[id].auto : BUDGET[id].explicit;
    try {
      const result = await withBudget(FETCHERS[id](icao), budget, weatherSourceLabel(id));
      if (failures.length) result.fallbackNote = `${failures[failures.length - 1]}，已回退到 ${weatherSourceLabel(id)}`;
      return result;
    } catch (error) {
      failures.push(`${weatherSourceLabel(id)}：${error instanceof Error ? error.message : "未知错误"}`);
    }
  }

  // 实时源全部没回来：桌面端读本机缓存里最近一份报文，断网时也不至于整页空白。
  if (isTauri()) {
    try {
      const report = await getWeather(icao, true);
      return {
        station: icao,
        raw: cleanReport(report.raw),
        taf: cleanReport(report.taf),
        observedAt: report.observedAt,
        source: report.source,
        fallbackNote: failures.length ? `${failures[failures.length - 1]}，已回退到本机缓存` : undefined,
      };
    } catch (error) {
      failures.push(`本机缓存：${error instanceof Error ? error.message : "未知错误"}`);
    }
  }

  throw new Error(`所有气象源均不可用（${failures.join("；")}）`);
}

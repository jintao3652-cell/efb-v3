/**
 * METAR / TAF 解析（纯前端，无第三方依赖）。
 * 只做「能读给人看」的解析：风向风速、能见度、天气现象、云、温度露点、QNH，
 * 以及 TAF 的 BECMG / TEMPO / PROB 变化组。不做校验、不做趋势推断。
 */

export type FlightCategory = "VFR" | "MVFR" | "IFR" | "LIFR";

export interface WindInfo {
  direction: number | null;
  speed: number | null;
  gust: number | null;
  unit: "MPS" | "KT" | "";
  varying: [number, number] | null;
  label: string;
}

export interface CloudLayer {
  amount: string;
  base: number | null;
  type: string;
}

export interface MetarParsed {
  station: string;
  observation: string;
  wind: WindInfo;
  visibility: { meters: number | null; label: string; cavok: boolean };
  weather: { codes: string[]; label: string };
  clouds: { layers: CloudLayer[]; label: string };
  temperature: number | null;
  dewpoint: number | null;
  qnh: number | null;
  category: FlightCategory;
  trend: string;
  raw: string;
}

export interface TafSegment {
  kind: "BASE" | "BECMG" | "TEMPO" | "PROB" | "FM";
  probability: number | null;
  from: string;
  to: string;
  timeLabel: string;
  wind: WindInfo | null;
  visibility: { meters: number | null; label: string; cavok: boolean } | null;
  weather: string | null;
  clouds: string | null;
  raw: string;
}

export interface TafParsed {
  station: string;
  issued: string;
  validFrom: string;
  validTo: string;
  validityLabel: string;
  base: TafSegment | null;
  changes: TafSegment[];
  maxTemp: string;
  minTemp: string;
  raw: string;
}

const WEATHER_CODES: Array<[string, string]> = [
  ["DZ", "毛毛雨"], ["RA", "雨"], ["SN", "雪"], ["SG", "米雪"], ["IC", "冰晶"],
  ["PL", "冰粒"], ["GR", "冰雹"], ["GS", "小冰雹"], ["UP", "未知降水"],
  ["BR", "轻雾"], ["FG", "雾"], ["FU", "烟"], ["VA", "火山灰"], ["DU", "浮尘"],
  ["SA", "沙"], ["HZ", "霾"], ["PY", "浪花"], ["PO", "尘卷风"], ["SQ", "飑"],
  ["FC", "漏斗云"], ["SS", "沙暴"], ["DS", "尘暴"],
];

const DESCRIPTORS: Record<string, string> = {
  MI: "浅", PR: "部分", BC: "散", DR: "低吹", BL: "吹", SH: "阵性",
  TS: "雷暴", FZ: "冻", VC: "附近",
};

function weatherTokenLabel(token: string): string {
  const upper = token.toUpperCase();
  if (/^(NOSIG|TEMPO|BECMG|RMK|AUTO|COR|NIL)$/.test(upper)) return "";
  let rest = upper;
  let intensity = "";
  if (rest.startsWith("+")) { intensity = "强"; rest = rest.slice(1); }
  else if (rest.startsWith("-")) { intensity = "弱"; rest = rest.slice(1); }
  let descriptor = "";
  if (DESCRIPTORS[rest.slice(0, 2)]) { descriptor = DESCRIPTORS[rest.slice(0, 2)]; rest = rest.slice(2); }
  const parts: string[] = [];
  for (let index = 0; index + 2 <= rest.length; index += 2) {
    const code = rest.slice(index, index + 2);
    const found = WEATHER_CODES.find(([key]) => key === code);
    if (found) parts.push(found[1]);
  }
  if (!descriptor && !parts.length) return "";
  const body = parts.join("、");
  if (descriptor && body) return `${intensity}${descriptor}伴${body}`;
  if (descriptor) return `${intensity}${descriptor}`;
  return `${intensity}${body}`;
}

export function weatherSummary(tokens: string[]): string {
  const labels = tokens.map(weatherTokenLabel).filter(Boolean);
  return labels.length ? [...new Set(labels)].join("，") : "无重要天气";
}

function parseWind(token: string | undefined): WindInfo {
  const empty: WindInfo = { direction: null, speed: null, gust: null, unit: "", varying: null, label: "静风" };
  if (!token) return empty;
  const match = /^(\d{3}|VRB)(\d{2,3})(G(\d{2,3}))?(MPS|KT)$/.exec(token.toUpperCase());
  if (!match) return empty;
  const direction = match[1] === "VRB" ? null : Number(match[1]);
  const speed = Number(match[2]);
  const gust = match[4] ? Number(match[4]) : null;
  const unit = match[5] as "MPS" | "KT";
  return {
    direction, speed, gust, unit, varying: null,
    label: `${direction === null ? "风向不定" : `${String(direction).padStart(3, "0")}°`} ${speed} ${unit}${gust ? `，阵风 ${gust}` : ""}`,
  };
}

function applyVariance(wind: WindInfo, token: string | undefined): WindInfo {
  if (!token) return wind;
  const match = /^(\d{3})V(\d{3})$/.exec(token.toUpperCase());
  if (!match) return wind;
  return { ...wind, varying: [Number(match[1]), Number(match[2])] };
}

export function windLabel(wind: WindInfo): string {
  if (wind.speed === null) return "静风";
  const base = `${wind.direction === null ? "风向不定" : `${String(wind.direction).padStart(3, "0")}°`} ${wind.speed} ${wind.unit}${wind.gust ? `，阵风 ${wind.gust}` : ""}`;
  return wind.varying ? `${base}，${String(wind.varying[0]).padStart(3, "0")}°–${String(wind.varying[1]).padStart(3, "0")}° 间变化` : base;
}

function parseVisibility(meters: number | null, cavok: boolean): { meters: number | null; label: string; cavok: boolean } {
  if (cavok) return { meters: 9999, label: "10 km 以上（CAVOK）", cavok };
  if (meters === null) return { meters: null, label: "—", cavok };
  if (meters >= 9999) return { meters: 9999, label: "10 km 以上", cavok };
  if (meters >= 1000) return { meters, label: `${(meters / 1000).toFixed(meters % 1000 === 0 ? 0 : 1)} km`, cavok };
  return { meters, label: `${meters} m`, cavok };
}

function parseClouds(tokens: string[]): { layers: CloudLayer[]; label: string } {
  const layers: CloudLayer[] = [];
  for (const token of tokens) {
    const upper = token.toUpperCase();
    if (upper === "NSC" || upper === "NCD" || upper === "SKC" || upper === "CLR") {
      return { layers, label: "无重要云" };
    }
    const match = /^(FEW|SCT|BKN|OVC)(\d{3})(CB|TCU)?$/.exec(upper);
    if (!match) continue;
    layers.push({ amount: match[1], base: Number(match[2]) * 100, type: match[3] ?? "" });
  }
  if (!layers.length) return { layers, label: "无重要云" };
  const lowest = layers.reduce((low, layer) => (layer.base !== null && layer.base < low ? layer.base : low), 99999);
  const described = layers.map((layer) => `${layer.amount} ${layer.base?.toLocaleString("en-US")} ft${layer.type ? ` ${layer.type}` : ""}`).join("，");
  return {
    layers,
    label: lowest >= 5000 ? `无 5000 英尺以下重要云（${described}）` : described,
  };
}

export function categoryFor(visibilityMeters: number | null, ceilingFeet: number | null): FlightCategory {
  const vis = visibilityMeters === null ? 9999 : visibilityMeters;
  const ceiling = ceilingFeet === null ? 99999 : ceilingFeet;
  if (vis < 1600 || ceiling < 500) return "LIFR";
  if (vis < 5000 || ceiling < 1000) return "IFR";
  if (vis <= 8000 || ceiling <= 3000) return "MVFR";
  return "VFR";
}

export function ceilingOf(layers: CloudLayer[]): number | null {
  const broken = layers.filter((layer) => layer.amount === "BKN" || layer.amount === "OVC");
  if (!broken.length) return null;
  return Math.min(...broken.map((layer) => layer.base ?? 99999));
}

function timeLabel(token: string): string {
  const match = /^(\d{2})(\d{2})(\d{2})Z?$/.exec(token.toUpperCase());
  if (!match) return token;
  return `${Number(match[1])} 日 ${match[2]}:${match[3]} UTC`;
}

function shortTime(token: string): string {
  const match = /^(\d{2})(\d{2})$/.exec(token);
  return match ? `${Number(match[1])}日${match[2]}时` : token;
}

export function parseMetar(raw: string): MetarParsed | null {
  const text = raw.trim().replace(/\s+/g, " ");
  if (!text) return null;
  const tokens = text.split(" ");
  const stationIndex = tokens.findIndex((token) => /^[A-Z]{4}$/.test(token) && !["METAR", "SPECI", "AUTO", "CAVOK", "NOSIG"].includes(token));
  if (stationIndex < 0) return null;
  const station = tokens[stationIndex];
  const body = tokens.slice(stationIndex + 1);
  const observationToken = body.find((token) => /^\d{6}Z$/.test(token)) ?? "";
  const windToken = body.find((token) => /^(\d{3}|VRB)\d{2,3}(G\d{2,3})?(MPS|KT)$/.test(token));
  const varianceToken = body.find((token) => /^\d{3}V\d{3}$/.test(token));
  const cavok = body.includes("CAVOK");
  const visToken = body.find((token) => /^\d{4}$/.test(token) && Number(token) <= 9999 && !/^(19|20|21|22|23|24|25|26|27|28|29)\d{2}$/.test(token));
  // 北美机场报 `10SM` / `1/2SM` / `P6SM`，公制机场才报四位米。
  const smToken = body.find((token) => /^P?\d{1,2}(\/\d{1,2})?SM$/.test(token));
  const tempToken = body.find((token) => /^(M?\d{2})\/(M?\d{2})?$/.test(token));
  const qnhToken = body.find((token) => /^(Q\d{4}|A\d{4})$/.test(token));
  const cloudTokens = body.filter((token) => /^(FEW|SCT|BKN|OVC|NSC|NCD|SKC|CLR)/.test(token));
  const weatherTokens = body.filter((token) => /^[+-]?(VC)?(MI|PR|BC|DR|BL|SH|TS|FZ)?(DZ|RA|SN|SG|IC|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PY|PO|SQ|FC|SS|DS){1,3}$/.test(token));

  const wind = applyVariance(parseWind(windToken), varianceToken);
  const visibility = cavok
    ? parseVisibility(null, true)
    : (smToken ? visibilityFromMiles(smToken) : null) ?? parseVisibility(visToken ? Number(visToken) : null, false);
  const clouds = parseClouds(cloudTokens);
  const temperatureToken = tempToken?.split("/")[0];
  const dewpointToken = tempToken?.split("/")[1];
  const temperature = temperatureToken ? Number(temperatureToken.replace("M", "-")) : null;
  const dewpoint = dewpointToken ? Number(dewpointToken.replace("M", "-")) : null;
  const qnh = qnhToken
    ? qnhToken.startsWith("Q") ? Number(qnhToken.slice(1)) : Math.round(Number(qnhToken.slice(1)) * 0.3386)
    : null;

  return {
    station,
    observation: timeLabel(observationToken),
    wind,
    visibility,
    weather: { codes: weatherTokens, label: weatherSummary(weatherTokens) },
    clouds,
    temperature,
    dewpoint,
    qnh,
    category: categoryFor(visibility.meters, ceilingOf(clouds.layers)),
    trend: body.includes("NOSIG") ? "未来两小时无显著变化（NOSIG）" : body.find((token) => token === "TEMPO" || token === "BECMG") ?? "",
    raw: text,
  };
}

/**
 * 美制 TAF 用法定英里报能见度：`6SM`、`1/2SM`、`P6SM`（大于 6 英里）。
 * 统一折算成米后仍按公制展示，括号里保留原始英里数，避免机组看惯 SM 时对不上。
 */
function statuteMiles(token: string): number | null {
  const body = token.replace(/^P/, "").replace(/SM$/, "");
  if (body.includes("/")) {
    const [numerator, denominator] = body.split("/");
    const value = Number(numerator) / Number(denominator);
    return Number.isFinite(value) ? value : null;
  }
  const value = Number(body);
  return Number.isFinite(value) ? value : null;
}

function visibilityFromMiles(token: string): { meters: number; label: string; cavok: boolean } | null {
  const miles = statuteMiles(token);
  if (miles === null) return null;
  const plus = token.startsWith("P");
  return {
    meters: Math.round(miles * 1609.34),
    label: `${plus ? "大于 " : ""}${miles} SM（约 ${(miles * 1.609).toFixed(1)} km）`,
    cavok: false,
  };
}

function segmentFrom(tokens: string[], kind: TafSegment["kind"], from: string, to: string, probability: number | null): TafSegment {
  const windToken = tokens.find((token) => /^(\d{3}|VRB)\d{2,3}(G\d{2,3})?(MPS|KT)$/.test(token));
  const cavok = tokens.includes("CAVOK");
  const visToken = tokens.find((token) => /^\d{4}$/.test(token));
  const smToken = tokens.find((token) => /^P?\d{1,2}(\/\d{1,2})?SM$/.test(token));
  const cloudTokens = tokens.filter((token) => /^(FEW|SCT|BKN|OVC|NSC|NCD|SKC|CLR)/.test(token));
  const weatherTokens = tokens.filter((token) => /^[+-]?(VC)?(MI|PR|BC|DR|BL|SH|TS|FZ)?(DZ|RA|SN|SG|IC|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PY|PO|SQ|FC|SS|DS){1,3}$/.test(token));
  const clouds = parseClouds(cloudTokens);
  return {
    kind,
    probability,
    from,
    to,
    timeLabel: from && to ? `${shortTime(from)}至${shortTime(to)} UTC` : "",
    wind: windToken ? applyVariance(parseWind(windToken), tokens.find((token) => /^\d{3}V\d{3}$/.test(token))) : null,
    visibility: cavok
      ? parseVisibility(null, true)
      : smToken
        ? visibilityFromMiles(smToken)
        : visToken
          ? parseVisibility(Number(visToken), false)
          : null,
    weather: weatherTokens.length ? weatherSummary(weatherTokens) : null,
    clouds: cloudTokens.length ? clouds.label : null,
    raw: tokens.join(" "),
  };
}

export function parseTaf(raw: string): TafParsed | null {
  const text = raw.trim().replace(/\s+/g, " ");
  if (!text) return null;
  const tokens = text.split(" ");
  const stationIndex = tokens.findIndex((token) => /^[A-Z]{4}$/.test(token) && token !== "TAF" && token !== "AMD" && token !== "COR");
  if (stationIndex < 0) return null;
  const station = tokens[stationIndex];
  const rest = tokens.slice(stationIndex + 1);
  const issuedToken = rest.find((token) => /^\d{6}Z$/.test(token)) ?? "";
  const validityToken = rest.find((token) => /^\d{4}\/\d{4}$/.test(token)) ?? "";
  const [validFrom, validTo] = validityToken.split("/");
  const validityLabel = validFrom && validTo
    ? `${shortTime(validFrom)}至${shortTime(validTo)} UTC`
    : "有效期未知";

  // 以变化组（BECMG/TEMPO/PROBxx）为分隔符切段
  const groups: Array<{ kind: TafSegment["kind"]; probability: number | null; from: string; to: string; tokens: string[] }> = [];
  let current: { kind: TafSegment["kind"]; probability: number | null; from: string; to: string; tokens: string[] } = { kind: "BASE", probability: null, from: "", to: "", tokens: [] };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    // FM241500 = 24 日 15:00Z 起整体转为新条件，起点自带、终点是下一段或有效期终点。
    const fmMatch = /^FM(\d{2})(\d{2})(\d{2})$/.exec(token);
    if (fmMatch) {
      if (current.tokens.length || current.kind !== "BASE") groups.push(current);
      current = { kind: "FM", probability: null, from: `${fmMatch[1]}${fmMatch[2]}`, to: "", tokens: [] };
      continue;
    }
    const changeMatch = /^(BECMG|TEMPO)$/.exec(token);
    const probMatch = /^PROB(\d{2})$/.exec(token);
    if (changeMatch || probMatch) {
      if (current.tokens.length || current.kind !== "BASE") groups.push(current);
      const rangeToken = rest[index + 1] && /^\d{4}\/\d{4}$/.test(rest[index + 1]) ? rest[index + 1] : "";
      const [from, to] = rangeToken.split("/");
      current = {
        kind: probMatch ? "PROB" : changeMatch![1] as TafSegment["kind"],
        probability: probMatch ? Number(probMatch[1]) : null,
        from: from ?? "", to: to ?? "", tokens: [],
      };
      if (rangeToken) index += 1;
      continue;
    }
    if (/^(TX|TN)\d{2}\/\d{4}Z$/.test(token) || /^(TX|TN)/.test(token) || /^\d{6}Z$/.test(token) || token === "NIL") continue;
    current.tokens.push(token);
  }
  if (current.tokens.length || current.kind !== "BASE") groups.push(current);

  // FM 段本身不带终点：取下一段有起点的分组，最后一段到有效期结束。
  groups.forEach((group, index) => {
    if (group.kind === "FM" && !group.to) {
      group.to = groups.slice(index + 1).find((next) => next.from)?.from || validTo || "";
    }
  });

  const baseGroup = groups.find((group) => group.kind === "BASE");
  const base = baseGroup ? segmentFrom(baseGroup.tokens, "BASE", validFrom ?? "", validTo ?? "", null) : null;
  const changes = groups.filter((group) => group.kind !== "BASE").map((group) => segmentFrom(group.tokens, group.kind, group.from, group.to, group.probability));
  const maxTempToken = rest.find((token) => /^TX(M?\d{2})\/(\d{4})Z$/.test(token));
  const minTempToken = rest.find((token) => /^TN(M?\d{2})\/(\d{4})Z$/.test(token));
  const tempText = (token?: string) => {
    if (!token) return "";
    const match = /^(TX|TN)(M?\d{2})\/(\d{2})(\d{2})Z$/.exec(token);
    if (!match) return "";
    return `${Number(match[2].replace("M", "-"))}°C（${Number(match[3])} 日 ${match[4]} 时 UTC）`;
  };

  return {
    station,
    issued: timeLabel(issuedToken),
    validFrom: validFrom ?? "",
    validTo: validTo ?? "",
    validityLabel,
    base,
    changes,
    maxTemp: tempText(maxTempToken),
    minTemp: tempText(minTempToken),
    raw: text,
  };
}

export function visibilityLabel(meters: number | null): string {
  return parseVisibility(meters, false).label;
}

export function temperatureLabel(temperature: number | null, dewpoint: number | null): string {
  if (temperature === null) return "—";
  if (dewpoint === null) return `${temperature}°C`;
  return `${temperature}°C / ${dewpoint}°C`;
}

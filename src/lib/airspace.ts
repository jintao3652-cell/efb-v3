import { fetchJsonWithRetry, fetchTextWithRetry, loadCachedResource, type CachedResourceMeta } from "./network-cache";

export interface GeoJsonFeatureCollection {
  type: "FeatureCollection";
  features: Array<{ type: "Feature"; properties: Record<string, unknown>; geometry: { type: string; coordinates: unknown } }>;
}

export interface OwnershipFile {
  name?: string;
  description?: string;
  type?: string;
  airspace?: Record<string, string[]>;
  airports?: Record<string, unknown>;
}

export interface VatGlassesResult {
  features: GeoJsonFeatureCollection;
  ownership?: OwnershipFile;
  source: string;
}

export interface VatsimController {
  cid?: number;
  callsign: string;
  frequency: string;
  name: string;
  facility: number;
  rating?: number;
  logon_time?: string;
  // VATSIM 的 text_atis 是席位备注/ATIS 文本行数组，可能为 null。
  text_atis?: string[] | null;
}

export interface VatsimPilot {
  cid: number;
  name: string;
  callsign: string;
  latitude: number;
  longitude: number;
  altitude: number;
  groundspeed: number;
  transponder: string;
  heading: number;
  qnh_i_hg: number;
  qnh_mb: number;
  logon_time: string;
  last_updated: string;
  flight_plan?: {
    flight_rules: string;
    aircraft: string;
    aircraft_short: string;
    departure: string;
    arrival: string;
    alternate: string;
    cruise_tas: string;
    altitude: string;
    deptime: string;
    enroute_time: string;
    fuel_time: string;
    remarks: string;
    route: string;
  } | null;
}

export interface CachedGeoJsonCollection {
  data: GeoJsonFeatureCollection;
  meta: CachedResourceMeta;
}

export interface VatsimSnapshot {
  controllers: VatsimController[];
  pilots: VatsimPilot[];
  meta: CachedResourceMeta;
}

const emptyCollection = (): GeoJsonFeatureCollection => ({ type: "FeatureCollection", features: [] });

function normalizeCoordinates(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  if (value.length && value.every((item) => typeof item === "string")) {
    return value.map((item) => {
      const [longitude, latitude] = String(item).trim().split(/\s+/).map(Number);
      return [longitude, latitude];
    });
  }
  return value.map(normalizeCoordinates);
}

function normalizeGeoJson(payload: GeoJsonFeatureCollection): GeoJsonFeatureCollection {
  return { ...payload, features: payload.features.map((feature) => ({ ...feature, geometry: { ...feature.geometry, coordinates: normalizeCoordinates(feature.geometry.coordinates) } })) };
}

function fetchJson<T>(url: string, signal?: AbortSignal) {
  return fetchJsonWithRetry<T>(url, { signal, timeoutMs: 15_000, retries: 1 });
}

async function loadCachedJson<T>(cacheKey: string, url: string, signal?: AbortSignal) {
  return (await loadCachedResource({ cacheKey, ttlMs: 24 * 60 * 60_000, signal, load: (requestSignal) => fetchJson<T>(url, requestSignal) })).data;
}

async function loadCachedGeoJson(cacheKey: string, url: string, signal?: AbortSignal): Promise<CachedGeoJsonCollection> {
  const result = await loadCachedResource({
    cacheKey,
    ttlMs: 24 * 60 * 60_000,
    signal,
    load: async (requestSignal) => normalizeGeoJson(await fetchJsonWithRetry<GeoJsonFeatureCollection>(url, { signal: requestSignal, timeoutMs: 18_000, retries: 1 })),
  });
  return result;
}

export function loadFirBoundaries(signal?: AbortSignal) {
  return loadCachedGeoJson("vatsim-fir-boundaries-v1", "https://cdn.volanta.app/navdata/vatsim/boundaries.json", signal);
}

export function loadTraconBoundaries(signal?: AbortSignal) {
  return loadCachedGeoJson("vatsim-tracon-boundaries-v1", "https://cdn.volanta.app/vatsim/TRACONBoundaries.geojson", signal);
}

export async function loadGlobalAirspace(signal?: AbortSignal) {
  const [fir, tracon] = await Promise.all([loadFirBoundaries(signal), loadTraconBoundaries(signal)]);
  return { fir: fir.data, tracon: tracon.data, status: { fir: fir.meta, tracon: tracon.meta } };
}

export async function loadVatsimSnapshot(signal?: AbortSignal): Promise<VatsimSnapshot> {
  const result = await loadCachedResource({
    cacheKey: "vatsim-live-snapshot-v1",
    ttlMs: 12_000,
    signal,
    load: (requestSignal) => fetchJsonWithRetry<{ controllers?: VatsimController[]; pilots?: VatsimPilot[] }>("https://data.vatsim.net/v3/vatsim-data.json", { signal: requestSignal, timeoutMs: 12_000, retries: 1 }),
  });
  return { controllers: result.data.controllers ?? [], pilots: result.data.pilots ?? [], meta: result.meta };
}

export async function loadVatsimControllers(signal?: AbortSignal): Promise<VatsimController[]> {
  return (await loadVatsimSnapshot(signal)).controllers;
}

export async function loadVatsimPilots(signal?: AbortSignal): Promise<VatsimPilot[]> {
  return (await loadVatsimSnapshot(signal)).pilots;
}

// VATSIM 席位类型编码（facility）→ 显示名。管制详情卡里的「设施类型」直接用它。
// 只写「FSS」而非全称 Flight Service：三格布局实测宽度放不下全称，而 FSS 是航空通用缩写。
const vatsimFacilityNames: Record<number, string> = {
  0: "Observer",
  1: "FSS",
  2: "Delivery",
  3: "Ground",
  4: "Tower",
  5: "Approach",
  6: "Center",
  7: "Departure",
};

export function vatsimFacilityLabel(facility: number) {
  return vatsimFacilityNames[facility] ?? "Unknown";
}

// 在线时长按 HH:MM 显示（与 VATSIM 客户端一致），不足 1 小时补零。
export function vatsimOnlineDuration(logonTime?: string, now = Date.now()) {
  const startedAt = logonTime ? Date.parse(logonTime) : Number.NaN;
  if (!Number.isFinite(startedAt)) return "--:--";
  const totalMinutes = Math.max(0, Math.floor((now - startedAt) / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export function vatsimAtisLines(controller?: VatsimController) {
  return (controller?.text_atis ?? []).map((line) => String(line).trim()).filter(Boolean);
}

// 两种扇区标记都会写入 activeCallsign（拼接串）与 activeCallsigns（数组），
// 这里统一解码，供地图点击时取回该扇区名下的全部席位。
export function activeCallsignList(properties: Record<string, unknown> | undefined | null) {
  const list = properties?.activeCallsigns;
  if (Array.isArray(list)) return list.map(String).map((callsign) => callsign.trim()).filter(Boolean);
  return String(properties?.activeCallsign ?? "").split(" / ").map((callsign) => callsign.trim()).filter(Boolean);
}

function traconPrefixes(feature: GeoJsonFeatureCollection["features"][number]) {
  const prefix = feature.properties.prefix;
  return Array.isArray(prefix) ? prefix.map(String) : typeof prefix === "string" ? [prefix] : [];
}

function traconSuffix(feature: GeoJsonFeatureCollection["features"][number]) {
  return String(feature.properties.suffix ?? "APP").toUpperCase();
}

export function applyActiveTraconControllers(collection: GeoJsonFeatureCollection, controllers: VatsimController[]): GeoJsonFeatureCollection {
  const activeMatches = new Map<number, string[]>();
  for (const controller of controllers) {
    const callsign = controller.callsign.toUpperCase();
    const candidates = collection.features.map((feature, index) => {
      const suffix = traconSuffix(feature);
      const matchingPrefixes = traconPrefixes(feature).filter((prefix) => callsign.startsWith(`${prefix.toUpperCase()}_`) && callsign.endsWith(`_${suffix}`));
      return { index, score: Math.max(0, ...matchingPrefixes.map((prefix) => prefix.length)) };
    }).filter((candidate) => candidate.score > 0);
    const bestScore = Math.max(0, ...candidates.map((candidate) => candidate.score));
    for (const candidate of candidates.filter((item) => item.score === bestScore)) activeMatches.set(candidate.index, [...(activeMatches.get(candidate.index) ?? []), controller.callsign]);
  }
  return {
    ...collection,
    features: collection.features.map((feature, index) => {
      const callsigns = activeMatches.get(index) ?? [];
      return {
        ...feature,
        // band / min / max / label 是为了与 VATGlasses 扇区共用同一套图层与 FL 过滤：
        // 进近边界恒属 terminal 一族，高度不分层故补 0–999。
        properties: { ...feature.properties, band: "terminal", min: Number(feature.properties.min ?? 0), max: Number(feature.properties.max ?? 999), label: String(feature.properties.name ?? feature.properties.id ?? ""), active: callsigns.length > 0, activeCallsign: callsigns.join(" / "), activeCallsigns: callsigns },
      };
    }),
  };
}

// FIR / UIR 边界来自 Volanta boundaries.json，属性只有 id / oceanic / label_* / region / division，
// 不含任何管制状态，因此要按 VATSIM 席位反推。FIR 的 id 即席位前缀（如 ZBPE），
// 席位呼号形如 ZBPE_CTR / ZBPE_N_CTR / ZBPE_FSS，故取「末段为航路席位 + 前缀命中 FIR id」判定。
// 只认航路席位（CTR/FSS）：APP / TWR 等只管机场周边，不足以代表整个 FIR 有管制。
const enroutePositionSuffixes = ["CTR", "FSS"];

export function applyActiveFirControllers(collection: GeoJsonFeatureCollection, controllers: VatsimController[]): GeoJsonFeatureCollection {
  const firIds = collection.features.map((feature) => String(feature.properties.id ?? "").toUpperCase());
  const activeMatches = new Map<number, string[]>();
  const mark = (index: number, callsign: string) => activeMatches.set(index, [...(activeMatches.get(index) ?? []), callsign]);
  for (const controller of controllers) {
    const segments = controller.callsign.toUpperCase().split("_");
    if (segments.length < 2) continue;
    if (!enroutePositionSuffixes.includes(segments.at(-1) ?? "")) continue;
    const station = segments.slice(0, -1).join("_");
    // 取最长命中的 id，避免 ADR 抢走 ADR-E 这类父子边界；
    // 数据集里存在同名重复要素（ZBAA / CZQM 等各两份），故同名者要一并命中。
    let bestLength = 0;
    const hits: Array<{ index: number; id: string }> = [];
    firIds.forEach((id, index) => {
      if (!id) return;
      if (station !== id && !station.startsWith(`${id}_`)) return;
      if (id.length > bestLength) { bestLength = id.length; hits.length = 0; hits.push({ index, id }); }
      else if (id.length === bestLength) hits.push({ index, id });
    });
    for (const { index, id } of hits) {
      mark(index, controller.callsign);
      // 母边界有管制时，其分区边界（ZBAA-E / ZSSS-N 等）一并点亮，避免出现孤立暗块。
      if (id !== station) continue;
      firIds.forEach((childId, childIndex) => { if (childId.startsWith(`${id}-`)) mark(childIndex, controller.callsign); });
    }
  }
  return {
    ...collection,
    features: collection.features.map((feature, index) => {
      const callsigns = activeMatches.get(index) ?? [];
      return { ...feature, properties: { ...feature.properties, active: callsigns.length > 0, activeCallsign: callsigns.join(" / "), activeCallsigns: callsigns } };
    }),
  };
}

// —— 管制员扇区延长（cloning，对齐 VATSIM Radar 的 duplicating 规则）——
// 依据：https://docs.vatsim-radar.com/guide/duplicating.html
//   · 澳/新（vatSys 数据集）：ATIS 含 `EXT <扇区名> <频率>`，如 `EXT ASW 131.800`；
//     克隆后呼号与频率改为目标扇区。
//   · 中国 VATPRC / 日本：ATIS 含 `<扇区名> <频率>`（可加 `Extending` 前缀），如 `N47 133.55`；
//     写入频率须等于主用频率或任一被延长扇区的默认频率，否则按主用频率处理；
//     结果频率等于主用频率时跳过（避免同频重复叠加）。
//   · 仅作用于 _CTR / _APP / _DEP（facility 6 / 5 / 7）。
// 四份数据源都是同一种 <Sector Frequency Callsign Name/> 的 Sectors.xml。
export interface SectorDefinition {
  callsign: string;
  name: string;
  frequency: string;
  rule: "namefreq" | "ext";
}

const sectorDefinitionSources: Array<{ key: string; url: string; rule: SectorDefinition["rule"] }> = [
  { key: "vatprc", url: "https://files.vatprc.net/sectors/Sectors.xml", rule: "namefreq" },
  { key: "vatjpn", url: "https://vatjpn.org/media/external/vatsim-radar/Sectors.xml", rule: "namefreq" },
  { key: "vatsys-au", url: "https://raw.githubusercontent.com/vatSys/australia-dataset/master/Sectors.xml", rule: "ext" },
  { key: "vatsys-nz", url: "https://raw.githubusercontent.com/vatSys/new-zealand-dataset/refs/heads/master/Sectors.xml", rule: "ext" },
];

function parseSectorDefinitions(xml: string, rule: SectorDefinition["rule"]): SectorDefinition[] {
  const definitions: SectorDefinition[] = [];
  // ⚠️ \b 必须保留：不加的话 Name= 会匹配到 FullName=，把扇区名解析成全名。
  const attribute = (tag: string, name: string) => tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i"))?.[1]?.trim() ?? "";
  for (const match of xml.matchAll(/<Sector\b[^>]*>/gi)) {
    const tag = match[0];
    const callsign = attribute(tag, "Callsign").toUpperCase();
    const name = attribute(tag, "Name").toUpperCase();
    const frequency = attribute(tag, "Frequency");
    if (!callsign || !name || !frequency) continue;
    definitions.push({ callsign, name, frequency, rule });
  }
  return definitions;
}

export async function loadSectorDefinitions(signal?: AbortSignal): Promise<SectorDefinition[]> {
  const results = await Promise.allSettled(sectorDefinitionSources.map((source) =>
    loadCachedResource({
      cacheKey: `vatsim-sector-definitions-${source.key}-v1`,
      ttlMs: 6 * 60 * 60_000,
      signal,
      load: (requestSignal) => fetchTextWithRetry(source.url, { signal: requestSignal, timeoutMs: 12_000, retries: 1 }),
    }).then((result) => parseSectorDefinitions(result.data, source.rule)),
  ));
  return results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
}

// 频率统一换算成千分之一兆（kHz）整数比较，"131.8" 与 "131.800" 视为相等。
function frequencyValue(frequency: string) {
  const value = Number(frequency);
  return Number.isFinite(value) ? Math.round(value * 1000) : Number.NaN;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 只允许 CTR(6) / APP(5) / DEP(7) 延长扇区。
const duplicatingFacilities = new Set([5, 6, 7]);

// 从管制员 ATIS 里解析「扇区名 + 频率」，为每个被延长的扇区合成一个克隆席位。
// 克隆席位随后走与真实席位完全相同的扇区匹配（applyActive*），因此目标扇区自然点亮。
export function expandDuplicatedControllers(controllers: VatsimController[], definitions: SectorDefinition[]): VatsimController[] {
  if (!definitions.length) return controllers;
  const definitionsByName = new Map(definitions.map((definition) => [definition.name, definition]));
  const clones = new Map<string, VatsimController>();
  for (const controller of controllers) {
    if (!duplicatingFacilities.has(controller.facility)) continue;
    const text = (controller.text_atis ?? []).map((line) => String(line).toUpperCase()).join(" ");
    if (!text) continue;
    const primary = frequencyValue(controller.frequency);
    if (!Number.isFinite(primary)) continue;
    // 本条 ATIS 里显式延长了的扇区（名 → 写入频率），同一扇区取首次出现。
    const extensions = new Map<string, number>();
    for (const [name, definition] of definitionsByName) {
      const writtenFrequency = "(\\d{3}\\.\\d{2,3})";
      const pattern = definition.rule === "ext"
        ? `\\bEXT\\s+${escapeRegExp(name)}\\s+${writtenFrequency}\\b`
        : `\\b(?:EXTENDING\\s+)?${escapeRegExp(name)}\\s+${writtenFrequency}\\b`;
      for (const match of text.matchAll(new RegExp(pattern, "g"))) {
        const written = frequencyValue(match[1]);
        if (Number.isFinite(written) && !extensions.has(name)) extensions.set(name, written);
      }
    }
    if (!extensions.size) continue;
    // 写入频率须等于主用频率或任一被延长扇区的默认频率，否则按主用频率处理；
    // 处理结果等于主用频率时跳过，避免同频重复叠加（namefreq 规则的官方语义）。
    const validFrequencies = new Set<number>([primary]);
    for (const name of extensions.keys()) {
      const definition = definitionsByName.get(name);
      const frequency = definition ? frequencyValue(definition.frequency) : Number.NaN;
      if (Number.isFinite(frequency)) validFrequencies.add(frequency);
    }
    for (const [name, written] of extensions) {
      const definition = definitionsByName.get(name);
      if (!definition || clones.has(definition.callsign)) continue;
      // ext（澳/新）：呼号与频率一律改成目标扇区；namefreq（中/日）：按官方回退规则。
      const resolved = definition.rule === "ext"
        ? frequencyValue(definition.frequency)
        : validFrequencies.has(written) ? written : primary;
      if (resolved === primary) continue;
      clones.set(definition.callsign, { ...controller, callsign: definition.callsign, frequency: (resolved / 1000).toFixed(3), text_atis: null });
    }
  }
  return clones.size ? [...controllers, ...clones.values()] : controllers;
}

function dmsCoordinate(value: string) {
  const sign = value.startsWith("-") ? -1 : 1;
  const digits = value.replace(/^[+-]/, "");
  const degreeLength = digits.length - 4;
  const degrees = Number(digits.slice(0, degreeLength));
  const minutes = Number(digits.slice(degreeLength, degreeLength + 2));
  const seconds = Number(digits.slice(degreeLength + 2));
  return sign * (degrees + minutes / 60 + seconds / 3600);
}

function asEntries(value: unknown): Array<[string, Record<string, unknown>]> {
  if (Array.isArray(value)) return value.map((item, index) => [String((item as Record<string, unknown>).id ?? index), item as Record<string, unknown>]);
  if (value && typeof value === "object") return Object.entries(value as Record<string, Record<string, unknown>>);
  return [];
}

// VATGlasses 的 positions 里没有真实 VATSIM 呼号，只有两个可用字段：
//   pre  —— 席位前缀（ZBAA / ZBPE …）
//   type —— 席位类型（CTR / APP / TWR …）
// 而线上席位呼号恰好是「前缀[_分区]_类型」（ZBAA_CTR / ZBAA_W_CTR / ZBPE_CTR），
// 所以按「首段命中 pre + 末段等于 type」反查即可，不需要维护映射表。
// 生效类型取 owner 链里第一个存在的席位（VATGlasses 语义：靠前的席位优先接管），
// 匹配前缀只收同类型 owner 的前缀 —— 否则 ZBAA_CTR 会把进近扇区一并点亮，
// 让「有进近在线」和「区调代管进近」两种状态在地图上无法区分。
function positionMetadata(owners: string[], positions: Record<string, Record<string, unknown>>) {
  const primary = owners.find((candidate) => positions[candidate]);
  const primaryPosition = primary ? positions[primary] : undefined;
  const type = String(primaryPosition?.type ?? "").toUpperCase();
  const prefixes = new Set<string>();
  for (const candidate of owners) {
    const entry = positions[candidate];
    if (!entry || String(entry.type ?? "").toUpperCase() !== type) continue;
    const pre = Array.isArray(entry.pre) ? entry.pre : typeof entry.pre === "string" ? [entry.pre] : [];
    for (const value of pre) prefixes.add(String(value).toUpperCase());
  }
  return { primary, primaryPosition, type, prefixes: [...prefixes] };
}

// 航路管制（CTR / FSS）画白色填充，进近与塔台（APP / DEP / TWR）画淡绿填充，
// 用一个 band 字段把两族的画法在图层里分开，避免每族各写一套图层。
export function controlBand(type: string) {
  return type === "CTR" || type === "FSS" ? "enroute" : "terminal";
}

function vatGlassesFeatures(airspace: unknown, positions: Record<string, Record<string, unknown>>, ownership?: OwnershipFile) {
  const features: GeoJsonFeatureCollection["features"] = [];
  for (const [key, item] of asEntries(airspace)) {
    const id = String(item.id ?? key);
    const ownershipOwners = ownership?.airspace?.[key] ?? ownership?.airspace?.[id] ?? [];
    const itemOwners = Array.isArray(item.owner) ? item.owner.map(String) : item.parent ? [String(item.parent)] : [];
    const owners = [...ownershipOwners, ...itemOwners];
    const { primary, primaryPosition, type, prefixes } = positionMetadata(owners, positions);
    const colours = primaryPosition?.colours as Array<{ hex?: string }> | undefined;
    const color = colours?.[0]?.hex || "#48d7ff";
    for (const sector of (item.sectors as Array<Record<string, unknown>> | undefined) ?? []) {
      const points = sector.points as Array<[string, string]> | undefined;
      if (!points?.length) continue;
      const coordinates = points.map(([latitude, longitude]) => [dmsCoordinate(longitude), dmsCoordinate(latitude)]).filter(([longitude, latitude]) => Number.isFinite(longitude) && Number.isFinite(latitude));
      if (coordinates.length < 3) continue;
      if (coordinates[0][0] !== coordinates.at(-1)?.[0] || coordinates[0][1] !== coordinates.at(-1)?.[1]) coordinates.push([...coordinates[0]]);
      const minimum = Number(sector.min ?? 0);
      const maximum = Number(sector.max ?? 999);
      const group = String(item.group ?? type ?? "SECTOR");
      const altitude = maximum >= 900 ? `FL${minimum}+` : `FL${minimum}–${maximum}`;
      features.push({ type: "Feature", properties: { id, sectorKey: key, group, min: minimum, max: maximum, color, owner: primary ?? "", ownerKeys: owners, matchType: type, matchPrefixes: prefixes, band: controlBand(type), callsign: primaryPosition?.callsign ?? "", frequency: primaryPosition?.frequency ?? "", label: `${id} · ${altitude}` }, geometry: { type: "Polygon", coordinates: [coordinates] } });
    }
  }
  return { type: "FeatureCollection" as const, features };
}

// 高精度扇区的管制状态同样靠 VATSIM 席位反推：呼号末段即席位类型（CTR/APP/…），
// 首段是站点前缀，两者与被标记扇区的 matchType / matchPrefixes 对齐才算「有管制」。
// 没有席位在线的扇区只留下 active=false，交给图层过滤掉 —— 不填充、不描边，
// 边界线由 FIR 图层统一负责。
// VATGlasses 数据里同一前缀的同类型席位无法互相区分（ZBAA 的 BJE/BJN/BJS/BJW 的 pre 全是 ["ZBAA"]），
// 细分匹配要靠 Sectors.xml 的 Callsign→Name：Name 命中扇区 owner 链的（如 BJE → ZBAA ACC EAST）只点亮该扇区；
// Name 不在任何 owner 链里（如 ZBAA_CTR 的 Name "ZBAA" = 全区）或为某 owner 键的前缀（BJE1→BJE）时按前缀/全区处理；
// 呼号不在定义表里则退回旧行为（点亮同前缀同类型的全部扇区）。
export function applyActiveVatGlassesControllers(collection: GeoJsonFeatureCollection, controllers: VatsimController[], definitions: SectorDefinition[] = []): GeoJsonFeatureCollection {
  const types = collection.features.map((feature) => String(feature.properties.matchType ?? "").toUpperCase());
  const stations = collection.features.map((feature) => {
    const value = feature.properties.matchPrefixes;
    return new Set((Array.isArray(value) ? value : []).map((item) => String(item).toUpperCase()));
  });
  const ownerKeys = collection.features.map((feature) => new Set((((feature.properties.ownerKeys as string[] | undefined) ?? [])).map((item) => String(item).toUpperCase())));
  const definitionsByCallsign = new Map(definitions.map((definition) => [definition.callsign, definition]));
  const activeMatches = new Map<number, string[]>();
  for (const controller of controllers) {
    const segments = controller.callsign.toUpperCase().split("_");
    if (segments.length < 2) continue;
    const type = segments.at(-1) ?? "";
    const station = segments[0];
    const definition = definitionsByCallsign.get(controller.callsign.toUpperCase());
    let sectorName = definition && ownerKeys.some((keys) => keys.has(definition.name)) ? definition.name : "";
    if (definition && !sectorName) {
      // Name 不在 owner 链里：尝试最长前缀匹配（BJE1 → BJE），否则视为全区泛用名，不限定。
      let bestLength = 0;
      for (const keys of ownerKeys) for (const key of keys) {
        if (definition.name.startsWith(key) && key.length > bestLength) { bestLength = key.length; sectorName = key; }
      }
    }
    for (let index = 0; index < types.length; index += 1) {
      if (!type || types[index] !== type || !stations[index].has(station)) continue;
      if (sectorName && !ownerKeys[index].has(sectorName)) continue;
      activeMatches.set(index, [...(activeMatches.get(index) ?? []), controller.callsign]);
    }
  }
  return {
    ...collection,
    features: collection.features.map((feature, index) => {
      const callsigns = activeMatches.get(index) ?? [];
      return { ...feature, properties: { ...feature.properties, active: callsigns.length > 0, activeCallsign: callsigns.join(" / "), activeCallsigns: callsigns } };
    }),
  };
}

// VATGlasses 数据集覆盖不到「进近」的席位，继续用 SimAware 的进近边界兜底。
// 判据只看 terminal 族（APP/DEP/TWR）：某个站点只有在 VATGlasses 里确实有进近/塔台扇区时，
// 才让 SimAware 的同名进近面让位 —— 否则会出现「有 CTR 扇区就把当地进近面也吃掉」的缺口。
// 这份数据没有高度分层，补上 0–999 让高度的 FL 过滤对它恒为真。
export function vatGlassesCoveredStations(collection?: GeoJsonFeatureCollection) {
  const stations = new Set<string>();
  for (const feature of collection?.features ?? []) {
    if (feature.properties.band !== "terminal") continue;
    for (const prefix of (feature.properties.matchPrefixes as string[] | undefined) ?? []) stations.add(String(prefix).toUpperCase());
  }
  return stations;
}

export async function loadVatGlassesDataset(dataset: string, customOwnership?: OwnershipFile, signal?: AbortSignal): Promise<VatGlassesResult> {
  const code = dataset.trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
  if (!code) return { features: emptyCollection(), source: "未选择数据集" };
  const base = `https://raw.githubusercontent.com/lennycolton/vatglasses-data/main/data/${code}`;
  try {
    const [airspacePayload, positionsPayload] = await Promise.all([
      loadCachedJson<{ airspace?: unknown }>(`vatglasses-${code}-airspace-v2`, `${base}/airspace.json`, signal),
      loadCachedJson<{ positions?: Record<string, Record<string, unknown>> }>(`vatglasses-${code}-positions-v2`, `${base}/positions.json`, signal),
    ]);
    const presetOwnership = customOwnership ?? await loadCachedJson<OwnershipFile>(`vatglasses-${code}-ownership-default-v2`, `${base}/ownership/default.json`, signal).catch(() => undefined);
    return { features: vatGlassesFeatures(airspacePayload.airspace, positionsPayload.positions ?? {}, presetOwnership), ownership: presetOwnership, source: `VATGlasses ${code.toUpperCase()}` };
  } catch {
    const payload = await loadCachedJson<{ airspace?: unknown; positions?: Record<string, Record<string, unknown>> }>(`vatglasses-${code}-single-v2`, `${base}.json`, signal);
    return { features: vatGlassesFeatures(payload.airspace, payload.positions ?? {}, customOwnership), ownership: customOwnership, source: `VATGlasses ${code.toUpperCase()}` };
  }
}

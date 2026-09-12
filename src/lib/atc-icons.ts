import type { Map as MapLibreMap } from "maplibre-gl";

// VATSIM Radar 式机场 ATC 站位图标（src/icons/atc/，56×56 @2x）：
//   A=ATIS 自动通播  D=DEL 放行  G=GND 地面  T=TWR 塔台
// 变体：基础（单席位）、-booked（已预约未上线）、-variant-left/right/full（同机场同类型
// 多席位并排时区分位置：2 个 → 左+右，≥3 个 → 两端 left/right + 中间 full）。
const modules = import.meta.glob("../icons/atc/*.png", { import: "default", eager: true }) as Record<string, string>;

type IconVariant = "left" | "right" | "full";
export type AtcIconLetter = "A" | "D" | "G" | "T";

const iconUrls = new Map<string, string>();
for (const [path, url] of Object.entries(modules)) {
  const file = path.replaceAll("\\", "/").split("/").pop() ?? "";
  // 只收 ATC 站位徽章（A/D/G/T）；prefile/arrived 等小三角不属于本图层。
  const match = /^([ADGT])(-booked)?(?:-variant-(left|right|full))?\.png$/i.exec(file);
  if (!match) continue;
  const [, letter, booked, variant] = match;
  iconUrls.set(atcIconId(letter.toUpperCase() as AtcIconLetter, { booked: Boolean(booked), variant: variant?.toLowerCase() as IconVariant | undefined }), url);
}

export function atcIconId(letter: AtcIconLetter, options: { booked?: boolean; variant?: IconVariant } = {}) {
  return `atc-${letter.toLowerCase()}${options.booked ? "-booked" : ""}${options.variant ? `-${options.variant}` : ""}`;
}

// 呼号末段 → 站位字母（ATIS 优先判，因为部分数据源把 ATIS 的 facility 记为 0/OBS）。
const suffixLetters: Record<string, AtcIconLetter> = { ATIS: "A", DEL: "D", GND: "G", TWR: "T" };
// VATSIM facility 编码兜底（末段不标准时用）：2=DEL 3=GND 4=TWR。
const facilityLetters: Record<number, AtcIconLetter> = { 2: "D", 3: "G", 4: "T" };

function validAirportIcao(value: string) { return /^[A-Z0-9]{4}$/.test(value); }

export interface AirportStation {
  icao: string;
  letter: AtcIconLetter;
  /** 真实在线席位的呼号（合成席位为 `${icao}_${suffix}`）。 */
  callsign: string;
  /** VATGlasses 扇区点亮但无真实呼号登录的合成席位。 */
  virtual: boolean;
  /** ATIS 下线 10 分钟内的「残留通播」。 */
  stale: boolean;
  /** 已预约未上线（booked 变体图标）。 */
  booked: boolean;
  frequency: string;
}

// Stale ATIS：ATIS 席位下线后一段时间内仍显示（变灰）。模块级记录最后在线时间。
const ATIS_STALE_MS = 10 * 60_000;
const atisLastSeen = new Map<string, number>();

export function trackAtisStaleness(controllers: Array<{ callsign: string }>, now = Date.now()) {
  for (const controller of controllers) {
    if (/_(ATIS|A)$/i.test(controller.callsign.trim())) atisLastSeen.set(controller.callsign.trim().toUpperCase(), now);
  }
}

export function staleAtisCallsigns(now = Date.now()): string[] {
  const stale: string[] = [];
  for (const [callsign, seen] of atisLastSeen) {
    if (now - seen <= ATIS_STALE_MS) stale.push(callsign); else atisLastSeen.delete(callsign);
  }
  return stale;
}

/**
 * 采集各机场的站位徽标数据：
 * - controllers：VATSIM 实时管制（末段 ATIS/DEL/GND/TWR 判字母，facility 兜底）
 * - vgActivePrefixesByType：VATGlasses 已点亮扇区按类型归组的机场前缀
 *   （TWR 扇区激活但没有 _TWR 呼号登录时也显示 T 图标，其余类型同理）
 * - bookedCallsigns：已预约席位的呼号（无公开数据源时为空，变体逻辑保留）
 * 同机场同类型去重：真实在线优先，其次 stale ATIS，最后 VG 合成席位。
 */
export function collectAirportStations(
  controllers: Array<{ callsign: string; frequency?: string; facility?: number }>,
  vgActivePrefixesByType: Partial<Record<AtcIconLetter, string[]>>,
  bookedCallsigns: string[] = [],
): AirportStation[] {
  type Entry = AirportStation & { priority: number };
  // key=icao:letter 分组；真实在线席位同组可共存多个（供变体并排显示），
  // 合成席位（VG / stale / booked）每组至多一个，且被更高优先级来源覆盖。
  const groups = new Map<string, Entry[]>();
  const add = (station: AirportStation, priority: number, single: boolean) => {
    const key = `${station.icao}:${station.letter}`;
    const members = groups.get(key) ?? [];
    if (single) {
      if (members.some((member) => member.priority >= priority)) return;
      groups.set(key, [...members.filter((member) => member.priority < priority), { ...station, priority }]);
      return;
    }
    if (members.some((member) => member.callsign === station.callsign)) return;
    groups.set(key, [...members, { ...station, priority }]);
  };
  const online = new Set<string>();
  for (const controller of controllers) {
    const callsign = controller.callsign.trim().toUpperCase();
    const segments = callsign.split("_");
    if (segments.length < 2) continue;
    const icao = segments[0];
    const suffix = segments[segments.length - 1];
    let letter = suffixLetters[suffix];
    if (!letter && segments.length === 2) letter = facilityLetters[controller.facility ?? -1];
    if (!letter || !validAirportIcao(icao)) continue;
    online.add(`${icao}:${letter}`);
    add({ icao, letter, callsign, virtual: false, stale: false, booked: false, frequency: controller.frequency ?? "" }, 3, false);
  }
  // VATGlasses：扇区被点亮但没有对应呼号在线 → 合成徽标（VATSIM Radar 的 VG 模式行为）。
  for (const [letter, prefixes] of Object.entries(vgActivePrefixesByType) as Array<[AtcIconLetter, string[]]>) {
    for (const prefix of prefixes) {
      const icao = prefix.trim().toUpperCase();
      if (!validAirportIcao(icao) || online.has(`${icao}:${letter}`)) continue;
      add({ icao, letter, callsign: `${icao}_${letter === "A" ? "ATIS" : letter === "D" ? "DEL" : letter === "G" ? "GND" : "TWR"}`, virtual: true, stale: false, booked: false, frequency: "" }, 1, true);
    }
  }
  // Stale ATIS：仅当该机场当前没有真实 ATIS 在线时显示。
  for (const callsign of staleAtisCallsigns()) {
    const icao = callsign.split("_")[0];
    if (!validAirportIcao(icao) || online.has(`${icao}:A`)) continue;
    add({ icao, letter: "A", callsign, virtual: false, stale: true, booked: false, frequency: "" }, 2, true);
  }
  // Booked：调用方负责按「上线前 1 小时」窗口过滤（VATSIM Radar 行为：booked 在
  // 即将上线时才上地图）；当前无公开预约数据源，逻辑保留、数组默认为空。
  for (const booked of bookedCallsigns) {
    const callsign = booked.trim().toUpperCase();
    const segments = callsign.split("_");
    if (segments.length < 2) continue;
    const icao = segments[0];
    const letter = suffixLetters[segments[segments.length - 1]];
    if (!letter || !validAirportIcao(icao) || online.has(`${icao}:${letter}`)) continue;
    add({ icao, letter, callsign, virtual: false, stale: false, booked: true, frequency: "" }, 0, true);
  }
  return [...groups.values()].flat().map(({ priority: _priority, ...station }) => station);
}

/**
 * 同机场同类型多席位 → 变体分配：1 个用基础徽章；2 个左+右；
 * ≥3 个两端 left/right、中间 full（full 即「完整/单独显示」的徽章形状）。
 */
export function withVariants(stations: AirportStation[]): Array<AirportStation & { icon: string }> {
  const groups = new Map<string, AirportStation[]>();
  for (const station of stations) {
    const key = `${station.icao}:${station.letter}`;
    groups.set(key, [...(groups.get(key) ?? []), station]);
  }
  const result: Array<AirportStation & { icon: string }> = [];
  for (const members of groups.values()) {
    members.sort((first, second) => first.callsign.localeCompare(second.callsign));
    members.forEach((station, index) => {
      const variant: IconVariant | undefined = members.length >= 3
        ? index === 0 ? "left" : index === members.length - 1 ? "right" : "full"
        : members.length === 2 ? (index === 0 ? "left" : "right") : undefined;
      result.push({ ...station, icon: atcIconId(station.letter, { booked: station.booked, variant }) });
    });
  }
  return result;
}

// 低缩放级别的紧凑显示（VATSIM Radar 样式）：机场聚合成「ICAO 代码 + 其下颜色条」，
// 每个在线席位类型一个色段：TWR=红、GND=黄、DEL=橙、ATIS=蓝。
export const atcBarColors: Record<AtcIconLetter, string> = { T: "#e05252", G: "#f2c33d", D: "#e08b3d", A: "#8ab4f8" };
export const atcBarOrder: AtcIconLetter[] = ["T", "G", "D", "A"];

export function airportBarIconId(letters: AtcIconLetter[]) {
  return `atc-bar-${letters.join("")}`;
}

export function airportBarIconSvg(letters: AtcIconLetter[]) {
  const segment = 18;
  const gap = 3;
  const height = 6;
  const width = letters.length * segment + (letters.length - 1) * gap;
  const rects = letters.map((letter, index) => `<rect x="${index * (segment + gap)}" y="0" width="${segment}" height="${height}" rx="2" fill="${atcBarColors[letter]}"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${rects}</svg>`;
}

/** 把颜色条图标按 @2x 光栅化并注册进地图（组合数有限：A/D/G/T 的非空子集，最多 15 个）。 */
export async function ensureAirportBarIcon(map: MapLibreMap, letters: AtcIconLetter[]) {
  const id = airportBarIconId(letters);
  if (map.hasImage(id)) return id;
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(airportBarIconSvg(letters))}`;
  const bitmap = await createImageBitmap(await (await fetch(url)).blob());
  if (!map.hasImage(id)) map.addImage(id, bitmap, { pixelRatio: 2 });
  return id;
}

// 一次性注册全部 ATC 徽章（含 booked 变体，booked 数据源接入后无需再补加载逻辑）。
export function ensureAtcIcons(map: MapLibreMap): Promise<void[]> {
  const jobs: Array<Promise<void>> = [];
  for (const [id, url] of iconUrls) {
    if (map.hasImage(id)) continue;
    jobs.push((async () => {
      const blob = await (await fetch(url)).blob();
      const bitmap = await createImageBitmap(blob);
      if (!map.hasImage(id)) map.addImage(id, bitmap, { pixelRatio: 2 });
    })().catch(() => {}));
  }
  return Promise.all(jobs);
}

/** 供 MapPage 用：无呼号但点击 VG 合成徽标时，详情卡仍能给出可读内容。 */
export function stationLabel(station: AirportStation) {
  return station.virtual ? `${station.callsign}（扇区激活）` : station.callsign;
}

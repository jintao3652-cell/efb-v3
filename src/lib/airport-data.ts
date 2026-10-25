import airportDataUrl from "../../AD_HP.csv?url";
import { getLocalAirports, isTauri, type NaipAirport } from "./tauri";
import type { Airport } from "../types";

function parseCsvLine(line: string) {
  const values: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') { current += '"'; index += 1; }
      else quoted = !quoted;
    } else if (character === "," && !quoted) { values.push(current); current = ""; }
    else current += character;
  }
  values.push(current);
  return values;
}

/**
 * 机场坐标。AD_HP 的 `GEO_LAT_ACCURACY` 是压缩过的度分秒串，实测会出现
 * `N400430.5`（度分秒）、`N4004.5`（度分）、`40.0751`（十进制度）三种写法，
 * 段数按长度判断：经度三位度、纬度两位度。
 */
function parseCoordinate(raw: string) {
  const text = raw.trim().toUpperCase();
  if (!text) return 0;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  const sign = /^[SW]/.test(text) ? -1 : 1;
  const digits = text.replace(/[^0-9.]/g, "");
  const dot = digits.indexOf(".");
  const whole = (dot >= 0 ? digits.slice(0, dot) : digits).replace(/\D/g, "");
  const fraction = dot >= 0 ? `.${digits.slice(dot + 1).replace(/\D/g, "")}` : "";
  if (!whole) return 0;
  const degreeDigits = whole.length >= 7 ? 3 : 2;
  const degrees = Number(whole.slice(0, degreeDigits));
  const minutes = Number(whole.slice(degreeDigits, degreeDigits + 2) || 0);
  const seconds = Number(`${whole.slice(degreeDigits + 2) || 0}${fraction}`);
  const value = degrees + minutes / 60 + seconds / 3600;
  return Number.isFinite(value) ? sign * value : 0;
}

function naipToAirport(row: NaipAirport): Airport {
  const name = row.name.trim() || row.icao;
  return {
    icao: row.icao,
    iata: row.iata,
    name,
    city: name.split("/")[0] || name,
    elevation: row.elevation || "未知",
    international: row.international,
    runways: [],
    frequencies: [],
    latitude: parseCoordinate(row.latitudeRaw),
    longitude: parseCoordinate(row.longitudeRaw),
  };
}

/** 打包在应用里的 AD_HP.csv（示例数据，随包分发，浏览器预览也用它）。 */
async function loadBundledAirports(): Promise<Airport[]> {
  const response = await fetch(airportDataUrl);
  if (!response.ok) throw new Error("无法读取 AD_HP.csv");
  const text = new TextDecoder("gb18030").decode(await response.arrayBuffer());
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  const headers = parseCsvLine(lines[0]);
  const column = (name: string) => headers.indexOf(name);
  const indexes = {
    icao: column("CODE_ID"), name: column("TXT_NAME"), iata: column("CODE_IATA"), elevation: column("VAL_ELEV"),
    elevationUnit: column("UOM_DIST_VER"), latitude: column("GEO_LAT_ACCURACY"), longitude: column("GEO_LONG_ACCURACY"),
    international: column("IS_INTERNATIONAL"),
  };
  return lines.slice(1).map(parseCsvLine).filter((row) => /^Z[A-Z0-9]{3}$/.test(row[indexes.icao] ?? "")).map((row) => {
    const name = row[indexes.name]?.trim() || row[indexes.icao];
    const elevation = row[indexes.elevation]?.trim();
    const elevationUnit = row[indexes.elevationUnit]?.trim() || "M";
    return {
      icao: row[indexes.icao].trim(), iata: row[indexes.iata]?.trim() || "", name, city: name.split("/")[0] || name,
      international: (row[indexes.international] ?? "").trim().toUpperCase() === "Y",
      elevation: elevation ? `${elevation} ${elevationUnit.toLowerCase()}` : "未知", runways: [], frequencies: [],
      latitude: parseCoordinate(row[indexes.latitude] ?? ""), longitude: parseCoordinate(row[indexes.longitude] ?? ""),
    };
  }).filter((airport) => airport.latitude !== 0 && airport.longitude !== 0);
}

/**
 * 国内机场库：桌面端优先读本地数据包里的 AD_HP.csv（随 AIRAC 批次更新，带最新中文名），
 * 没配数据包、或那份 CSV 缺 ICAO 列时，回退到打包在应用里的示例数据。
 */
export async function loadAdHpAirports(): Promise<Airport[]> {
  if (isTauri()) {
    try {
      const rows = await getLocalAirports();
      const airports = rows
        .map(naipToAirport)
        .filter((airport) => /^Z[A-Z0-9]{3}$/.test(airport.icao) && airport.latitude !== 0 && airport.longitude !== 0);
      if (airports.length > 0) return airports;
    } catch {
      // 未配置本地库 / AD_HP 列名不认识：安静回退，不要在设置页外弹错误。
    }
  }
  return loadBundledAirports();
}

export function airportNameMap(airports: Airport[]) {
  return new Map(airports.map((airport) => [airport.icao, airport]));
}

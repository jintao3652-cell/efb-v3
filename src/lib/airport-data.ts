import airportDataUrl from "../../AD_HP.csv?url";
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

function parseDms(value: string) {
  const match = value.trim().match(/^([NSEW])(\d{2,3})(\d{2})(\d{2}(?:\.\d+)?)$/i);
  if (!match) return 0;
  const degrees = Number(match[2]);
  const minutes = Number(match[3]);
  const seconds = Number(match[4]);
  const coordinate = degrees + minutes / 60 + seconds / 3600;
  return /[SW]/i.test(match[1]) ? -coordinate : coordinate;
}

export async function loadAdHpAirports(): Promise<Airport[]> {
  const response = await fetch(airportDataUrl);
  if (!response.ok) throw new Error("无法读取 AD_HP.csv");
  const text = new TextDecoder("gb18030").decode(await response.arrayBuffer());
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  const headers = parseCsvLine(lines[0]);
  const column = (name: string) => headers.indexOf(name);
  const indexes = {
    icao: column("CODE_ID"), name: column("TXT_NAME"), iata: column("CODE_IATA"), elevation: column("VAL_ELEV"),
    elevationUnit: column("UOM_DIST_VER"), latitude: column("GEO_LAT_ACCURACY"), longitude: column("GEO_LONG_ACCURACY"),
  };
  return lines.slice(1).map(parseCsvLine).filter((row) => /^Z[A-Z0-9]{3}$/.test(row[indexes.icao] ?? "")).map((row) => {
    const name = row[indexes.name]?.trim() || row[indexes.icao];
    const elevation = row[indexes.elevation]?.trim();
    const elevationUnit = row[indexes.elevationUnit]?.trim() || "M";
    return {
      icao: row[indexes.icao].trim(), iata: row[indexes.iata]?.trim() || "", name, city: name.split("/")[0] || name,
      elevation: elevation ? `${elevation} ${elevationUnit.toLowerCase()}` : "未知", runways: [], frequencies: [],
      latitude: parseDms(row[indexes.latitude] ?? ""), longitude: parseDms(row[indexes.longitude] ?? ""),
    };
  }).filter((airport) => airport.latitude !== 0 && airport.longitude !== 0);
}

export function airportNameMap(airports: Airport[]) {
  return new Map(airports.map((airport) => [airport.icao, airport]));
}

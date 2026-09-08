export type FlightPlanStatus = "草稿" | "计划中" | "已完成";

export interface FlightPlan {
  id: string;
  callsign: string;
  departure: string;
  arrival: string;
  alternate?: string;
  route: string;
  aircraft: string;
  cruiseAltitude: string;
  etd: string;
  status: FlightPlanStatus;
  updatedAt: string;
}

export interface Airport {
  icao: string;
  iata: string;
  name: string;
  city: string;
  elevation: string;
  runways: string[];
  frequencies: Array<{ name: string; value: string }>;
  latitude: number;
  longitude: number;
}

export interface Chart {
  id: string;
  airport: string;
  category: "机场" | "进场" | "离场" | "航路";
  title: string;
  revision: string;
  cached: boolean;
}

export interface WeatherReport {
  station: string;
  raw: string;
  wind: string;
  visibility: string;
  temperature: string;
  qnh: string;
  observedAt: string;
  source: "实时" | "缓存" | "OpenWeather";
}

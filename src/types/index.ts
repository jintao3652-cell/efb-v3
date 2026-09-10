export interface FlightRoutePoint {
  ident: string;
  name: string;
  latitude: number;
  longitude: number;
}

export interface FlightProcedureSelection {
  name: string;
  transition: string;
  points: FlightRoutePoint[];
}

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
  updatedAt: string;
  importedAt: string;
  routePoints: FlightRoutePoint[];
  departureRunway?: string;
  arrivalRunway?: string;
  sid?: FlightProcedureSelection;
  star?: FlightProcedureSelection;
  approach?: FlightProcedureSelection;
}

export interface FlightPlanAirportPanelData {
  icao: string;
  iata: string;
  name: string;
  city: string;
  vfr: boolean;
  metar: string;
}

export interface FlightPlanData {
  planId: string;
  callsign: string;
  origin: FlightPlanAirportPanelData & {
    runway: string;
    wind: string;
    sid: string;
    transition: string;
  };
  destination: FlightPlanAirportPanelData & {
    runway: string;
    wind: string;
    star: string;
    transition: string;
    approach: string;
    approachesCount: number;
  };
  alternate: FlightPlanAirportPanelData | null;
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
  source: "实时" | "缓存" | "OpenWeather" | "中国气象局航空气象";
  taf: string;
  previewUrl?: string;
}

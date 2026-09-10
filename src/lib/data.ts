import type { Airport, FlightPlan } from "../types";

export const airports: Airport[] = [
  {
    icao: "ZBAA", iata: "PEK", name: "北京首都国际机场", city: "北京", elevation: "116 ft",
    runways: ["18L/36R · 3,810 m", "18R/36L · 3,200 m", "01/19 · 3,800 m"], latitude: 40.0801, longitude: 116.5846,
    frequencies: [{ name: "ATIS", value: "128.65" }, { name: "塔台", value: "118.55" }, { name: "进近", value: "119.00" }],
  },
  {
    icao: "ZSPD", iata: "PVG", name: "上海浦东国际机场", city: "上海", elevation: "13 ft",
    runways: ["17L/35R · 4,000 m", "17R/35L · 3,400 m", "16L/34R · 3,800 m"], latitude: 31.1434, longitude: 121.8052,
    frequencies: [{ name: "ATIS", value: "128.85" }, { name: "塔台", value: "118.70" }, { name: "进近", value: "119.75" }],
  },
  {
    icao: "ZGGG", iata: "CAN", name: "广州白云国际机场", city: "广州", elevation: "50 ft",
    runways: ["01/19 · 3,600 m", "02L/20R · 3,800 m", "02R/20L · 3,600 m"], latitude: 23.3924, longitude: 113.299,
    frequencies: [{ name: "ATIS", value: "127.00" }, { name: "塔台", value: "118.80" }, { name: "进近", value: "119.60" }],
  },
  {
    icao: "ZSHC", iata: "HGH", name: "杭州萧山国际机场", city: "杭州", elevation: "23 ft",
    runways: ["06/24 · 3,600 m", "07/25 · 3,400 m"], latitude: 30.2295, longitude: 120.4345,
    frequencies: [{ name: "ATIS", value: "126.40" }, { name: "塔台", value: "118.15" }, { name: "进近", value: "121.10" }],
  },
];

export const flightPlanTemplate: FlightPlan = {
  id: "", callsign: "", departure: "ZBAA", arrival: "ZSPD", alternate: "",
  route: "", aircraft: "", cruiseAltitude: "",
  etd: "", updatedAt: "", importedAt: "",
  routePoints: [],
};

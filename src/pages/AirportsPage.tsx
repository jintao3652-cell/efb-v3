import { useMemo, useState } from "react";
import { MapPin, Radio, Search } from "lucide-react";
import { airports } from "../lib/data";
import type { Airport } from "../types";

export function AirportsPage() {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Airport>(airports[0]);
  const matches = useMemo(() => airports.filter((airport) => `${airport.icao}${airport.iata}${airport.name}${airport.city}`.toLowerCase().includes(query.toLowerCase())), [query]);
  return <div className="airport-page split-page"><section className="panel list-panel"><div className="search-box"><Search size={18} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 ICAO、IATA、城市或机场" /></div><div className="airport-results">{matches.map((airport) => <button key={airport.icao} className={selected.icao === airport.icao ? "selected" : ""} onClick={() => setSelected(airport)}><span className="airport-code">{airport.icao}</span><span><strong>{airport.name}</strong><small>{airport.city} · {airport.iata}</small></span></button>)}</div></section>
    <section className="airport-detail"><div className="airport-title"><div><p className="eyebrow">{selected.city} · {selected.iata}</p><h2>{selected.icao} {selected.name}</h2></div><MapPin className="accent-icon" size={29} /></div><div className="airport-metrics"><div><span>标高</span><strong>{selected.elevation}</strong></div><div><span>跑道</span><strong>{selected.runways.length} 条</strong></div><div><span>坐标</span><strong>{selected.latitude.toFixed(3)}°</strong></div></div><div className="detail-section"><h3>跑道信息</h3>{selected.runways.map((runway) => <div className="runway" key={runway}><span>RWY</span><strong>{runway}</strong></div>)}</div><div className="detail-section"><h3><Radio size={17} /> 通信频率</h3><div className="frequency-grid">{selected.frequencies.map((frequency) => <div key={frequency.name}><span>{frequency.name}</span><strong>{frequency.value} MHz</strong></div>)}</div></div></section>
  </div>;
}

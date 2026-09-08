import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { LayoutGrid, List, MapPin, Radio, Search } from "lucide-react";
import { AirportGroundMap } from "../components/airport/AirportGroundMap";
import { airports } from "../lib/data";
import { getNavigationAirportDetails, getNavigationDatabaseStatus, searchNavigationAirports } from "../lib/tauri";
import type { Airport } from "../types";

type AirportTab = "overview" | "ground";

export function AirportsPage() {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Airport>(airports[0]);
  const [tab, setTab] = useState<AirportTab>("overview");
  const [selectedStand, setSelectedStand] = useState("G04");
  const navigation = useQuery({ queryKey: ["navigation-database"], queryFn: getNavigationDatabaseStatus, retry: 0 });
  const navigationAirports = useQuery({ queryKey: ["navigation-airports", query], queryFn: () => searchNavigationAirports(query), enabled: navigation.data?.ready, retry: 0 });
  const databaseAirports = useMemo<Airport[]>(() => (navigationAirports.data ?? []).map((airport) => ({ ...airport, runways: [], frequencies: [] })), [navigationAirports.data]);
  const usingDatabaseAirport = databaseAirports.some((airport) => airport.icao === selected.icao);
  const airportDetails = useQuery({
    queryKey: ["navigation-airport-details", selected.icao],
    queryFn: () => getNavigationAirportDetails(selected.icao),
    enabled: Boolean(navigation.data?.ready && usingDatabaseAirport),
    retry: 0,
  });
  const activeAirports = databaseAirports.length ? databaseAirports : airports;
  const matches = useMemo(() => activeAirports.filter((airport) => `${airport.icao}${airport.iata}${airport.name}${airport.city}`.toLowerCase().includes(query.toLowerCase())), [activeAirports, query]);
  const runways = usingDatabaseAirport ? airportDetails.data?.runways ?? [] : selected.runways;
  const frequencies = usingDatabaseAirport ? airportDetails.data?.frequencies ?? [] : selected.frequencies;

  useEffect(() => {
    if (databaseAirports.length && !databaseAirports.some((airport) => airport.icao === selected.icao)) setSelected(databaseAirports[0]);
  }, [databaseAirports, selected.icao]);

  const chooseAirport = (airport: Airport) => { setSelected(airport); setSelectedStand("G04"); };
  const sourceName = navigation.data?.source === "fenix" ? "Fenix" : "Little Navmap";
  const sourceLabel = navigation.data?.ready ? `${sourceName} · AIRAC ${navigation.data.airacCycle ?? "未知"}` : "内置演示数据";

  return <div className="airport-page split-page">
    <section className="panel list-panel">
      <div className="search-box"><Search size={18} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 ICAO、IATA、城市或机场" /></div>
      <p className="airport-source-label">{navigationAirports.isFetching ? `正在搜索 ${sourceName}…` : sourceLabel}</p>
      <div className="airport-results">
        {matches.map((airport) => <button key={airport.icao} className={selected.icao === airport.icao ? "selected" : ""} onClick={() => chooseAirport(airport)}><span className="airport-code">{airport.icao}</span><span><strong>{airport.name || airport.icao}</strong><small>{airport.city} · {airport.iata}</small></span></button>)}
        {navigationAirports.isError && <p className="chartfox-state error">{navigationAirports.error.message}</p>}
      </div>
    </section>
    <section className="airport-detail">
      <div className="airport-title"><div><p className="eyebrow">{selected.city} · {selected.iata}</p><h2>{selected.icao} {selected.name}</h2></div><MapPin className="accent-icon" size={29} /></div>
      <div className="airport-tabs"><button className={tab === "overview" ? "active" : ""} onClick={() => setTab("overview")}><List size={16} />机场资料</button><button className={tab === "ground" ? "active" : ""} onClick={() => setTab("ground")}><LayoutGrid size={16} />停机位图</button></div>
      {tab === "overview" ? <>
        <div className="airport-metrics"><div><span>标高</span><strong>{selected.elevation}</strong></div><div><span>跑道</span><strong>{airportDetails.isFetching ? "读取中" : runways.length ? `${runways.length} 条` : "待解析"}</strong></div><div><span>坐标</span><strong>{selected.latitude.toFixed(3)}°</strong></div></div>
        <div className="detail-section"><h3>跑道信息</h3>{runways.length ? runways.map((runway) => <div className="runway" key={runway}><span>RWY</span><strong>{runway}</strong></div>) : <p className="empty-data">{usingDatabaseAirport ? "当前数据库未提供可匹配的跑道字段。" : "演示数据未提供跑道信息。"}</p>}</div>
        <div className="detail-section"><h3><Radio size={17} /> 通信频率</h3>{frequencies.length ? <div className="frequency-grid">{frequencies.map((frequency, index) => <div key={`${frequency.name}-${frequency.value}-${index}`}><span>{frequency.name}</span><strong>{frequency.value} MHz</strong></div>)}</div> : <p className="empty-data">{usingDatabaseAirport ? "当前数据库未提供可匹配的机场通信数据。" : "暂无通信频率数据。"}</p>}</div>
      </> : <AirportGroundMap airport={selected} selectedStand={selectedStand} onSelectStand={setSelectedStand} />}
    </section>
  </div>;
}

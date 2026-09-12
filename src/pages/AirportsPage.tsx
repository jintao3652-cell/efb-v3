import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, FileImage, LayoutGrid, List, MapPin, Radio, Search } from "lucide-react";
import { AirportGroundMap } from "../components/airport/AirportGroundMap";
import { loadAdHpAirports } from "../lib/airport-data";
import { airports } from "../lib/data";
import { getNavigationAirportDetails, getNavigationDatabaseStatus, getXflyAirportData, searchNavigationAirports, type XflyAirportData } from "../lib/tauri";
import type { Airport } from "../types";

type AirportTab = "overview" | "ground" | "charts";
type XflyRunway = XflyAirportData["runways"][number];

const runwayLabel = (runway: XflyRunway) => {
  const metres = Number(runway.lengthFt) * 0.3048;
  return `${runway.leIdent}/${runway.heIdent} · ${Number.isFinite(metres) ? `${metres.toFixed(0)} m` : `${runway.lengthFt} ft`} · ${runway.surface}`;
};

export function AirportsPage() {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Airport>(airports[0]);
  const [tab, setTab] = useState<AirportTab>("overview");
  const [selectedStand, setSelectedStand] = useState("");
  const adHp = useQuery({ queryKey: ["ad-hp-airports"], queryFn: loadAdHpAirports, staleTime: Infinity });
  const navigation = useQuery({ queryKey: ["navigation-database"], queryFn: getNavigationDatabaseStatus, retry: 0 });
  const navigationAirports = useQuery({ queryKey: ["navigation-airports", query], queryFn: () => searchNavigationAirports(query), enabled: navigation.data?.ready, retry: 0 });
  const adHpByIcao = useMemo(() => new Map((adHp.data ?? []).map((airport) => [airport.icao, airport])), [adHp.data]);
  const databaseAirports = useMemo<Airport[]>(() => (navigationAirports.data ?? []).map((airport) => {
    const chinese = airport.icao.startsWith("Z") ? adHpByIcao.get(airport.icao) : undefined;
    return { ...airport, ...(chinese ? { name: chinese.name, city: chinese.city, iata: chinese.iata || airport.iata, elevation: chinese.elevation } : {}), runways: [], frequencies: [] };
  }), [navigationAirports.data, adHpByIcao]);
  const allAirports = useMemo(() => {
    const merged = new Map<string, Airport>();
    [...airports, ...(adHp.data ?? []), ...databaseAirports].forEach((airport) => merged.set(airport.icao, airport));
    return [...merged.values()];
  }, [adHp.data, databaseAirports]);
  const usingDatabaseAirport = databaseAirports.some((airport) => airport.icao === selected.icao);
  const airportDetails = useQuery({ queryKey: ["navigation-airport-details", selected.icao], queryFn: () => getNavigationAirportDetails(selected.icao), enabled: Boolean(navigation.data?.ready && usingDatabaseAirport), retry: 0 });
  const xfly = useQuery({ queryKey: ["xfly-airport", selected.icao], queryFn: () => getXflyAirportData(selected.icao), enabled: selected.icao.length === 4, retry: 0, staleTime: 10 * 60_000 });
  const matches = useMemo(() => allAirports.filter((airport) => `${airport.icao}${airport.iata}${airport.name}${airport.city}`.toLowerCase().includes(query.toLowerCase())).slice(0, 120), [allAirports, query]);
  const runways = xfly.data?.runways.length ? xfly.data.runways.map(runwayLabel) : usingDatabaseAirport ? airportDetails.data?.runways ?? [] : selected.runways;
  const frequencies = xfly.data?.frequencies.length ? xfly.data.frequencies.map((frequency) => ({ name: `${frequency.frequencyType} · ${frequency.description}`, value: frequency.frequencyMhz })) : usingDatabaseAirport ? airportDetails.data?.frequencies ?? [] : selected.frequencies;

  useEffect(() => { const chinese = adHpByIcao.get(selected.icao); if (chinese && selected.name !== chinese.name) setSelected((current) => ({ ...current, ...chinese })); }, [adHpByIcao, selected.icao, selected.name]);

  const chooseAirport = (airport: Airport) => { setSelected(airport); setSelectedStand(""); setTab("overview"); };
  const sourceName = navigation.data?.source === "fenix" ? "Fenix" : "Little Navmap";
  const sourceLabel = navigation.data?.ready ? `${sourceName} · 国内机场名称由 AD_HP.csv 覆盖` : `AD_HP.csv · ${adHp.data?.length ?? 0} 个国内机场`;

  return <div className="airport-page split-page">
    <section className="panel list-panel"><div className="search-box"><Search size={18} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 ICAO、IATA、城市或机场" /></div><p className="airport-source-label">{navigationAirports.isFetching || adHp.isFetching ? "正在读取机场数据…" : sourceLabel}</p><div className="airport-results">{matches.map((airport) => <button key={airport.icao} className={selected.icao === airport.icao ? "selected" : ""} onClick={() => chooseAirport(airport)}><span className="airport-code">{airport.icao}</span><span><strong>{airport.name || airport.icao}</strong><small>{airport.city}{airport.iata ? ` · ${airport.iata}` : ""}</small></span></button>)}{navigationAirports.isError && <p className="chartfox-state error">{navigationAirports.error.message}</p>}</div></section>
    <section className="airport-detail"><div className="airport-title"><div><p className="eyebrow">{selected.city}{selected.iata ? ` · ${selected.iata}` : ""}</p><h2>{selected.icao}</h2><h3>{selected.name}</h3></div><MapPin className="accent-icon" size={29} /></div><div className="airport-tabs"><button className={tab === "overview" ? "active" : ""} onClick={() => setTab("overview")}><List size={16} />机场资料</button><button className={tab === "ground" ? "active" : ""} onClick={() => setTab("ground")}><LayoutGrid size={16} />机位地图</button><button className={tab === "charts" ? "active" : ""} onClick={() => setTab("charts")}><FileImage size={16} />航图 ({xfly.data?.charts.length ?? 0})</button></div>
      {tab === "overview" ? <><div className="airport-metrics"><div><span>标高</span><strong>{selected.elevation}</strong></div><div><span>跑道</span><strong>{xfly.isFetching || airportDetails.isFetching ? "读取中" : runways.length ? `${runways.length} 条` : "暂无"}</strong></div><div><span>坐标</span><strong>{selected.latitude.toFixed(3)}°, {selected.longitude.toFixed(3)}°</strong></div></div><div className="detail-section"><h3>跑道信息</h3>{runways.length ? runways.map((runway) => <div className="runway" key={runway}><span>RWY</span><strong>{runway}</strong></div>) : <p className="empty-data">暂无跑道数据。</p>}</div><div className="detail-section"><h3><Radio size={17} /> 通信频率</h3>{frequencies.length ? <div className="frequency-grid">{frequencies.map((frequency, index) => <div key={`${frequency.name}-${frequency.value}-${index}`}><span>{frequency.name}</span><strong>{frequency.value} MHz</strong></div>)}</div> : <p className="empty-data">暂无通信频率数据。</p>}</div>{xfly.data?.unavailable.length ? <p className="chartfox-state error">{xfly.data.source}；暂缺：{xfly.data.unavailable.join("、")}。其余接口数据仍可使用。</p> : null}{xfly.isError && <p className="chartfox-state error">XFlySim API 暂不可用，已显示本地数据。</p>}</>
        : tab === "ground" ? <>{xfly.isFetching && <p className="empty-data">正在读取机位与跑道坐标…</p>}<AirportGroundMap airport={selected} data={xfly.data} selectedStand={selectedStand} onSelectStand={setSelectedStand} /></>
        : <div className="airport-chart-grid">{xfly.isFetching && <p className="empty-data">正在读取航图目录…</p>}{xfly.data?.charts.map((chart) => <a key={chart.id} className="airport-chart-card" href={chart.imageDayUrl} target="_blank" rel="noreferrer"><img src={chart.thumbDayUrl || chart.imageDayUrl} alt={chart.name} loading="lazy" /><span><strong>{chart.indexNumber} · {chart.name}</strong><small>{chart.category} · 修订 {chart.revisionDate || "未知"}</small></span><ExternalLink size={15} /></a>)}{!xfly.isFetching && !xfly.data?.charts.length && <p className="empty-data">此机场暂无在线航图。</p>}</div>}
    </section>
  </div>;
}

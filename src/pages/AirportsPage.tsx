import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ExternalLink, FileImage, LayoutGrid, List, MapPin, Radio, Search } from "lucide-react";
import { AirportGroundMap } from "../components/airport/AirportGroundMap";
import { loadAdHpAirports } from "../lib/airport-data";
import { airports } from "../lib/data";
import { getNavigationAirportDetails, getNavigationDatabaseStatus, getXflyAirportData, getXflyChartThumbnail, isTauri, searchNavigationAirports, type XflyAirportData } from "../lib/tauri";
import type { Airport } from "../types";

type AirportTab = "overview" | "ground" | "charts";
type XflyRunway = XflyAirportData["runways"][number];
type XflyChart = XflyAirportData["charts"][number];
type AirportChartCategory = "STAR" | "APP" | "TAXI" | "SID" | "REF";

const airportChartCategories: Array<{ id: AirportChartCategory; label: string; description: string }> = [
  { id: "STAR", label: "STAR", description: "标准仪表进场程序" },
  { id: "APP", label: "APP", description: "仪表与目视进近程序" },
  { id: "TAXI", label: "TAXI", description: "机场图、停机位与滑行资料" },
  { id: "SID", label: "SID", description: "标准仪表离场程序" },
  { id: "REF", label: "REF", description: "机场简报、运行限制与参考资料" },
];

function categoryForAirportChart(chart: XflyChart): AirportChartCategory {
  const sourceCategory = chart.category.trim().toUpperCase();
  const title = chart.name.toUpperCase();

  if (sourceCategory === "ARR" || sourceCategory === "STAR") return "STAR";
  if (sourceCategory === "APP") return "APP";
  if (sourceCategory === "DEP" || sourceCategory === "SID") return "SID";
  if (sourceCategory === "TAXI") return "TAXI";
  if (sourceCategory === "REF") return "REF";

  // XFlySim 的 APT 同时包含机场地面图和机场简报，不能直接归为同一类。
  if (sourceCategory === "APT") {
    return /^(AIRPORT|AERODROME)(?:\s+(?:CHART|DIAGRAM))?$|\b(PARKING|STANDS?|TAXI|TAXIWAY|APRON|GROUND|HOT\s*SPOTS?)\b/.test(title)
      ? "TAXI"
      : "REF";
  }

  if (/\b(ARRIVALS?|ARRS?|STAR)\b/.test(title)) return "STAR";
  if (/\b(DEPARTURES?|DEPS?|SID)\b/.test(title)) return "SID";
  if (/\b(APPROACH|ILS|LOC|VOR|NDB|TACAN|RNP|RNAV|VISUAL)\b.*\bRWY\b|\bIAC\b/.test(title)) return "APP";
  if (/^(AIRPORT|AERODROME)(?:\s+(?:CHART|DIAGRAM))?$|\b(PARKING|STANDS?|TAXI|TAXIWAY|APRON|GROUND|HOT\s*SPOTS?)\b/.test(title)) return "TAXI";
  return "REF";
}

function AirportChartThumbnail({ chart }: { chart: XflyChart }) {
  const remoteSources = useMemo(() => [...new Set([chart.thumbDayUrl, chart.imageDayUrl, chart.thumbNightUrl, chart.imageNightUrl].filter(Boolean))], [chart.imageDayUrl, chart.imageNightUrl, chart.thumbDayUrl, chart.thumbNightUrl]);
  const [sourceIndex, setSourceIndex] = useState(0);
  const [cachedSource, setCachedSource] = useState("");
  const [cacheAttempted, setCacheAttempted] = useState(false);
  const [cacheLoading, setCacheLoading] = useState(false);

  useEffect(() => {
    setSourceIndex(0);
    setCachedSource("");
    setCacheAttempted(false);
    setCacheLoading(false);
  }, [chart.id]);

  const currentSource = cachedSource || remoteSources[sourceIndex];
  const handleImageError = () => {
    if (cachedSource) {
      setCachedSource("");
      setSourceIndex((index) => index + 1);
      return;
    }
    if (isTauri() && !cacheAttempted) {
      setCacheAttempted(true);
      setCacheLoading(true);
      getXflyChartThumbnail(chart.id, chart.revisionDate, remoteSources)
        .then((path) => setCachedSource(convertFileSrc(path)))
        .catch(() => setSourceIndex((index) => index + 1))
        .finally(() => setCacheLoading(false));
      return;
    }
    setSourceIndex((index) => index + 1);
  };

  if (cacheLoading) {
    return <div className="airport-chart-thumbnail loading" aria-label="正在加载航图缩略图"><FileImage size={22} /><small>加载中</small></div>;
  }

  if (!currentSource) {
    return <div className="airport-chart-thumbnail empty" aria-label="无可用缩略图"><FileImage size={22} /><small>无预览</small></div>;
  }

  return <div className="airport-chart-thumbnail"><img src={currentSource} alt={`${chart.name} 航图缩略图`} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={handleImageError} /></div>;
}

const runwayLabel = (runway: XflyRunway) => {
  const metres = Number(runway.lengthFt) * 0.3048;
  return `${runway.leIdent}/${runway.heIdent} · ${Number.isFinite(metres) ? `${metres.toFixed(0)} m` : `${runway.lengthFt} ft`} · ${runway.surface}`;
};

export function AirportsPage() {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Airport>(airports[0]);
  const [tab, setTab] = useState<AirportTab>("overview");
  const [selectedStand, setSelectedStand] = useState("");
  const [chartFilter, setChartFilter] = useState<AirportChartCategory>("STAR");
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
  const chartSections = useMemo(() => airportChartCategories.map((category) => ({
    ...category,
    charts: (xfly.data?.charts ?? []).filter((chart) => categoryForAirportChart(chart) === category.id).sort((first, second) => first.indexNumber.localeCompare(second.indexNumber, undefined, { numeric: true })),
  })), [xfly.data?.charts]);
  const visibleChartSections = chartSections.filter((section) => section.id === chartFilter);

  useEffect(() => { const chinese = adHpByIcao.get(selected.icao); if (chinese && selected.name !== chinese.name) setSelected((current) => ({ ...current, ...chinese })); }, [adHpByIcao, selected.icao, selected.name]);

  const chooseAirport = (airport: Airport) => { setSelected(airport); setSelectedStand(""); setChartFilter("STAR"); setTab("overview"); };
  const sourceName = navigation.data?.source === "fenix" ? "Fenix" : "Little Navmap";
  const sourceLabel = navigation.data?.ready ? `${sourceName} · 国内机场名称由 AD_HP.csv 覆盖` : `AD_HP.csv · ${adHp.data?.length ?? 0} 个国内机场`;

  return <div className="airport-page split-page">
    <section className="panel list-panel"><div className="search-box"><Search size={18} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 ICAO、IATA、城市或机场" /></div><p className="airport-source-label">{navigationAirports.isFetching || adHp.isFetching ? "正在读取机场数据…" : sourceLabel}</p><div className="airport-results">{matches.map((airport) => <button key={airport.icao} className={selected.icao === airport.icao ? "selected" : ""} onClick={() => chooseAirport(airport)}><span className="airport-code">{airport.icao}</span><span><strong>{airport.name || airport.icao}</strong><small>{airport.city}{airport.iata ? ` · ${airport.iata}` : ""}</small></span></button>)}{navigationAirports.isError && <p className="chartfox-state error">{navigationAirports.error.message}</p>}</div></section>
    <section className="airport-detail"><div className="airport-title"><div><p className="eyebrow">{selected.city}{selected.iata ? ` · ${selected.iata}` : ""}</p><h2>{selected.icao}</h2><h3>{selected.name}</h3></div><MapPin className="accent-icon" size={29} /></div><div className="airport-tabs"><button className={tab === "overview" ? "active" : ""} onClick={() => setTab("overview")}><List size={16} />机场资料</button><button className={tab === "ground" ? "active" : ""} onClick={() => setTab("ground")}><LayoutGrid size={16} />机位地图</button><button className={tab === "charts" ? "active" : ""} onClick={() => setTab("charts")}><FileImage size={16} />航图 ({xfly.data?.charts.length ?? 0})</button></div>
      {tab === "overview" ? <><div className="airport-metrics"><div><span>标高</span><strong>{selected.elevation}</strong></div><div><span>跑道</span><strong>{xfly.isFetching || airportDetails.isFetching ? "读取中" : runways.length ? `${runways.length} 条` : "暂无"}</strong></div><div><span>坐标</span><strong>{selected.latitude.toFixed(3)}°, {selected.longitude.toFixed(3)}°</strong></div></div><div className="detail-section"><h3>跑道信息</h3>{runways.length ? runways.map((runway) => <div className="runway" key={runway}><span>RWY</span><strong>{runway}</strong></div>) : <p className="empty-data">暂无跑道数据。</p>}</div><div className="detail-section"><h3><Radio size={17} /> 通信频率</h3>{frequencies.length ? <div className="frequency-grid">{frequencies.map((frequency, index) => <div key={`${frequency.name}-${frequency.value}-${index}`}><span>{frequency.name}</span><strong>{frequency.value} MHz</strong></div>)}</div> : <p className="empty-data">暂无通信频率数据。</p>}</div>{xfly.data?.unavailable.length ? <p className="chartfox-state error">{xfly.data.source}；暂缺：{xfly.data.unavailable.join("、")}。其余接口数据仍可使用。</p> : null}{xfly.isError && <p className="chartfox-state error">XFlySim API 暂不可用，已显示本地数据。</p>}</>
        : tab === "ground" ? <>{xfly.isFetching && <p className="empty-data">正在读取机位与跑道坐标…</p>}<AirportGroundMap airport={selected} data={xfly.data} selectedStand={selectedStand} onSelectStand={setSelectedStand} /></>
        : <div className="airport-chart-browser">
          {xfly.isFetching && <p className="empty-data">正在读取航图目录…</p>}
          {!!xfly.data?.charts.length && <div className="airport-chart-filters" aria-label="按航图用途筛选">
            {airportChartCategories.map((category) => <button key={category.id} data-category={category.id} className={chartFilter === category.id ? "active" : ""} onClick={() => setChartFilter(category.id)}>{category.label}</button>)}
          </div>}
          {visibleChartSections.map((section) => <section className="airport-chart-section" key={section.id}>
            <header><div><strong>{section.label}</strong><span>{section.description}</span></div><em>{section.charts.length} 份</em></header>
            <div className="airport-chart-grid">{section.charts.map((chart) => <a key={chart.id} className="airport-chart-card" href={chart.imageDayUrl} target="_blank" rel="noreferrer"><AirportChartThumbnail chart={chart} /><span><strong>{chart.indexNumber} · {chart.name}</strong><small>{section.label} · 修订 {chart.revisionDate || "未知"}</small></span><ExternalLink size={15} /></a>)}</div>
          </section>)}
          {!xfly.isFetching && !!xfly.data?.charts.length && visibleChartSections.every((section) => section.charts.length === 0) && <p className="empty-data">{chartFilter} 分类暂无航图。</p>}
          {!xfly.isFetching && !xfly.data?.charts.length && <p className="empty-data">此机场暂无在线航图。</p>}
        </div>}
    </section>
  </div>;
}

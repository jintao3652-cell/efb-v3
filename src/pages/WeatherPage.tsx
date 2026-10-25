import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { CloudSun, Compass, Eye, Gauge, Languages, Radio, RefreshCw, Search, Star, Thermometer, Wind } from "lucide-react";
import { categoryFor, parseMetar, parseTaf, temperatureLabel, visibilityLabel, weatherSummary, windLabel, type FlightCategory } from "../lib/metar";
import { loadStationWeather, weatherSourceOptions, weatherRegion, weatherRegionLabel, weatherSourceLabel } from "../lib/weather";
import { loadAdHpAirports } from "../lib/airport-data";
import { airports as fallbackAirports } from "../lib/data";
import { useAppStore } from "../stores/app-store";

const FIXED_KEY = "skyboard-efb-fixed-stations";

function readFixed(): string[] {
  try {
    const raw = localStorage.getItem(FIXED_KEY);
    if (raw) return JSON.parse(raw) as string[];
  } catch { /* 忽略损坏的本地配置 */ }
  return ["ZSAM", "ZPLJ", "ZSQZ"];
}

export function WeatherPage() {
  const [searchParams] = useSearchParams();
  const [station, setStation] = useState((searchParams.get("icao") ?? "ZBAA").toUpperCase());
  const [input, setInput] = useState("");
  const [fixed, setFixed] = useState<string[]>(readFixed);
  const catalog = useQuery({ queryKey: ["ad-hp-airports"], queryFn: loadAdHpAirports, staleTime: Infinity });
  const airports = catalog.data ?? fallbackAirports;
  const weatherSourceCn = useAppStore((state) => state.weatherSourceCn);
  const weatherSourceIntl = useAppStore((state) => state.weatherSourceIntl);
  const setWeatherSource = useAppStore((state) => state.setWeatherSource);

  useEffect(() => { localStorage.setItem(FIXED_KEY, JSON.stringify(fixed)); }, [fixed]);

  // 中国机场与境外机场各有一套数据源偏好，页面按当前 ICAO 自动选用。
  // caac 依赖本机后端，浏览器预览里不可选，存了也会退回自动。
  const sources = useMemo(() => weatherSourceOptions(), []);
  const region = weatherRegion(station);
  const stored = region === "cn" ? weatherSourceCn : weatherSourceIntl;
  const preference = sources.some((option) => option.id === stored) ? stored : "auto";

  const weather = useQuery({
    queryKey: ["station-weather", station, preference],
    queryFn: () => loadStationWeather(station, { preference }),
    retry: 1,
    staleTime: 4 * 60_000,
    // 切换数据源时保留上一份报文，避免 NAIP 这种慢源把整页刷成空白。
    placeholderData: (previous) => previous,
  });

  const parsed = useMemo(() => (weather.data?.raw ? parseMetar(weather.data.raw) : null), [weather.data]);
  const taf = useMemo(() => (weather.data?.taf ? parseTaf(weather.data.taf) : null), [weather.data]);
  const sourceCategory = weather.data?.flightCategory;
  const category: FlightCategory | null = parsed
    ? categoryFor(parsed.visibility.meters, parsed.clouds.layers.find((layer) => /BKN|OVC|VV/.test(layer.amount))?.base ?? null)
    : (["VFR", "MVFR", "IFR", "LIFR"] as FlightCategory[]).includes(sourceCategory as FlightCategory) ? sourceCategory as FlightCategory : null;
  const airport = airports.find((item) => item.icao === station);
  const matches = input.trim()
    ? airports.filter((item) => `${item.icao}${item.iata}${item.name}${item.city}`.toUpperCase().includes(input.trim().toUpperCase())).slice(0, 5)
    : [];

  const pick = (icao: string) => { setStation(icao); setInput(""); };
  const toggleFixed = () => setFixed((list) => list.includes(station) ? list.filter((item) => item !== station) : [...list, station]);
  // 数据源自带中文摘要（NAIP weather_desc）时优先用它，比只报「无显著天气」更有信息量。
  const summary = weather.data?.summary
    ?? (parsed ? [weatherSummary(parsed.weather.codes).replace("无重要天气", "无显著天气"), parsed.wind.gust ? "风速较大" : ""].filter(Boolean).join("，") : "正在获取观测…");
  const decodedMetar = weather.data?.decodedMetar ?? [];
  const decodedTaf = weather.data?.decodedTaf ?? [];

  return <div className="page wx-page">
    <aside className="page-panel">
      <div className="panel-head"><span className="side-mark" /><h2>气象</h2><button className="icon-btn" onClick={() => weather.refetch()} aria-label="刷新"><RefreshCw size={14} className={weather.isFetching ? "spinning" : ""} /></button></div>
      <div className="panel-body">
        <div className="wx-station-group" style={{ marginTop: 0 }}>
          <label>机场</label>
          <div className="wx-search-card">
            <div className="row"><Search size={14} /><input value={input} onChange={(event) => setInput(event.target.value)} placeholder="查询 METAR / TAF" /></div>
            {input.trim() && <div style={{ marginTop: 6 }}>
              {matches.length === 0 && <p className="muted" style={{ fontSize: 11, padding: "4px 2px" }}>无匹配机场</p>}
              {matches.map((item) => <button key={item.icao} className="wx-station" onClick={() => pick(item.icao)}>
                <strong>{item.icao}</strong><small>{item.name}</small>
              </button>)}
            </div>}
          </div>
          <div className="wx-current">
            <div>
              <strong>{station}</strong>
              <small>{airport ? `${airport.name} · ${airport.city}` : weatherRegionLabel(region)}</small>
            </div>
            <button className={fixed.includes(station) ? "active" : ""} onClick={toggleFixed} aria-label="固定机场"><Star size={14} /></button>
          </div>
        </div>

        <div className="wx-station-group">
          <label>固定机场</label>
          {fixed.map((icao) => {
            const item = airports.find((entry) => entry.icao === icao);
            return <button key={icao} className={`wx-station ${station === icao ? "active" : ""}`} onClick={() => setStation(icao)}>
              <span className="wx-pin"><Radio size={13} /></span>
              <span className="grow"><strong>{icao} {item?.city ?? ""}</strong><small>{item?.name ?? ""}</small></span>
            </button>;
          })}
        </div>

        <div className="wx-station-group">
          <label>数据来源 · {weatherRegionLabel(region)}</label>
          <div className="wx-source-pick">
            {sources.map((option) => <button
              key={option.id}
              className={preference === option.id ? "active" : ""}
              onClick={() => setWeatherSource(region, option.id)}
              title={option.detail}
            >{option.short}</button>)}
          </div>
          <div className="wx-source" style={{ marginTop: 8 }}>
            <CloudSun size={15} />
            <div>
              <strong>{weather.data?.source ?? (weather.isError ? "气象源不可用" : "正在连接气象源")}</strong>
              <small>{weather.data?.fallbackNote
                ?? (weather.data?.observedAt ? `观测 ${weather.data.observedAt} · ${weather.data.taf ? "含 TAF" : "无 TAF"}` : "METAR 与 TAF 同源，报文与解析并列展示")}</small>
            </div>
          </div>
          <p className="wx-source-note">{sources.find((option) => option.id === preference)?.detail}</p>
        </div>
      </div>
    </aside>

    <div className="content">
      <div className="content-inner">
        <section className="wx-hero">
          <header>
            <div className="wx-hero-mark"><Wind size={22} /></div>
            <div className="grow">
              <h1>{station}{parsed?.observation ? <em>· {parsed.observation}</em> : null}</h1>
              <p>{summary}</p>
            </div>
            <div className="wx-hero-right">
              {category && <span className={`vfr-badge ${category.toLowerCase()}`}>{category}<small>{category === "VFR" ? "目视飞行" : category === "MVFR" ? "边缘目视" : "仪表飞行"}</small></span>}
              {parsed?.wind.gust ? <span className="wx-flag">强风</span> : null}
              <small className="wx-cache">{weather.isFetching ? "正在同步" : weather.data?.observedAt ? `观测 ${weather.data.observedAt}` : "等待观测"}</small>
            </div>
          </header>
          <div className="wx-hero-grid">
            <div><span>地面风</span><strong>{parsed ? windLabel(parsed.wind) : "—"}</strong></div>
            <div><span>主导能见度</span><strong>{parsed ? visibilityLabel(parsed.visibility.meters) : "—"}</strong></div>
            <div><span>气压</span><strong>{parsed?.qnh ? `${parsed.qnh} hPa` : "—"}</strong></div>
          </div>
        </section>

        {weather.isError && <div className="notice" style={{ marginTop: 14 }}><div><strong>气象数据不可用</strong><p>{(weather.error as Error).message}</p></div></div>}
        {weather.data?.fallbackNote && <div className="notice" style={{ marginTop: 14 }}>
          <div><strong>已自动换源</strong><p>{weather.data.fallbackNote}</p></div>
        </div>}

        <section className="wx-block">
          <h3><CloudSun size={14} />METAR<span className="badge gray">{weather.data?.source ?? "当前机场观测"}</span></h3>
          <div className="wx-raw-card">
            <div className="wx-raw-head"><span>METAR 原始报文</span><span>原始</span></div>
            <p className="wx-raw">{weather.data?.raw ?? "—"}</p>
          </div>
          <h3 style={{ marginTop: 14 }}><Compass size={14} />METAR 解析结果</h3>
          <div className="wx-parse-grid">
            <div><Wind size={15} /><span>地面风</span><strong>{parsed ? windLabel(parsed.wind) : "—"}</strong></div>
            <div><Eye size={15} /><span>主导能见度</span><strong>{parsed ? parsed.visibility.label : "—"}</strong></div>
            <div><CloudSun size={15} /><span>天气现象</span><strong>{parsed ? parsed.weather.label || "无显著天气" : "—"}</strong></div>
            <div><CloudSun size={15} /><span>云况</span><strong>{parsed ? parsed.clouds.label : "—"}</strong></div>
            <div><Thermometer size={15} /><span>温度 / 露点</span><strong>{parsed ? temperatureLabel(parsed.temperature, parsed.dewpoint) : "—"}</strong></div>
            <div><Gauge size={15} /><span>QNH</span><strong>{parsed?.qnh ? `${parsed.qnh} hPa` : "—"}</strong></div>
          </div>
          {decodedMetar.length > 0 && <DecodedBlock title="数据源中文解读" rows={decodedMetar} />}
        </section>

        {taf ? <section className="wx-block">
          <h3><Radio size={14} />TAF<span className="badge gray">{taf.validityLabel}</span></h3>
          <p className="wx-raw" style={{ marginTop: 8 }}>{taf.raw}</p>
          {decodedTaf.length > 0 && <DecodedBlock title="TAF 中文解读" rows={decodedTaf} />}
          <div className="wx-forecast">
            {[taf.base, ...taf.changes].filter(Boolean).map((segment, index) => segment && <div className="wx-forecast-row" key={`${segment.kind}-${index}`}>
              <span>{segment.kind === "BASE" ? "初始" : segment.kind === "FM" ? "转至" : segment.kind}{segment.probability ? ` ${segment.probability}%` : ""}</span>
              <div className="grow">
                <p>{[segment.wind ? windLabel(segment.wind) : "", segment.visibility?.label ?? "", segment.weather ?? "", segment.clouds ?? ""].filter(Boolean).join(" · ") || "—"}</p>
                <p className="times">{segment.timeLabel}</p>
              </div>
            </div>)}
          </div>
        </section> : <section className="wx-block">
          <h3><Radio size={14} />TAF{weather.data?.source ? <span className="badge gray">{weather.data.source}</span> : null}</h3>
          <p className="wx-empty">
            {weather.isFetching
              ? "正在获取 TAF…"
              : weather.data
                ? weather.data.tafNote
                  ?? `${preference === "auto" ? "当前气象源" : weatherSourceLabel(preference)}未返回该机场的 TAF 预报。`
                : "暂无 TAF 数据。"}
          </p>
        </section>}
      </div>
    </div>
  </div>;
}

/** 数据源给的中文解读：每行「字段: 内容」，没有冒号的行当作分组小标题。 */
function DecodedBlock({ title, rows }: { title: string; rows: string[] }) {
  return <div className="wx-decoded">
    <div className="wx-decoded-head"><Languages size={13} /><span>{title}</span></div>
    <ul>
      {rows.map((row, index) => {
        const split = row.search(/[:：]/);
        if (split < 0) return <li key={`${row}-${index}`} className="wx-decoded-group">{row}</li>;
        return <li key={`${row}-${index}`}>
          <span>{row.slice(0, split)}</span>
          <strong>{row.slice(split + 1).trim()}</strong>
        </li>;
      })}
    </ul>
  </div>;
}

export default WeatherPage;

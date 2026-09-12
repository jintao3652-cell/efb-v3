import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CloudSun, ExternalLink, RefreshCw, TriangleAlert } from "lucide-react";
import { getNotams, getWeather, isTauri } from "../lib/tauri";

function formatNotamTime(value?: string) {
  if (!value) return "PERM / 未提供";
  const normalized = value.includes("T") ? value : value.replace(" ", "T") + "Z";
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false, timeZone: "UTC" }) + " UTC";
}

function notamStatus(validityState: string, effective: boolean) {
  if (effective) return "生效中";
  if (validityState === "scheduled") return "待生效";
  if (validityState === "schedule_unknown") return "时段待确认";
  return "有效";
}

function providerName(source: string) {
  if (source === "OpenWeather") return source;
  if (source === "实时") return "Aviation Weather Center";
  return "本地缓存";
}

export function WeatherPage() {
  const [station, setStation] = useState("ZBAA");
  const normalizedStation = station.trim().toUpperCase();
  const weather = useQuery({
    queryKey: ["weather", normalizedStation],
    queryFn: () => getWeather(normalizedStation),
    enabled: isTauri() && normalizedStation.length === 4,
    retry: 0,
    staleTime: 60_000,
  });
  const notams = useQuery({
    queryKey: ["notams", normalizedStation],
    queryFn: () => getNotams(normalizedStation),
    enabled: isTauri() && normalizedStation.length === 4,
    retry: 0,
    staleTime: 2 * 60_000,
  });
  const report = weather.data;
  const provider = report ? providerName(report.source) : "尚未加载";
  const refreshing = weather.isFetching || notams.isFetching;

  return <div className="weather-page page-stack">
    <div className="page-actions"><div><h2>天气与通告</h2><p>METAR、TAF 与 NOTAM 按机场缓存；网络失败时仅回退该 ICAO 的最近数据。</p></div><div className="station-input"><input value={station} maxLength={4} onChange={(event) => setStation(event.target.value.toUpperCase())} /><button className="button primary" onClick={() => { weather.refetch(); notams.refetch(); }} disabled={normalizedStation.length !== 4 || refreshing}><RefreshCw size={16} className={refreshing ? "spinning" : ""} />刷新</button></div></div>
    {weather.isError && !report && <div className="notice"><TriangleAlert size={18} /><div><strong>无法加载 {normalizedStation} 天气</strong><p>{weather.error.message}</p></div></div>}
    {!isTauri() && <div className="notice"><TriangleAlert size={18} /><div><strong>天气服务需要桌面应用</strong><p>浏览器开发模式不会显示虚构或其他机场的缓存数据。</p></div></div>}
    {report && <>
      <section className="weather-report panel"><div className="weather-report-top"><div><p className="eyebrow">{report.source === "OpenWeather" ? "地面天气 · OpenWeather" : `METAR · ${provider}`}</p><h2>{report.station}</h2><p>{report.observedAt}{report.source === "缓存" ? " · 缓存回退" : ""}</p></div><CloudSun size={39} className="accent-icon" /></div><div className="metar-string">{report.raw}</div><div className="weather-details"><div><span>风</span><strong>{report.wind}</strong></div><div><span>能见度</span><strong>{report.visibility}</strong></div><div><span>温度</span><strong>{report.temperature}</strong></div><div><span>气压</span><strong>{report.qnh}</strong></div></div><p className="provider-credit">天气数据：{provider}。仅作飞行前态势参考，请以官方航空气象简报为准。</p></section>
      <div className="weather-grid"><section className="panel"><p className="eyebrow">TAF 预报 · {provider}</p><h3>{report.station} 航空例行天气预报</h3><p className="forecast">{report.taf}</p>{report.previewUrl && <a className="text-link" href={report.previewUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} />在 metar-taf.com 预览</a>}<small>TAF 由当前气象数据源返回；请在飞行前复核官方资料。</small></section><section className="panel notam-panel"><p className="eyebrow">NOTAM · ATISView{notams.data?.cached ? " · 本地缓存" : ""}</p><h3>{report.station} 运行通告</h3>{notams.isFetching && !notams.data && <div className="notam"><span>LOAD</span><p>正在加载最新 NOTAM…</p></div>}{notams.isError && !notams.data && <div className="notam"><span>ERR</span><p>{notams.error.message}</p></div>}{notams.data?.notams.length === 0 && <div className="notam"><span>INFO</span><p>ATISView 当前未返回该机场的有效 NOTAM。</p></div>}{notams.data?.notams.map((notam) => <details className="notam-entry" key={notam.id}><summary><span className={notam.isEffectiveNow ? "active" : "scheduled"}>{notamStatus(notam.validityState, notam.isEffectiveNow)}</span><div><div className="notam-heading"><strong>{notam.number || "NOTAM"}</strong><small>{notam.qCode || notam.source}</small></div><p className="notam-validity">{formatNotamTime(notam.validFromUtc)} — {formatNotamTime(notam.validUntilUtc)}{notam.schedule ? ` · ${notam.schedule}` : ""}</p></div></summary><pre>{notam.displayText}</pre></details>)}<small>数据源：ATISView。便利性展示用途；飞行运行决策请以官方 AIS 资料为准。</small></section></div>
    </>}
  </div>;
}

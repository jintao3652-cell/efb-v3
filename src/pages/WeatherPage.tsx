import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CloudSun, ExternalLink, RefreshCw, TriangleAlert } from "lucide-react";
import { getWeather, isTauri } from "../lib/tauri";
import { useAppStore } from "../stores/app-store";

function providerName(source: string) {
  if (source === "中国气象局航空气象") return source;
  if (source === "OpenWeather") return source;
  if (source === "实时") return "Aviation Weather Center";
  return "本地缓存";
}

export function WeatherPage() {
  const [station, setStation] = useState("ZBAA");
  const online = useAppStore((state) => state.online);
  const normalizedStation = station.trim().toUpperCase();
  const weather = useQuery({
    queryKey: ["weather", normalizedStation, online],
    queryFn: () => getWeather(normalizedStation, !online),
    enabled: isTauri() && normalizedStation.length === 4,
    retry: 0,
    staleTime: 60_000,
  });
  const report = weather.data;
  const provider = report ? providerName(report.source) : "尚未加载";

  return <div className="weather-page page-stack">
    <div className="page-actions"><div><h2>天气与通告</h2><p>METAR / TAF 按机场缓存；网络失败时仅回退该 ICAO 的最近数据。</p></div><div className="station-input"><input value={station} maxLength={4} onChange={(event) => setStation(event.target.value.toUpperCase())} /><button className="button primary" onClick={() => weather.refetch()} disabled={normalizedStation.length !== 4 || weather.isFetching}><RefreshCw size={16} className={weather.isFetching ? "spinning" : ""} />刷新</button></div></div>
    {!online && <div className="offline-banner"><TriangleAlert size={18} />当前离线，将尝试读取 {normalizedStation || "该机场"} 的最近本地缓存。</div>}
    {weather.isError && !report && <div className="notice"><TriangleAlert size={18} /><div><strong>无法加载 {normalizedStation} 天气</strong><p>{weather.error.message}</p></div></div>}
    {!isTauri() && <div className="notice"><TriangleAlert size={18} /><div><strong>天气服务需要桌面应用</strong><p>浏览器开发模式不会显示虚构或其他机场的缓存数据。</p></div></div>}
    {report && <>
      <section className="weather-report panel"><div className="weather-report-top"><div><p className="eyebrow">{report.source === "OpenWeather" ? "地面天气 · OpenWeather" : `METAR · ${provider}`}</p><h2>{report.station}</h2><p>{report.observedAt}{report.source === "缓存" ? " · 缓存回退" : ""}</p></div><CloudSun size={39} className="accent-icon" /></div><div className="metar-string">{report.raw}</div><div className="weather-details"><div><span>风</span><strong>{report.wind}</strong></div><div><span>能见度</span><strong>{report.visibility}</strong></div><div><span>温度</span><strong>{report.temperature}</strong></div><div><span>气压</span><strong>{report.qnh}</strong></div></div><p className="provider-credit">天气数据：{provider}。仅作飞行前态势参考，请以官方航空气象简报为准。</p></section>
      <div className="weather-grid"><section className="panel"><p className="eyebrow">TAF 预报 · {provider}</p><h3>{report.station} 航空例行天气预报</h3><p className="forecast">{report.taf}</p>{report.previewUrl && <a className="text-link" href={report.previewUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} />在 metar-taf.com 预览</a>}<small>TAF 由当前气象数据源返回；请在飞行前复核官方资料。</small></section><section className="panel"><p className="eyebrow">NOTAM</p><h3>运行通告</h3><div className="notam"><span>DATA</span><p>NOTAM 数据源尚未接入，本页不会推断“暂无影响”。</p></div><div className="notam"><span>OPS</span><p>飞行前请从官方 AIS、机场或获授权的数据源确认全部 NOTAM。</p></div></section></div>
    </>}
  </div>;
}

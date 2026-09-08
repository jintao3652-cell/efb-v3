import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CloudSun, RefreshCw, TriangleAlert } from "lucide-react";
import { cachedWeather } from "../lib/data";
import { getWeather } from "../lib/tauri";
import { useAppStore } from "../stores/app-store";

export function WeatherPage() {
  const [station, setStation] = useState("ZBAA");
  const online = useAppStore((state) => state.online);
  const weather = useQuery({ queryKey: ["weather", station], queryFn: () => getWeather(station), enabled: online, placeholderData: cachedWeather });
  const report = weather.data ?? cachedWeather;
  return <div className="weather-page page-stack"><div className="page-actions"><div><h2>天气与通告</h2><p>METAR / TAF 使用网络优先、本地缓存回退。</p></div><div className="station-input"><input value={station} maxLength={4} onChange={(event) => setStation(event.target.value.toUpperCase())} /><button className="button primary" onClick={() => weather.refetch()} disabled={!online || weather.isFetching}><RefreshCw size={16} className={weather.isFetching ? "spinning" : ""} />刷新</button></div></div>
    {!online && <div className="offline-banner"><TriangleAlert size={18} />当前离线，正在显示最近缓存的数据。</div>}
    <section className="weather-report panel"><div className="weather-report-top"><div><p className="eyebrow">METAR · {report.source}</p><h2>{report.station}</h2><p>{report.observedAt}</p></div><CloudSun size={39} className="accent-icon" /></div><div className="metar-string">{report.raw}</div><div className="weather-details"><div><span>风</span><strong>{report.wind}</strong></div><div><span>能见度</span><strong>{report.visibility}</strong></div><div><span>温度 / 露点</span><strong>{report.temperature}</strong></div><div><span>气压</span><strong>{report.qnh}</strong></div></div></section>
    <div className="weather-grid"><section className="panel"><p className="eyebrow">TAF 预报</p><h3>{station} 航空例行天气预报</h3><p className="forecast">未来 12 小时：偏北风 3–5 m/s，能见度良好；局部云量 SCT 030，预计无显著天气。</p><small>演示数据。接入授权气象源后显示原始 TAF。</small></section><section className="panel"><p className="eyebrow">NOTAM</p><h3>运行通告</h3><div className="notam"><span>RWY</span><p>暂无影响当前计划的跑道关闭通告。</p></div><div className="notam"><span>OPS</span><p>请在飞行前向官方来源确认全部 NOTAM。</p></div></section></div>
  </div>;
}

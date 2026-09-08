import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Check, CircleAlert, CloudSun, MapPinned, PlaneTakeoff, Radio, ShieldCheck } from "lucide-react";
import { StatusBadge } from "../components/common/StatusBadge";
import { cachedWeather, demoPlan } from "../lib/data";
import { listFlightPlans } from "../lib/tauri";

const checklist = ["检查飞行计划与航路", "确认起降机场天气", "查看 NOTAM 与跑道状态", "下载所需航图至本地"];

export function OverviewPage() {
  const flightPlans = useQuery({ queryKey: ["flight-plans"], queryFn: listFlightPlans });
  const currentPlan = flightPlans.data?.[0] ?? demoPlan;
  return <div className="overview-page page-stack">
    <div className="welcome-row"><div><h2>下午好，飞行员</h2><p>所有关键飞行信息已准备就绪。</p></div><StatusBadge tone="success"><ShieldCheck size={14} /> AIRAC 2609 有效</StatusBadge></div>
    <section className="hero-card">
      <div className="hero-route"><div><p className="eyebrow">当前飞行计划</p><h2>{currentPlan.callsign || "未命名计划"}</h2><p>{currentPlan.aircraft} · {currentPlan.cruiseAltitude} · 最近导入 / 创建</p></div><div className="route-display"><strong>{currentPlan.departure}</strong><div className="route-line"><PlaneTakeoff size={19} /></div><strong>{currentPlan.arrival}</strong></div></div>
      <div className="hero-footer"><span>ETD {new Date(currentPlan.etd).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} 本地时间</span><Link className="button primary" to="/flight-plans">查看计划 <ArrowRight size={16} /></Link></div>
    </section>
    <div className="dashboard-grid">
      <section className="panel weather-panel"><div className="panel-header"><div><p className="eyebrow">出发地天气</p><h3>{cachedWeather.station} · 北京首都</h3></div><CloudSun className="accent-icon" size={27} /></div><div className="weather-main"><strong>22°</strong><span>晴间多云</span></div><div className="stat-row"><span>风 {cachedWeather.wind}</span><span>能见度 {cachedWeather.visibility}</span><span>QNH {cachedWeather.qnh}</span></div><Link to="/weather" className="text-link">查看 METAR / TAF <ArrowRight size={15} /></Link></section>
      <section className="panel"><div className="panel-header"><div><p className="eyebrow">在线网络</p><h3>中国区域管制</h3></div><Radio className="accent-icon" size={25} /></div><div className="network-number">12 <span>在线席位</span></div><div className="controller-list"><span><i className="dot success" />ZBPE_CTR · 北京区调</span><span><i className="dot success" />ZSPD_APP · 上海进近</span><span><i className="dot warning" />ZGGG_TWR · 广州塔台</span></div></section>
      <section className="panel quick-panel"><div className="panel-header"><div><p className="eyebrow">快速访问</p><h3>飞行工具</h3></div></div><div className="quick-actions"><Link to="/map"><MapPinned size={18} />航图地图</Link><Link to="/charts"><PlaneTakeoff size={18} />航图库</Link><Link to="/airports"><Radio size={18} />机场频率</Link></div></section>
    </div>
    <section className="panel checklist-panel"><div className="panel-header"><div><p className="eyebrow">起飞前</p><h3>快速检查清单</h3></div><span className="muted">0 / {checklist.length} 完成</span></div><div className="checklist">{checklist.map((item) => <button key={item}><span><Check size={15} /></span>{item}</button>)}</div></section>
    <div className="notice"><CircleAlert size={18} /><div><strong>离线优先已启用</strong><p>航图、飞行计划与最近天气数据将持续保存在本机。</p></div></div>
  </div>;
}

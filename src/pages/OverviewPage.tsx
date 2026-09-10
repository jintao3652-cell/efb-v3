import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Check, CircleAlert, CloudSun, MapPinned, PlaneTakeoff, Radio, ShieldCheck } from "lucide-react";
import { StatusBadge } from "../components/common/StatusBadge";
import { loadVatsimSnapshot } from "../lib/airspace";
import { getCurrentAiracCycle, getWeather, isTauri, listFlightPlans } from "../lib/tauri";
import { useAppStore } from "../stores/app-store";

const checklistItems = ["检查飞行计划与航路", "确认起降机场天气", "查看 NOTAM 与跑道状态", "下载所需航图至本地"];
const checklistStorageKey = "skyboard-preflight-checklist";

function initialChecklist() {
  try {
    const value = JSON.parse(localStorage.getItem(checklistStorageKey) ?? "[]");
    return Array.isArray(value) ? checklistItems.map((_, index) => Boolean(value[index])) : checklistItems.map(() => false);
  } catch {
    return checklistItems.map(() => false);
  }
}

function controllerRole(callsign: string) {
  const suffix = callsign.split("_").at(-1);
  return suffix === "CTR" ? "区调" : suffix === "APP" || suffix === "DEP" ? "进近" : suffix === "TWR" ? "塔台" : suffix === "GND" ? "地面" : suffix === "DEL" ? "放行" : "席位";
}

export function OverviewPage() {
  const online = useAppStore((state) => state.online);
  const [checked, setChecked] = useState(initialChecklist);
  const flightPlans = useQuery({ queryKey: ["flight-plans"], queryFn: listFlightPlans });
  const currentPlan = flightPlans.data?.[0];
  const departure = currentPlan?.departure.trim().toUpperCase() ?? "";
  const weather = useQuery({ queryKey: ["weather", departure, online], queryFn: () => getWeather(departure, !online), enabled: isTauri() && departure.length === 4, retry: 0, staleTime: 60_000 });
  const airac = useQuery({ queryKey: ["current-airac-cycle"], queryFn: getCurrentAiracCycle, enabled: isTauri(), retry: 0, staleTime: 12 * 60 * 60_000 });
  const vatsim = useQuery({ queryKey: ["vatsim-live-snapshot"], queryFn: ({ signal }) => loadVatsimSnapshot(signal), retry: 0, staleTime: 12_000, refetchInterval: online ? 30_000 : false, networkMode: "always" });
  const chinaControllers = useMemo(() => (vatsim.data?.controllers ?? []).filter((controller) => controller.callsign.toUpperCase().startsWith("Z")), [vatsim.data?.controllers]);
  const completed = checked.filter(Boolean).length;
  const temperature = weather.data?.temperature.split("/")[0]?.trim() || "--";

  useEffect(() => { try { localStorage.setItem(checklistStorageKey, JSON.stringify(checked)); } catch { return; } }, [checked]);

  const toggleChecklist = (index: number) => setChecked((items) => items.map((value, itemIndex) => itemIndex === index ? !value : value));
  const etd = currentPlan?.etd ? new Date(currentPlan.etd) : undefined;
  const etdLabel = etd && !Number.isNaN(etd.getTime()) ? etd.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : "未设置";

  return <div className="overview-page page-stack">
    <div className="welcome-row"><div><h2>欢迎回来，飞行员</h2><p>这里显示本机计划、实时网络与数据状态。</p></div><StatusBadge tone={airac.data ? "success" : airac.isError ? "warning" : "info"}><ShieldCheck size={14} />{airac.data ? `AIRAC ${airac.data.cycleId}` : airac.isError ? "AIRAC 检测失败" : "正在检测 AIRAC"}</StatusBadge></div>
    <section className="hero-card">
      <div className="hero-route"><div><p className="eyebrow">当前飞行计划</p><h2>{currentPlan?.callsign || "尚未导入计划"}</h2><p>{currentPlan ? `${currentPlan.aircraft || "未填写机型"} · ${currentPlan.cruiseAltitude || "未填写高度"} · 本地计划` : "从 SimBrief 导入或新建一份飞行计划"}</p></div><div className="route-display"><strong>{currentPlan?.departure || "----"}</strong><div className="route-line"><PlaneTakeoff size={19} /></div><strong>{currentPlan?.arrival || "----"}</strong></div></div>
      <div className="hero-footer"><span>ETD {etdLabel} 本地时间</span><Link className="button primary" to="/flight-plans">{currentPlan ? "查看计划" : "创建计划"} <ArrowRight size={16} /></Link></div>
    </section>
    <div className="dashboard-grid">
      <section className="panel weather-panel"><div className="panel-header"><div><p className="eyebrow">出发地天气</p><h3>{departure || "未选择机场"} · {weather.isFetching ? "正在更新" : weather.data?.source === "缓存" ? "缓存回退" : weather.data ? "实时数据" : "等待计划"}</h3></div><CloudSun className="accent-icon" size={27} /></div><div className="weather-main"><strong>{temperature}</strong><span>{weather.data?.raw || (weather.isError ? weather.error.message : "导入计划后加载对应机场 METAR")}</span></div><div className="stat-row"><span>风 {weather.data?.wind ?? "--"}</span><span>能见度 {weather.data?.visibility ?? "--"}</span><span>QNH {weather.data?.qnh ?? "--"}</span></div><Link to="/weather" className="text-link">查看 METAR / TAF <ArrowRight size={15} /></Link></section>
      <section className="panel"><div className="panel-header"><div><p className="eyebrow">在线网络</p><h3>中国区域管制</h3></div><Radio className="accent-icon" size={25} /></div><div className="network-number">{vatsim.isFetching && !vatsim.data ? "–" : chinaControllers.length} <span>在线席位</span></div><div className="controller-list">{chinaControllers.slice(0, 3).map((controller) => <span key={controller.callsign}><i className="dot success" />{controller.callsign} · {controller.frequency} · {controllerRole(controller.callsign)}</span>)}{!vatsim.isFetching && chinaControllers.length === 0 && <span>{vatsim.isError ? `VATSIM 暂不可用：${vatsim.error.message}` : "当前未检测到中国区域在线席位"}</span>}</div></section>
      <section className="panel quick-panel"><div className="panel-header"><div><p className="eyebrow">快速访问</p><h3>飞行工具</h3></div></div><div className="quick-actions"><Link to="/map"><MapPinned size={18} />航图地图</Link><Link to="/charts"><PlaneTakeoff size={18} />航图库</Link><Link to="/airports"><Radio size={18} />机场频率</Link></div></section>
    </div>
    <section className="panel checklist-panel"><div className="panel-header"><div><p className="eyebrow">起飞前</p><h3>快速检查清单</h3></div><span className="muted">{completed} / {checklistItems.length} 完成</span></div><div className="checklist">{checklistItems.map((item, index) => <button key={item} className={checked[index] ? "completed" : ""} onClick={() => toggleChecklist(index)} aria-pressed={checked[index]}><span><Check size={15} /></span>{item}</button>)}</div></section>
    <div className="notice"><CircleAlert size={18} /><div><strong>{online ? "离线回退已启用" : "当前处于离线模式"}</strong><p>飞行计划、导航数据库与按机场保存的最近天气可继续使用；实时数据会在联网后恢复。</p></div></div>
  </div>;
}

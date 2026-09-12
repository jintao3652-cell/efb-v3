import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Download, FileText, FileUp, Gauge, Plane, PlaneLanding, PlaneTakeoff, Plus, Route, Save, UserRound, X } from "lucide-react";
import { flightPlanTemplate } from "../lib/data";
import { getNavigationAirportProcedures, getNavigationProcedurePoints, importSimBriefFlight, listFlightPlans, saveFlightPlan, type NavigationProcedureSummary } from "../lib/tauri";
import { detectPlanRouteProceduresDetailed, detectRouteProcedures, procedureSelection, procedureSupportsRunway, validAirportIcao, type ProcedureLookup } from "../lib/route-procedures";
import { updateFlightPlan } from "../stores/flight-plan-store";
import type { FlightPlan, FlightProcedureSelection, FlightRoutePoint } from "../types";

const localKey = "skyboard-efb-flight-plans";
const simbriefUsernameKey = "skyboard-efb-simbrief-username";
function sortByImportTime(plans: FlightPlan[]) { return [...plans].sort((first, second) => Date.parse(second.importedAt || second.updatedAt) - Date.parse(first.importedAt || first.updatedAt)); }
function browserPlans() { try { const raw = localStorage.getItem(localKey); const plans: Array<FlightPlan & { status?: unknown }> = raw ? JSON.parse(raw) as Array<FlightPlan & { status?: unknown }> : []; return sortByImportTime(plans.map(({ status: _status, ...plan }) => ({ ...plan, importedAt: plan.importedAt || plan.updatedAt || new Date(0).toISOString(), routePoints: plan.routePoints ?? [] }))); } catch { return []; } }
function cachePlans(plans: FlightPlan[]) { localStorage.setItem(localKey, JSON.stringify(sortByImportTime(plans))); }
function savedSimbriefUsername() { try { return localStorage.getItem(simbriefUsernameKey) ?? ""; } catch { return ""; } }
function cacheSimbriefUsername(username: string) { try { localStorage.setItem(simbriefUsernameKey, username); } catch { return; } }
function localDateTime(value: string) { const timestamp = Date.parse(value); return Number.isNaN(timestamp) ? new Date().toISOString().slice(0, 16) : new Date(timestamp).toISOString().slice(0, 16); }
function downloadPlan(plan: FlightPlan) { const url = URL.createObjectURL(new Blob([JSON.stringify(plan, null, 2)], { type: "application/json" })); const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${plan.callsign || plan.departure}-${plan.arrival}.json`; anchor.click(); URL.revokeObjectURL(url); }
function sameRoutePoints(first: FlightRoutePoint[], second: FlightRoutePoint[]) { return first.length === second.length && first.every((point, index) => point.ident === second[index].ident && Math.abs(point.latitude - second[index].latitude) < .000001 && Math.abs(point.longitude - second[index].longitude) < .000001); }
function procedureRunways(procedures: NavigationProcedureSummary[], current: string) { const values = new Set(procedures.flatMap((procedure) => procedure.runways)); if (current) values.add(current); return [...values].sort((first, second) => first.localeCompare(second, undefined, { numeric: true })); }
/** 查库入口绑定到 Tauri 命令；识别/取点的纯逻辑在 lib/route-procedures.ts，便于脱离应用验证。 */
const procedureLookup: ProcedureLookup = {
  procedures: (icao) => getNavigationAirportProcedures(icao),
  points: (procedureId, runway, transition) => getNavigationProcedurePoints(procedureId, runway, transition),
};
/** 导入与激活共用的「补齐终端程序」入口；失败原因随结果返回，由调用方展示 —— 绝不静默。 */
function detectPlanProcedures(plan: FlightPlan) { return detectPlanRouteProceduresDetailed(plan, procedureLookup); }
function describeDetectionIssues(issues: string[]) { return issues.length ? `⚠ ${issues.join("；")}` : "进离场程序已自动识别。"; }
function syncFlightPlanPanel(plan: FlightPlan) {
  updateFlightPlan({
    callsign: plan.callsign,
    origin: { icao: plan.departure, runway: plan.departureRunway ?? "", sid: plan.sid?.name ?? "", transition: plan.sid?.transition ?? "" },
    destination: { icao: plan.arrival, runway: plan.arrivalRunway ?? "", star: plan.star?.name ?? "", transition: plan.star?.transition ?? "", approach: plan.approach?.name ?? "" },
    alternate: plan.alternate ? { icao: plan.alternate, iata: "", name: plan.alternate, city: "", vfr: false } : null,
  });
}

export function FlightPlansPage() {
  const client = useQueryClient();
  const plansQuery = useQuery({ queryKey: ["flight-plans"], queryFn: async () => { const plans = await listFlightPlans(); return plans.length ? plans : browserPlans(); } });
  const [editing, setEditing] = useState<FlightPlan | null>(null);
  const [editingMode, setEditingMode] = useState<"new" | "edit">("edit");
  const [simbriefOpen, setSimbriefOpen] = useState(false);
  const [username, setUsername] = useState(savedSimbriefUsername);
  const [activationMessage, setActivationMessage] = useState("");
  // 最近一次「补齐终端程序」的过程问题（识别不到、查库失败等），由激活提示语展示
  const detectionIssuesRef = useRef<string[]>([]);
  const plans = useMemo(() => plansQuery.data ?? [], [plansQuery.data]);
  useEffect(() => { if (!plansQuery.isLoading && plans.length === 0) { setEditingMode("edit"); setEditing(newPlan()); } }, [plansQuery.isLoading, plans.length]);
  const mutation = useMutation({ mutationFn: async (plan: FlightPlan) => { const result = await saveFlightPlan(plan); cachePlans([result, ...plans.filter((item) => item.id !== result.id)]); return result; }, onSuccess: (plan) => { syncFlightPlanPanel(plan); client.invalidateQueries({ queryKey: ["flight-plans"] }); setEditing(null); } });
  // 导入即激活：计划落库时就带上刚识别出的 SID/STAR 与航迹点，
  // 且 importedAt 取当前时间 —— 列表按 importedAt 倒序，这张计划自然成为
  // 地图侧的 activePlan，不需要用户再去列表里点一次。
  const simbriefMutation = useMutation({ mutationFn: async (username: string) => { const flight = await importSimBriefFlight(username.trim()); const importedAt = new Date().toISOString(); const draft: FlightPlan = { id: crypto.randomUUID(), callsign: flight.callsign, departure: flight.departure, arrival: flight.arrival, alternate: flight.alternate, route: flight.route, aircraft: flight.aircraft, cruiseAltitude: flight.cruiseAltitude, etd: localDateTime(flight.scheduledOut), updatedAt: importedAt, importedAt, routePoints: flight.routePoints }; const detection = await detectPlanProcedures(draft); detectionIssuesRef.current = detection.issues; return saveFlightPlan(detection.plan); }, onSuccess: (plan, importedUsername) => { const cachedUsername = importedUsername.trim(); cacheSimbriefUsername(cachedUsername); setUsername(cachedUsername); syncFlightPlanPanel(plan); cachePlans([plan, ...plans.filter((item) => item.id !== plan.id)]); client.setQueryData(["flight-plans"], [plan, ...plans.filter((item) => item.id !== plan.id)]); client.invalidateQueries({ queryKey: ["flight-plans"] }); setActivationMessage(`已导入 ${plan.callsign || `${plan.departure}-${plan.arrival}`}，并直接设为当前飞行计划，地图航路已切换。${describeDetectionIssues(detectionIssuesRef.current)}`); setEditingMode("edit"); setEditing(plan); setSimbriefOpen(false); } });
  // 激活同样先补齐终端程序：历史计划里常常只存了航路文本（导入时还没识别或当时失败），
  // 补齐后再落库，避免「点开一条旧计划，地图上却没有离场/进场航迹」。
  const activateMutation = useMutation({ mutationFn: async (plan: FlightPlan) => { const importedAt = new Date().toISOString(); const detection = await detectPlanProcedures({ ...plan, updatedAt: importedAt, importedAt }); detectionIssuesRef.current = detection.issues; return saveFlightPlan(detection.plan); }, onSuccess: (plan) => { const updatedPlans = [plan, ...plans.filter((item) => item.id !== plan.id)]; syncFlightPlanPanel(plan); cachePlans(updatedPlans); client.setQueryData(["flight-plans"], updatedPlans); client.invalidateQueries({ queryKey: ["flight-plans"] }); setActivationMessage(`已激活 ${plan.callsign || `${plan.departure}-${plan.arrival}`}，地图航路已切换。${describeDetectionIssues(detectionIssuesRef.current)}`); } });
  // 点击即激活：不再弹确认框，用户点一次就切换到位。
  const activatePlan = (plan: FlightPlan) => { activateMutation.mutate(plan); };
  const newPlan = (): FlightPlan => { const importedAt = new Date().toISOString(); return { ...flightPlanTemplate, id: crypto.randomUUID(), callsign: "", departure: "ZBAA", arrival: "ZSPD", route: "", etd: new Date().toISOString().slice(0, 16), updatedAt: importedAt, importedAt, routePoints: [], departureRunway: "", arrivalRunway: "", sid: undefined, star: undefined }; };
  return <div className="flight-page page-stack"><div className="page-actions"><div><h2>飞行计划</h2><p>导入 SimBrief 或点击历史计划即刻切换为当前地图航路，无需二次确认。</p></div><div><button className="button secondary" onClick={() => { setSimbriefOpen(true); simbriefMutation.reset(); }}><FileUp size={17} />导入 SimBrief</button><button className="button primary" onClick={() => { setEditingMode("new"); setEditing(newPlan()); }}><Plus size={17} />新建计划</button></div></div>
    {activationMessage && <p className="success-message">{activationMessage}</p>}
    <section className="panel plan-table"><div className="plan-table-head"><span>呼号 / 机型</span><span>航线</span><span>计划起飞</span><span>操作</span></div>{plans.map((plan, index) => <div className={`plan-row${index === 0 ? " plan-row-active" : ""}`} role="button" tabIndex={0} title="点击激活为当前飞行计划" onClick={() => activatePlan(plan)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activatePlan(plan); } }} key={plan.id}><span><strong>{plan.callsign || "未命名计划"}{index === 0 && <em className="plan-row-badge">当前</em>}</strong><small>{plan.aircraft}</small></span><span><strong>{plan.departure} <i>→</i> {plan.arrival}</strong><small>{plan.route || "未设置航路"}</small></span><span>{new Date(plan.etd).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</span><button className="plan-row-edit" onClick={(event) => { event.stopPropagation(); setEditingMode("edit"); setEditing(plan); }}>编辑</button></div>)}</section>
    {simbriefOpen && <div className="modal-backdrop" role="presentation"><section className="modal-panel simbrief-modal" role="dialog" aria-modal="true" aria-label="导入 SimBrief 飞行计划"><div className="modal-header"><div><p className="eyebrow">SIMBRIEF IMPORT</p><h2>导入最近飞行计划</h2></div><button className="icon-button" onClick={() => setSimbriefOpen(false)}><X size={20} /></button></div><p className="simbrief-description">输入 SimBrief 用户名。应用会通过官方 API 读取该用户最近一次生成的飞行计划，自动识别离场/进场程序，并直接激活为当前飞行计划。</p><label className="form-field"><span>SimBrief 用户名</span><div className="input-with-icon"><UserRound size={17} /><input autoFocus value={username} onChange={(event) => { setUsername(event.target.value); cacheSimbriefUsername(event.target.value); }} onKeyDown={(event) => { if (event.key === "Enter" && username.trim()) simbriefMutation.mutate(username); }} placeholder="例如 your_simbrief_username" /></div></label>{simbriefMutation.isError && <p className="form-error">{simbriefMutation.error.message}</p>}<div className="modal-actions"><button className="button secondary" onClick={() => setSimbriefOpen(false)}>取消</button><button className="button primary" disabled={!username.trim() || simbriefMutation.isPending} onClick={() => simbriefMutation.mutate(username)}><FileUp size={17} />{simbriefMutation.isPending ? "正在导入" : "读取最近 OFP"}</button></div></section></div>}
    {editing && <FlightPlanEditor plan={editing} mode={editingMode} pending={mutation.isPending} error={mutation.isError ? mutation.error.message : ""} onChange={(update) => setEditing((current) => { const next = current ? update(current) : current; if (next) syncFlightPlanPanel(next); return next; })} onClose={() => setEditing(null)} onExport={() => downloadPlan(editing)} onSubmit={() => mutation.mutate({ ...editing, updatedAt: new Date().toISOString() })} />}
  </div>;
}

function FlightPlanEditor({ plan, mode, pending, error, onChange, onClose, onExport, onSubmit }: { plan: FlightPlan; mode: "new" | "edit"; pending: boolean; error: string; onChange: (update: (plan: FlightPlan) => FlightPlan) => void; onClose: () => void; onExport: () => void; onSubmit: () => void }) {
  const departureProcedures = useQuery({ queryKey: ["navigation-procedures", plan.departure], queryFn: () => getNavigationAirportProcedures(plan.departure), enabled: validAirportIcao(plan.departure), retry: 0, staleTime: 300_000 });
  const arrivalProcedures = useQuery({ queryKey: ["navigation-procedures", plan.arrival], queryFn: () => getNavigationAirportProcedures(plan.arrival), enabled: validAirportIcao(plan.arrival), retry: 0, staleTime: 300_000 });
  const sids = useMemo(() => departureProcedures.data?.sids ?? [], [departureProcedures.data?.sids]);
  const stars = useMemo(() => arrivalProcedures.data?.stars ?? [], [arrivalProcedures.data?.stars]);
  const selectedSid = sids.find((procedure) => procedure.name === plan.sid?.name);
  const selectedStar = stars.find((procedure) => procedure.name === plan.star?.name);
  const sidPoints = useQuery({ queryKey: ["navigation-procedure-points", selectedSid?.id, plan.departureRunway, plan.sid?.transition], queryFn: () => getNavigationProcedurePoints(selectedSid!.id, plan.departureRunway, plan.sid?.transition), enabled: Boolean(selectedSid && plan.sid), retry: 0, staleTime: Infinity });
  const starPoints = useQuery({ queryKey: ["navigation-procedure-points", selectedStar?.id, plan.arrivalRunway, plan.star?.transition], queryFn: () => getNavigationProcedurePoints(selectedStar!.id, plan.arrivalRunway, plan.star?.transition), enabled: Boolean(selectedStar && plan.star), retry: 0, staleTime: Infinity });
  const terminalPointsPending = Boolean(selectedSid && plan.sid && (!sidPoints.data || !sameRoutePoints(plan.sid.points ?? [], sidPoints.data))) || Boolean(selectedStar && plan.star && (!starPoints.data || !sameRoutePoints(plan.star.points ?? [], starPoints.data)));
  useEffect(() => {
    if (!sidPoints.data || !selectedSid) return;
    onChange((current) => !current.sid || current.sid.name !== selectedSid.name || sameRoutePoints(current.sid.points ?? [], sidPoints.data!) ? current : { ...current, sid: { ...current.sid, points: sidPoints.data! } });
  }, [onChange, selectedSid, sidPoints.data]);
  useEffect(() => {
    if (!starPoints.data || !selectedStar) return;
    onChange((current) => !current.star || current.star.name !== selectedStar.name || sameRoutePoints(current.star.points ?? [], starPoints.data!) ? current : { ...current, star: { ...current.star, points: starPoints.data! } });
  }, [onChange, selectedStar, starPoints.data]);
  // 航路文本里本来就写着离场/进场程序名（SimBrief 的约定：首个元素是 SID、末个元素是 STAR，
  // 例如 `CIND8S CINDY Z74 HAREM T104 ROKIL ROKI1B`）。导入的计划不会自带 sid/star，
  // 所以在程序表就绪后按航路自动补一次 —— 只在对应字段为空时补，
  // 且按 (计划, 航路) 只补一次，绝不覆盖用户的手动选择。
  const autoDetectedRoutes = useRef("");
  useEffect(() => {
    const route = plan.route.trim();
    if (!route || (plan.sid && plan.star)) return;
    const routeKey = `${plan.id}|${route}`;
    if (autoDetectedRoutes.current === routeKey) return;
    // 程序表还没读回来时 sids/stars 为空数组，此时不做匹配，
    // 等它们就绪后本 effect 会因为依赖变化再跑一次。
    const detected = detectRouteProcedures(sids, stars, route);
    const sid = plan.sid ? undefined : detected.sid;
    const star = plan.star ? undefined : detected.star;
    if (!sid && !star) return;
    autoDetectedRoutes.current = routeKey;
    onChange((current) => {
      let updated = current;
      if (sid && !current.sid) {
        const { runway, selection } = procedureSelection(sid, current.departureRunway ?? "");
        updated = { ...updated, departureRunway: runway, sid: selection };
      }
      if (star && !current.star) {
        const { runway, selection } = procedureSelection(star, current.arrivalRunway ?? "");
        updated = { ...updated, arrivalRunway: runway, star: selection };
      }
      return updated;
    });
  }, [plan.id, plan.route, plan.sid, plan.star, sids, stars, onChange]);
  const departureRunways = procedureRunways(sids, plan.departureRunway ?? "");
  const arrivalRunways = procedureRunways(stars, plan.arrivalRunway ?? "");
  const availableSids = sids.filter((procedure) => procedureSupportsRunway(procedure, plan.departureRunway ?? ""));
  const availableStars = stars.filter((procedure) => procedureSupportsRunway(procedure, plan.arrivalRunway ?? ""));
  const updateRunway = (side: "departure" | "arrival", runway: string) => onChange((current) => {
    if (side === "departure") {
      const procedure = sids.find((item) => item.name === current.sid?.name);
      const sid = procedure && procedureSupportsRunway(procedure, runway) && current.sid ? { ...current.sid, points: [] } : undefined;
      return { ...current, departureRunway: runway, sid };
    }
    const procedure = stars.find((item) => item.name === current.star?.name);
    const star = procedure && procedureSupportsRunway(procedure, runway) && current.star ? { ...current.star, points: [] } : undefined;
    return { ...current, arrivalRunway: runway, star };
  });
  const updateProcedure = (side: "departure" | "arrival", name: string) => onChange((current) => {
    const procedures = side === "departure" ? sids : stars;
    const procedure = procedures.find((item) => item.name === name);
    if (!procedure) return side === "departure" ? { ...current, sid: undefined } : { ...current, star: undefined };
    const { runway, selection } = procedureSelection(procedure, side === "departure" ? current.departureRunway ?? "" : current.arrivalRunway ?? "");
    return side === "departure" ? { ...current, departureRunway: runway, sid: selection } : { ...current, arrivalRunway: runway, star: selection };
  });
  const updateTransition = (side: "departure" | "arrival", transition: string) => onChange((current) => side === "departure"
    ? { ...current, sid: current.sid ? { ...current.sid, transition, points: [] } : undefined }
    : { ...current, star: current.star ? { ...current.star, transition, points: [] } : undefined });
  return <div className="modal-backdrop" role="presentation"><section className="modal-panel flight-editor-modal" role="dialog" aria-modal="true" aria-label={mode === "new" ? "新建飞行计划" : "编辑飞行计划"}>
    <header className="flight-editor-header"><div><span className="flight-editor-kicker"><FileText size={14} />{mode === "new" ? "NEW FLIGHT PLAN" : "SAVED FLIGHT PLAN"}</span><h2>{mode === "new" ? "新建飞行计划" : "编辑飞行计划"}</h2><p>整理航班基础信息、机场与计划航路。</p></div><button className="flight-editor-close" onClick={onClose} aria-label="关闭"><X size={20} /></button></header>
    <form className="flight-editor-form" onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
      <div className="flight-route-summary"><div><PlaneTakeoff size={18} /><span>出发</span><strong>{plan.departure || "----"}</strong></div><div className="flight-route-line"><i /><Plane size={24} /><i /></div><div><PlaneLanding size={18} /><span>到达</span><strong>{plan.arrival || "----"}</strong></div><small>{plan.sid?.name || "未选 SID"} · 航路 · {plan.star?.name || "未选 STAR"}{plan.alternate ? ` · 备降 ${plan.alternate}` : ""}</small></div>
      <section className="flight-editor-section"><div className="flight-editor-section-title"><Gauge size={17} /><div><strong>航班信息</strong><span>呼号、机型和巡航计划</span></div></div><div className="flight-editor-grid"><Field label="航班呼号" value={plan.callsign} onChange={(callsign) => onChange((current) => ({ ...current, callsign }))} placeholder="例如 SJX346" /><Field label="机型" value={plan.aircraft} onChange={(aircraft) => onChange((current) => ({ ...current, aircraft }))} placeholder="例如 A359" /><Field label="巡航高度" value={plan.cruiseAltitude} onChange={(cruiseAltitude) => onChange((current) => ({ ...current, cruiseAltitude }))} placeholder="例如 FL410" /><label className="form-field"><span>预计起飞时间</span><div className="flight-input-icon"><CalendarClock size={16} /><input type="datetime-local" value={plan.etd} onChange={(event) => onChange((current) => ({ ...current, etd: event.target.value }))} /></div></label></div></section>
      <section className="flight-editor-section"><div className="flight-editor-section-title"><PlaneTakeoff size={17} /><div><strong>机场</strong><span>使用四字 ICAO 代码</span></div></div><div className="flight-airport-grid"><Field label="出发机场" value={plan.departure} onChange={(departure) => onChange((current) => ({ ...current, departure: departure.toUpperCase(), departureRunway: "", sid: undefined }))} placeholder="RCTP" /><Field label="到达机场" value={plan.arrival} onChange={(arrival) => onChange((current) => ({ ...current, arrival: arrival.toUpperCase(), arrivalRunway: "", star: undefined }))} placeholder="RJTT" /><Field label="备降机场" value={plan.alternate ?? ""} onChange={(alternate) => onChange((current) => ({ ...current, alternate: alternate.toUpperCase() }))} placeholder="RJGG" /></div></section>
      <section className="flight-editor-section"><div className="flight-editor-section-title"><Route size={17} /><div><strong>终端程序</strong><span>选择跑道、SID/STAR 与过渡点，保存后自动加入地图航迹</span></div></div><div className="flight-procedure-grid">
        <ProcedureSelector side="departure" airport={plan.departure} runway={plan.departureRunway ?? ""} runways={departureRunways} procedures={availableSids} selected={plan.sid} selectedSummary={selectedSid} loading={departureProcedures.isFetching} pointsLoading={sidPoints.isFetching} message={departureProcedures.data?.message ?? ""} error={departureProcedures.isError ? departureProcedures.error.message : sidPoints.isError ? sidPoints.error.message : ""} onRunwayChange={(runway) => updateRunway("departure", runway)} onProcedureChange={(name) => updateProcedure("departure", name)} onTransitionChange={(transition) => updateTransition("departure", transition)} />
        <ProcedureSelector side="arrival" airport={plan.arrival} runway={plan.arrivalRunway ?? ""} runways={arrivalRunways} procedures={availableStars} selected={plan.star} selectedSummary={selectedStar} loading={arrivalProcedures.isFetching} pointsLoading={starPoints.isFetching} message={arrivalProcedures.data?.message ?? ""} error={arrivalProcedures.isError ? arrivalProcedures.error.message : starPoints.isError ? starPoints.error.message : ""} onRunwayChange={(runway) => updateRunway("arrival", runway)} onProcedureChange={(name) => updateProcedure("arrival", name)} onTransitionChange={(transition) => updateTransition("arrival", transition)} />
      </div><p className="flight-procedure-note">程序航迹只用于地图预览，不会重复写入航路文本；无坐标的雷达引导或航向航段会自动跳过。</p></section>
      <section className="flight-editor-section"><div className="flight-editor-section-title"><Route size={17} /><div><strong>计划航路</strong><span>支持航路、航路点和直飞指令</span></div></div><label className="form-field flight-route-field"><textarea value={plan.route} onChange={(event) => onChange((current) => ({ ...current, route: event.target.value }))} placeholder="例如 MOLKA1A MOLKA M750 BILLY Y21 AKSEL…" /><small>{plan.route.trim() ? `${plan.route.trim().split(/\s+/).length} 个航路元素` : "尚未填写航路"}</small></label></section>
      {error && <p className="form-error flight-editor-error">保存失败：{error}</p>}
      <footer className="flight-editor-actions"><button type="button" className="button secondary" onClick={onExport}><Download size={17} />导出 JSON</button><span /><button type="button" className="button secondary" onClick={onClose}>取消</button><button className="button primary" disabled={pending || terminalPointsPending}><Save size={17} />{pending ? "正在保存" : terminalPointsPending ? "正在生成航迹" : mode === "new" ? "创建计划" : "保存修改"}</button></footer>
    </form>
  </section></div>;
}

function ProcedureSelector({ side, airport, runway, runways, procedures, selected, selectedSummary, loading, pointsLoading, message, error, onRunwayChange, onProcedureChange, onTransitionChange }: { side: "departure" | "arrival"; airport: string; runway: string; runways: string[]; procedures: NavigationProcedureSummary[]; selected?: FlightProcedureSelection; selectedSummary?: NavigationProcedureSummary; loading: boolean; pointsLoading: boolean; message: string; error: string; onRunwayChange: (value: string) => void; onProcedureChange: (value: string) => void; onTransitionChange: (value: string) => void }) {
  const label = side === "departure" ? "SID" : "STAR";
  const Icon = side === "departure" ? PlaneTakeoff : PlaneLanding;
  return <div className="flight-procedure-card"><div className="flight-procedure-card-title"><Icon size={17} /><div><strong>{airport || "----"} · {label}</strong><span>{side === "departure" ? "离场跑道与程序" : "进场程序与落地跑道"}</span></div></div><div className="flight-procedure-fields">
    <label className="form-field"><span>{side === "departure" ? "起飞跑道" : "落地跑道"}</span><select value={runway} onChange={(event) => onRunwayChange(event.target.value)}><option value="">未指定</option>{runways.map((item) => <option key={item} value={item}>RWY {item}</option>)}</select></label>
    <label className="form-field"><span>{label}</span><select value={selectedSummary ? selected?.name ?? "" : ""} disabled={loading || procedures.length === 0} onChange={(event) => onProcedureChange(event.target.value)}><option value="">不使用 {label}</option>{procedures.map((procedure) => <option key={procedure.id} value={procedure.name}>{procedure.name}{procedure.runways.length ? ` · ${procedure.runways.join("/")}` : ""}</option>)}</select></label>
    <label className="form-field"><span>过渡点</span><select value={selected?.transition ?? ""} disabled={!selectedSummary || selectedSummary.transitions.length === 0} onChange={(event) => onTransitionChange(event.target.value)}><option value="">主程序</option>{selectedSummary?.transitions.map((transition) => <option key={transition} value={transition}>{transition}</option>)}</select></label>
  </div><div className={`flight-procedure-state ${error ? "error" : ""}`}>{error || (loading ? "正在读取终端程序…" : selected ? `${pointsLoading ? "正在更新航迹" : `${selected.points?.length ?? 0} 个可绘制点`} · ${message}` : message || "选择机场后读取程序")}</div></div>;
}

function Field({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string }) { return <label className="form-field"><span>{label}</span><input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} /></label>; }

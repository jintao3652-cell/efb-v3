import { useState } from "react";
import { ArrowLeftRight, CloudSun, Ellipsis, Map, Plus, Route, Star, Trash2, X } from "lucide-react";
import type { FlightPlanAirportPanelData, FlightPlanData } from "../../types";

export type ProcedurePhase = "sid" | "star" | "approach";
export interface ProcedureOption { name: string; runways: string[] }

interface FlightPlanPanelProps {
  data: FlightPlanData;
  onHide: () => void;
  onUnload: () => void;
  onEdit: () => void;
  onOpenCharts: (icao: string) => void;
  onRemoveAlternate: () => void;
  onViewSimBrief: () => void;
  availableApproaches: ProcedureOption[];
  onSelectApproach: (approach: string) => void;
  // Navigraph §4.3 程序选择：radio 选用（转实线）、点名字在地图上紫色高亮预览、
  // Visual overview 固定开启——始终铺画当前跑道的候选程序（§4.3.1 步骤 8/11）。
  availableDepartures: ProcedureOption[];
  availableArrivals: ProcedureOption[];
  onSelectProcedure: (phase: ProcedurePhase, name: string) => void;
  onPreviewProcedure: (phase: ProcedurePhase, name: string | null) => void;
}

function distinctText(values: string[]) {
  const seen = new Set<string>();
  return values.filter((value) => {
    const normalized = value.trim().toUpperCase();
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function AirportIdentity({ airport }: { airport: FlightPlanAirportPanelData }) {
  const codes = distinctText([airport.icao, airport.iata]);
  return <div className="flight-panel-airport-identity"><h3>{codes.join(" / ") || "----"}</h3><span className={airport.vfr ? "vfr" : "ifr"}><i />{airport.vfr ? "VFR" : "IFR"}</span><p>{airport.name || airport.icao || "未知机场"}</p><small>{airport.city || "城市资料暂缺"}</small></div>;
}

function IconButton({ label, children, onClick }: { label: string; children: React.ReactNode; onClick: () => void }) {
  return <button className="flight-panel-icon-button" type="button" aria-label={label} title={label} onClick={onClick}>{children}</button>;
}

function AirportMetar({ airport, onClose }: { airport: FlightPlanAirportPanelData; onClose: () => void }) {
  return <div className="flight-panel-metar"><div><span><CloudSun size={15} /><strong>{airport.icao} METAR</strong></span><button type="button" onClick={onClose} aria-label="关闭 METAR"><X size={14} /></button></div><p>{airport.metar || "当前机场 METAR 暂不可用"}</p></div>;
}

// Navigraph §4.3：程序列表里「当前跑道支持的程序」置顶（Charts only shows the two
// procedures for departing from RWY 19L at the very top），并标注所属跑道。
function ProcedurePicker({ title, phase, options, current, runway, onClose, onSelect, onPreview }: {
  title: string;
  phase: ProcedurePhase;
  options: ProcedureOption[];
  current: string;
  runway: string;
  onClose: () => void;
  onSelect: (name: string) => void;
  onPreview: (name: string | null) => void;
}) {
  const supportsCurrentRunway = (option: ProcedureOption) => Boolean(runway && option.runways.some((item) => item.toUpperCase() === runway.trim().toUpperCase()));
  const sorted = [...options].sort((first, second) => Number(supportsCurrentRunway(second)) - Number(supportsCurrentRunway(first)));
  return <div className="flight-panel-approach-picker flight-panel-procedure-picker">
    <div><strong>{title}</strong><button type="button" onClick={onClose}>Close</button></div>
    {current && <button type="button" className={current ? "" : "active"} onClick={() => { onSelect(""); onPreview(null); }}>不使用程序</button>}
    {sorted.map((option) => <div className={`flight-panel-procedure-item ${phase}`} key={option.name}>
      <button type="button" className={"flight-panel-procedure-radio" + (current === option.name ? " active" : "")} aria-label={`选用 ${option.name}`} title={`选用 ${option.name}`} onClick={() => { onSelect(option.name); onPreview(null); }} />
      <button type="button" className={"flight-panel-procedure-name" + (current === option.name ? " selected" : "")} title="在地图上预览该程序" onClick={() => onPreview(current === option.name ? null : option.name)}>{option.name}</button>
      {supportsCurrentRunway(option) && <small>{runway}</small>}
    </div>)}
    {!sorted.length && <p className="flight-panel-procedure-empty">导航数据中没有可用的程序</p>}
  </div>;
}

function AirportSection({ side, data, onEdit, onOpenCharts, onOpenProcedures, onOpenApproaches }: { side: "origin" | "destination"; data: FlightPlanData["origin"] | FlightPlanData["destination"]; onEdit: () => void; onOpenCharts: (icao: string) => void; onOpenProcedures?: () => void; onOpenApproaches?: () => void }) {
  const [metarOpen, setMetarOpen] = useState(false);
  const destination = side === "destination" ? data as FlightPlanData["destination"] : undefined;
  const procedure = side === "origin" ? (data as FlightPlanData["origin"]).sid : destination?.star;
  const procedureLabel = side === "origin" ? "Departure" : "Arrival";
  const roleLabel = side === "origin" ? "DEP" : "ARR";
  return <section className={`flight-panel-airport-section ${side}`}>
    <div className="flight-panel-section-heading">{side === "origin" ? "Origin" : "Destination"}</div>
    <div className="flight-panel-airport-card">
      <AirportIdentity airport={data} />
      <div className="flight-panel-airport-actions"><IconButton label="编辑机场" onClick={onEdit}><ArrowLeftRight size={17} /></IconButton><IconButton label={`打开 ${data.icao} 航图库`} onClick={() => onOpenCharts(data.icao)}><Map size={17} /></IconButton><IconButton label={`查看 ${data.icao} METAR`} onClick={() => setMetarOpen((open) => !open)}><CloudSun size={18} /></IconButton>{destination && <button className="flight-panel-autoroute" type="button" onClick={onEdit}><Route size={14} />Autoroute</button>}</div>
    </div>
    {metarOpen && <AirportMetar airport={data} onClose={() => setMetarOpen(false)} />}
    <div className="flight-panel-runway-row"><div><span>Runway</span><strong>{data.runway || "--"}</strong></div><div className="flight-panel-wind">{data.wind || "风向暂缺"}</div><em className={side === "origin" ? "dep" : "arr"}>{roleLabel}</em><IconButton label={`选择${side === "origin" ? "起飞" : "落地"}跑道`} onClick={onEdit}><ArrowLeftRight size={17} /></IconButton><IconButton label="更多跑道选项" onClick={onEdit}><Ellipsis size={18} /></IconButton></div>
    <div className="flight-panel-procedure-row"><div><span>{procedureLabel}</span><strong>{procedure || "未选择"}</strong></div><div><span>Transition</span><strong>{data.transition || "未选择"}</strong></div><IconButton label={`选择${side === "origin" ? "离场" : "进场"}程序`} onClick={onOpenProcedures ?? onEdit}><ArrowLeftRight size={17} /></IconButton><IconButton label="更多程序选项" onClick={onOpenProcedures ?? onEdit}><Ellipsis size={18} /></IconButton></div>
    {destination && <div className="flight-panel-approaches"><span><b>{destination.approachesCount}</b> Approaches available</span><button type="button" disabled={destination.approachesCount === 0} onClick={onOpenApproaches}>Select</button>{destination.approach && <small>当前：{destination.approach}</small>}</div>}
  </section>;
}

function AlternateSection({ airport, onEdit, onOpenCharts, onRemove }: { airport: FlightPlanAirportPanelData; onEdit: () => void; onOpenCharts: (icao: string) => void; onRemove: () => void }) {
  const [metarOpen, setMetarOpen] = useState(false);
  return <><div className="flight-panel-alternate-card"><AirportIdentity airport={airport} /><div className="flight-panel-airport-actions"><IconButton label="删除备降机场" onClick={onRemove}><Trash2 size={17} /></IconButton><IconButton label={`打开 ${airport.icao} 航图库`} onClick={() => onOpenCharts(airport.icao)}><Map size={17} /></IconButton><IconButton label={`查看 ${airport.icao} METAR`} onClick={() => setMetarOpen((open) => !open)}><CloudSun size={18} /></IconButton></div></div>{metarOpen && <AirportMetar airport={airport} onClose={() => setMetarOpen(false)} />}<div className="flight-panel-alternate-actions"><button type="button" onClick={onEdit}><Plus size={15} />Add Alternate</button><button type="button" onClick={onEdit}><Plus size={15} />Oceanic Track</button></div></>;
}

export function FlightPlanPanel({ data, onHide, onUnload, onEdit, onOpenCharts, onRemoveAlternate, onViewSimBrief, availableApproaches, onSelectApproach, availableDepartures, availableArrivals, onSelectProcedure, onPreviewProcedure }: FlightPlanPanelProps) {
  const [picker, setPicker] = useState<"dep" | "arr" | "app" | null>(null);
  const togglePicker = (key: "dep" | "arr" | "app") => setPicker((current) => (current === key ? null : key));
  return <aside className="flight-plan-panel" aria-label="当前飞行计划">
    <header className="flight-plan-panel-header"><button type="button" onClick={() => { if (window.confirm("确认从航图地图卸载当前飞行计划面板？")) onUnload(); }}>Unload</button><strong>{data.origin.icao} to {data.destination.icao} ({data.callsign || "NO CALLSIGN"}) <Star size={18} /></strong><button type="button" onClick={onHide}>Hide</button></header>
    <button className="flight-panel-ofp" type="button" onClick={onViewSimBrief}>View SimBrief OFP</button>
    <AirportSection side="origin" data={data.origin} onEdit={onEdit} onOpenCharts={onOpenCharts} onOpenProcedures={() => togglePicker("dep")} />
    {picker === "dep" && <ProcedurePicker title="Select Departure" phase="sid" options={availableDepartures} current={data.origin.sid} runway={data.origin.runway} onClose={() => setPicker(null)} onSelect={(name) => onSelectProcedure("sid", name)} onPreview={(name) => onPreviewProcedure("sid", name)} />}
    <AirportSection side="destination" data={data.destination} onEdit={onEdit} onOpenCharts={onOpenCharts} onOpenProcedures={() => togglePicker("arr")} onOpenApproaches={() => togglePicker("app")} />
    {picker === "arr" && <ProcedurePicker title="Select Arrival" phase="star" options={availableArrivals} current={data.destination.star} runway={data.destination.runway} onClose={() => setPicker(null)} onSelect={(name) => onSelectProcedure("star", name)} onPreview={(name) => onPreviewProcedure("star", name)} />}
    {/* Navigraph §4.3 步骤 13：进近与 SID/STAR 同一套交互——点名字预览、radio 选用；overview 固定开启。 */}
    {picker === "app" && <ProcedurePicker title="Select Approach" phase="approach" options={availableApproaches} current={data.destination.approach} runway={data.destination.runway} onClose={() => setPicker(null)} onSelect={(name) => { onSelectProcedure("approach", name); }} onPreview={(name) => onPreviewProcedure("approach", name)} />}
    <section className="flight-panel-alternates"><div className="flight-panel-section-heading">Destination Alternates</div>{data.alternate ? <AlternateSection airport={data.alternate} onEdit={onEdit} onOpenCharts={onOpenCharts} onRemove={onRemoveAlternate} /> : <><p className="flight-panel-empty">尚未选择备降机场</p><div className="flight-panel-alternate-actions"><button type="button" onClick={onEdit}><Plus size={15} />Add Alternate</button><button type="button" onClick={onEdit}><Plus size={15} />Oceanic Track</button></div></>}</section>
  </aside>;
}

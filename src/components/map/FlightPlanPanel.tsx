import { useState } from "react";
import { ArrowLeftRight, CloudSun, Ellipsis, Map, Plus, Route, Star, Trash2, X } from "lucide-react";
import type { FlightPlanAirportPanelData, FlightPlanData } from "../../types";

interface FlightPlanPanelProps {
  data: FlightPlanData;
  onHide: () => void;
  onUnload: () => void;
  onEdit: () => void;
  onOpenCharts: (icao: string) => void;
  onRemoveAlternate: () => void;
  onViewSimBrief: () => void;
  availableApproaches: string[];
  onSelectApproach: (approach: string) => void;
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

function AirportSection({ side, data, onEdit, onOpenCharts, onOpenApproaches }: { side: "origin" | "destination"; data: FlightPlanData["origin"] | FlightPlanData["destination"]; onEdit: () => void; onOpenCharts: (icao: string) => void; onOpenApproaches?: () => void }) {
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
    <div className="flight-panel-procedure-row"><div><span>{procedureLabel}</span><strong>{procedure || "未选择"}</strong></div><div><span>Transition</span><strong>{data.transition || "未选择"}</strong></div><IconButton label={`选择${side === "origin" ? "离场" : "进场"}程序`} onClick={onEdit}><ArrowLeftRight size={17} /></IconButton><IconButton label="更多程序选项" onClick={onEdit}><Ellipsis size={18} /></IconButton></div>
    {destination && <div className="flight-panel-approaches"><span><b>{destination.approachesCount}</b> Approaches available</span><button type="button" disabled={destination.approachesCount === 0} onClick={onOpenApproaches}>Select</button>{destination.approach && <small>当前：{destination.approach}</small>}</div>}
  </section>;
}

function AlternateSection({ airport, onEdit, onOpenCharts, onRemove }: { airport: FlightPlanAirportPanelData; onEdit: () => void; onOpenCharts: (icao: string) => void; onRemove: () => void }) {
  const [metarOpen, setMetarOpen] = useState(false);
  return <><div className="flight-panel-alternate-card"><AirportIdentity airport={airport} /><div className="flight-panel-airport-actions"><IconButton label="删除备降机场" onClick={onRemove}><Trash2 size={17} /></IconButton><IconButton label={`打开 ${airport.icao} 航图库`} onClick={() => onOpenCharts(airport.icao)}><Map size={17} /></IconButton><IconButton label={`查看 ${airport.icao} METAR`} onClick={() => setMetarOpen((open) => !open)}><CloudSun size={18} /></IconButton></div></div>{metarOpen && <AirportMetar airport={airport} onClose={() => setMetarOpen(false)} />}<div className="flight-panel-alternate-actions"><button type="button" onClick={onEdit}><Plus size={15} />Add Alternate</button><button type="button" onClick={onEdit}><Plus size={15} />Oceanic Track</button></div></>;
}

export function FlightPlanPanel({ data, onHide, onUnload, onEdit, onOpenCharts, onRemoveAlternate, onViewSimBrief, availableApproaches, onSelectApproach }: FlightPlanPanelProps) {
  const [approachesOpen, setApproachesOpen] = useState(false);
  return <aside className="flight-plan-panel" aria-label="当前飞行计划">
    <header className="flight-plan-panel-header"><button type="button" onClick={() => { if (window.confirm("确认从航图地图卸载当前飞行计划面板？")) onUnload(); }}>Unload</button><strong>{data.origin.icao} to {data.destination.icao} ({data.callsign || "NO CALLSIGN"}) <Star size={18} /></strong><button type="button" onClick={onHide}>Hide</button></header>
    <button className="flight-panel-ofp" type="button" onClick={onViewSimBrief}>View SimBrief OFP</button>
    <AirportSection side="origin" data={data.origin} onEdit={onEdit} onOpenCharts={onOpenCharts} />
    <AirportSection side="destination" data={data.destination} onEdit={onEdit} onOpenCharts={onOpenCharts} onOpenApproaches={() => setApproachesOpen(true)} />
    {approachesOpen && <div className="flight-panel-approach-picker"><div><strong>Select Approach</strong><button type="button" onClick={() => setApproachesOpen(false)}>Close</button></div><button type="button" className={!data.destination.approach ? "active" : ""} onClick={() => { onSelectApproach(""); setApproachesOpen(false); }}>不使用进近</button>{availableApproaches.map((approach) => <button type="button" className={data.destination.approach === approach ? "active" : ""} onClick={() => { onSelectApproach(approach); setApproachesOpen(false); }} key={approach}>{approach}</button>)}</div>}
    <section className="flight-panel-alternates"><div className="flight-panel-section-heading">Destination Alternates</div>{data.alternate ? <AlternateSection airport={data.alternate} onEdit={onEdit} onOpenCharts={onOpenCharts} onRemove={onRemoveAlternate} /> : <><p className="flight-panel-empty">尚未选择备降机场</p><div className="flight-panel-alternate-actions"><button type="button" onClick={onEdit}><Plus size={15} />Add Alternate</button><button type="button" onClick={onEdit}><Plus size={15} />Oceanic Track</button></div></>}</section>
  </aside>;
}

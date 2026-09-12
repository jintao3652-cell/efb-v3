import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { vatsimAtisLines, vatsimFacilityLabel, vatsimOnlineDuration, type VatsimController } from "../../lib/airspace";

interface ControllerDetailPanelProps {
  // 被点击扇区名下的席位。一个扇区可能同时有 ZBPE_CTR 与 ZBPE_N_CTR 在线，故用数组承载。
  controllers: VatsimController[];
  onClose: () => void;
}

export function ControllerDetailPanel({ controllers, onClose }: ControllerDetailPanelProps) {
  const [selectedCallsign, setSelectedCallsign] = useState(() => controllers[0]?.callsign ?? "");
  const [now, setNow] = useState(() => Date.now());
  // 「在线时间」是当前时刻减登录时刻，必须定时重算，否则卡片会停在打开那一秒的数值。
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const controller = controllers.find((item) => item.callsign === selectedCallsign) ?? controllers[0];
  if (!controller) return null;
  const atisLines = vatsimAtisLines(controller);
  return <aside className="controller-detail-panel" aria-label="管制席位详情">
    <div className="controller-detail-header"><div><strong>{controller.callsign}</strong><span>{controller.name || "未知管制员"} · VATSIM</span></div><button type="button" onClick={onClose} aria-label="关闭管制详情"><X size={18} /></button></div>
    {controllers.length > 1 && <div className="controller-detail-switch">{controllers.map((item) => <button type="button" className={item.callsign === controller.callsign ? "active" : ""} aria-pressed={item.callsign === controller.callsign} onClick={() => setSelectedCallsign(item.callsign)} key={item.callsign}>{item.callsign}</button>)}</div>}
    <div className="controller-detail-grid">
      <div><strong>{vatsimFacilityLabel(controller.facility)}</strong><span>设施类型</span></div>
      <div><strong>{controller.frequency || "----"}</strong><span>频率</span></div>
      <div><strong>{vatsimOnlineDuration(controller.logon_time, now)}</strong><span>在线时间</span></div>
    </div>
    {atisLines.length > 0 && <div className="controller-detail-atis">{atisLines.map((line, index) => <p key={`${index}-${line}`}>{line}</p>)}</div>}
  </aside>;
}

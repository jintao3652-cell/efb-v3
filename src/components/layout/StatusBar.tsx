import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getCurrentAiracCycle, isTauri } from "../../lib/tauri";
import { getRouteCycles } from "../../lib/xfly";
import { useAppStore } from "../../stores/app-store";

const pad = (value: number) => String(value).padStart(2, "0");

/**
 * 底部状态行：只放真实读数。
 * Z / 本地时间按秒刷新，AIRAC 周期复用顶栏原来的查询键，
 * 链接状态直接读 navigator.onLine，不伪造「在线」。
 */
export function StatusBar() {
  const [now, setNow] = useState(() => new Date());
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  const trafficSource = useAppStore((state) => state.trafficSource);

  const airac = useQuery({ queryKey: ["airac-cycle"], queryFn: getCurrentAiracCycle, staleTime: 60 * 60_000, retry: 0 });
  // 周期号以线上航路库为准，取不到再退回本地导航库。
  const cycles = useQuery({ queryKey: ["route-cycles"], queryFn: getRouteCycles, staleTime: 6 * 60 * 60_000, retry: 0 });
  const cycleLabel = cycles.data?.[0] ?? airac.data?.cycleId ?? "—";
  const navSource = cycles.data?.[0] ? "ROUTE DB" : airac.data ? "LOCAL NAVDB" : "PENDING";

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);

  const zulu = `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}`;
  const local = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const offset = -now.getTimezoneOffset() / 60;

  return <footer className="app-status" role="status" aria-label="系统状态">
    <span className="astat"><b>{zulu}</b>Z</span>
    <span className="astat">LOC <b>{local}</b></span>
    <span className="astat">UTC{offset >= 0 ? "+" : "−"}{Math.abs(offset)}</span>
    <span className="astat"><i className={`astat-led${online ? "" : " off"}`} />{online ? "LINK OK" : "LINK LOST"}</span>
    <span className="astat">SRC <b>{trafficSource.toUpperCase()}</b></span>
    <span className="astat">AIRAC <b>{cycleLabel}</b> <span className="muted">{navSource}</span></span>
    <span className="astat">{isTauri() ? "NAVDB LOCAL" : "BROWSER PREVIEW"}</span>
    <span className="astat astat-right">SKYBOARD EFB · © OPENSTREETMAP</span>
  </footer>;
}

export default StatusBar;

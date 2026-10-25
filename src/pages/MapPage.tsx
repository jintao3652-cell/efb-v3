import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronRight, FileImage, Layers, Layers2, ListTree, LocateFixed, Minus, Moon, PanelLeftClose,
  Plane, Plus, Radio, RotateCcw, Sun, X,
} from "lucide-react";
import { MapCanvas, type MapCanvasHandle } from "../map/MapCanvas";
import { chartPdf } from "../map/chart-overlay";
import { useAppStore, mapLayerLabels, type MapLayerKey, type ProcedureSelection, type SelectedPoint, type TrafficSource } from "../stores/app-store";
import {
  getNavigationAirportDetails, getNavigationAirportProcedures, getNavigationProcedurePoints,
  isTauri, type NavigationProcedureSummary,
} from "../lib/tauri";
import { loadOnlineTraffic } from "../lib/traffic";
import type { VatsimPilot } from "../lib/airspace";
import { pilotRouteQueryOptions, pilotTrackQueryOptions, trackGapNm, trackStats } from "../lib/pilot-track";
import { loadAdHpAirports } from "../lib/airport-data";
import type { Airport } from "../types";
import { airports as fallbackAirports } from "../lib/data";
import { procedureSupportsRunway } from "../lib/route-procedures";
import { getAirport, getFrequencies, getRunways, surfaceLabel } from "../lib/xfly";
import { groupComms, jeppAirportOverview, jeppCharts, chartRunways, type JeppChart } from "../lib/jepp";

const layerOrder: MapLayerKey[] = ["airways", "waypoints", "airports", "airspace", "onlineControl", "ground", "traffic", "route", "chart", "weather"];

function mhzLabel(value: number) {
  return Number(value).toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

/** J3N 周期 YYYYMMDD → AIRAC 编号（2026 + 10 → 2610）。 */
function airacLabel(cycle: { datacycle: string; datacycleyear?: string } | null | undefined) {
  if (!cycle?.datacycle) return "";
  return `${cycle.datacycleyear ? cycle.datacycleyear.slice(-2) : ""}${cycle.datacycle}`;
}

/** 航司三字码 → static/airline 里的 logo；呼号前三位就是航司码（CSN1234 → CSN）。 */
const airlineModules = import.meta.glob("../../static/airline/*.png", { eager: true, query: "?url", import: "default" }) as Record<string, string>;
const airlineLogos = new Map<string, string>();
for (const [file, url] of Object.entries(airlineModules)) {
  const code = file.replaceAll("\\", "/").split("/").pop()?.replace(/\.png$/i, "").toUpperCase();
  if (code) airlineLogos.set(code, url);
}

function airlineLogo(callsign: string) {
  return airlineLogos.get(callsign.trim().slice(0, 3).toUpperCase()) ?? "";
}

function formatMinutes(minutes: number) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/**
 * 在线航班卡片。
 *
 * 点开一架飞机时同时做两件事：把飞行计划里的航路串交给 `parseRoute` 解析成
 * 航点（地图上画成蓝色虚线），再从 vataware / XFS 取这趟连线的历史轨迹
 * （橙色实线）。两个请求的 key 与地图组件完全一致，只发一次。
 */
function PilotCard({ pilot, source, onClose, onFrameRoute }: { pilot: VatsimPilot; source: TrafficSource; onClose: () => void; onFrameRoute: () => void }) {
  const track = useQuery(pilotTrackQueryOptions(pilot, source));
  const plan = pilot.flight_plan;
  const routeText = (plan?.route || track.data?.routeText || "").trim();
  const parsed = useQuery(pilotRouteQueryOptions(routeText));
  const stats = trackStats(track.data);
  const waypoints = parsed.data?.points ?? [];
  const departure = plan?.departure || track.data?.departure || "";
  const arrival = plan?.arrival || track.data?.arrival || "";
  const aircraft = plan?.aircraft_short || plan?.aircraft || track.data?.aircraft || "";
  const logo = airlineLogo(pilot.callsign);
  // 「航点 ZBAA 未找到坐标」这种是起降机场本来就进不了航路点表，卡片上已经有起降场，滤掉。
  const warning = (parsed.data?.warnings ?? []).find(
    (text) => !(departure && text.includes(departure)) && !(arrival && text.includes(arrival)),
  ) ?? "";

  return <section className="point-card pilot-card">
    <header>
      <span>在线航班 · {source === "vatsim" ? "VATSIM" : "XFS"}</span>
      <button onClick={onClose} aria-label="关闭"><X size={14} /></button>
    </header>
    <strong>{logo ? <><img className="airline-logo" src={logo} alt="" />{pilot.callsign}</> : pilot.callsign}</strong>
    <p>{pilot.name || "未知机组"} · CID {pilot.cid}</p>
    <div className="pc-legs">
      <div><span>起飞</span><b>{departure || "----"}</b></div>
      <ChevronRight size={15} />
      <div><span>降落</span><b>{arrival || "----"}</b></div>
      {aircraft && <em>{aircraft}</em>}
    </div>
    <div className="pc-chips">
      <span>FL{String(Math.round(pilot.altitude / 100)).padStart(3, "0")}</span>
      <span>{Math.round(pilot.groundspeed)} kt</span>
      <span>{Math.round(pilot.heading) % 360}°</span>
      {plan?.enroute_time ? <span>{plan.enroute_time}</span> : null}
    </div>

    <h4 className="pc-h4">计划航路{parsed.data?.cycle ? <em>AIRAC {parsed.data.cycle}</em> : null}</h4>
    {routeText
      ? <code className="pc-route" title={routeText}>{routeText}</code>
      : <p className="pc-note">该机组没有提交航路串，只能看历史轨迹。</p>}
    {waypoints.length > 0 && <div className="pc-wpts">
      {waypoints.slice(0, 12).map((point, index) => <span key={`${point.ident}-${index}`}>{point.ident}</span>)}
      {waypoints.length > 12 && <span className="more">+{waypoints.length - 12}</span>}
    </div>}
    {parsed.isFetching && routeText ? <p className="pc-note">正在解析航路点…</p> : null}
    {!parsed.isFetching && warning ? <p className="pc-note warn">{warning}</p> : null}

    <h4 className="pc-h4">历史轨迹</h4>
    {track.isPending
      ? <p className="pc-note">正在读取{source === "vatsim" ? " vataware 连线记录" : " XFS 飞行轨迹"}…</p>
      : track.isError
        ? <p className="pc-note warn">{(track.error as Error).message}</p>
        : stats
          ? <div className="pc-stats">
              <div><span>已飞</span><b>{stats.distanceNm.toFixed(0)} NM</b></div>
              <div><span>时长</span><b>{formatMinutes(stats.minutes)}</b></div>
              <div><span>采样</span><b>{stats.points}</b></div>
            </div>
          : <p className="pc-note">轨迹点不足，画不出航迹。</p>}
    {track.data ? <p className="pc-src">{track.data.note} · 航迹已画在地图上</p> : null}
    <button className="btn soft sm block" style={{ marginTop: 8 }} onClick={onFrameRoute}>
      <LocateFixed size={12} />看整趟航路
    </button>
    {track.data && trackGapNm(track.data, pilot.latitude, pilot.longitude) > 120
      ? <p className="pc-note warn">轨迹末点距当前位置 {Math.round(trackGapNm(track.data, pilot.latitude, pilot.longitude))} NM，显示的多半是上一趟连线。</p>
      : null}
  </section>;
}

function PointCard({ pilots, source, onFrameRoute }: { pilots: VatsimPilot[]; source: TrafficSource; onFrameRoute: () => void }) {
  const point = useAppStore((state) => state.selectedPoint);
  const setSelectedPoint = useAppStore((state) => state.setSelectedPoint);
  const setSelectedAirport = useAppStore((state) => state.setSelectedAirport);
  if (!point) return null;
  const isFlight = point.type !== "airport" && point.type !== "navaid" && (point.detail === "VATSIM" || point.detail === "XFS");
  if (isFlight) {
    const pilot = pilots.find((item) => item.callsign === point.ident);
    if (pilot) return <PilotCard pilot={pilot} source={source} onClose={() => setSelectedPoint(null)} onFrameRoute={onFrameRoute} />;
  }
  const label = point.type === "airport" ? "机场" : point.type === "navaid" ? "导航台" : isFlight ? "在线航班" : "航路点";
  return <section className="point-card">
    <header>
      <span>{label}</span>
      <button onClick={() => setSelectedPoint(null)} aria-label="关闭"><X size={14} /></button>
    </header>
    <strong>{point.ident}</strong>
    <p>{point.name || point.detail || "—"}</p>
    <small>{point.latitude.toFixed(4)}° / {point.longitude.toFixed(4)}°</small>
    {point.type === "airport" && <button className="btn soft sm block" style={{ marginTop: 10 }} onClick={() => setSelectedAirport(point.ident)}>
      <ListTree size={13} />查看机场资料
    </button>}
  </section>;
}

function AirportDock({ onClose, onLocate, onGround, tab, onTabChange }: {
  onClose: () => void;
  onLocate: (latitude: number, longitude: number) => void;
  onGround: (latitude: number, longitude: number) => void;
  tab: "proc" | "info";
  onTabChange: (tab: "proc" | "info") => void;
}) {
  const icao = useAppStore((state) => state.selectedAirport) ?? "";
  const procedure = useAppStore((state) => state.procedure);
  const setProcedure = useAppStore((state) => state.setProcedure);
  const [kind, setKind] = useState<"SID" | "STAR" | "APP">("SID");
  const [runway, setRunway] = useState("");

  const catalog = useQuery({ queryKey: ["ad-hp-airports"], queryFn: loadAdHpAirports, staleTime: Infinity });
  // AD_HP 只收录国内机场；境外机场从 XFS 补名字 / 城市 / 坐标，保证标题与「定位到机场」可用。
  const xflyInfo = useQuery({
    queryKey: ["xfly-airport-info", icao],
    queryFn: () => getAirport(icao),
    enabled: icao.length === 4,
    staleTime: 30 * 60_000,
    retry: 0,
  });
  const localAirport = (catalog.data ?? fallbackAirports).find((item) => item.icao === icao);
  const airport: Airport | undefined = localAirport ?? (xflyInfo.data ? {
    icao,
    iata: xflyInfo.data.iataCode ?? "",
    name: xflyInfo.data.cnName || xflyInfo.data.enName || icao,
    city: xflyInfo.data.municipalityCn || xflyInfo.data.municipality || "",
    elevation: xflyInfo.data.elevationFt != null ? `${xflyInfo.data.elevationFt.toLocaleString("en-US")} ft` : "未知",
    runways: [],
    frequencies: [],
    latitude: xflyInfo.data.latitudeDeg,
    longitude: xflyInfo.data.longitudeDeg,
  } : undefined);
  const procedures = useQuery({
    queryKey: ["nav-procedures", icao],
    queryFn: () => getNavigationAirportProcedures(icao),
    enabled: isTauri() && icao.length === 4,
    staleTime: 10 * 60_000,
    retry: 0,
  });
  const details = useQuery({
    queryKey: ["nav-airport-details", icao],
    queryFn: () => getNavigationAirportDetails(icao),
    enabled: isTauri() && icao.length === 4,
    staleTime: 10 * 60_000,
    retry: 0,
  });
  // 机场资料优先 JeppQuery（跑道入口标高 / 全场频率 / AIRAC），XFly 补中文名、道面与停机位。
  const overview = useQuery({
    queryKey: ["jepp-overview", icao],
    queryFn: () => jeppAirportOverview(icao),
    enabled: icao.length === 4,
    staleTime: 60 * 60_000,
    retry: 0,
  });
  const xflyRunways = useQuery({ queryKey: ["xfly-runways", icao], queryFn: () => getRunways(icao), enabled: icao.length === 4, staleTime: 60 * 60_000, retry: 0 });
  const xflyFreqs = useQuery({ queryKey: ["xfly-frequencies", icao], queryFn: () => getFrequencies(icao), enabled: icao.length === 4, staleTime: 60 * 60_000, retry: 0 });

  const list: NavigationProcedureSummary[] = kind === "SID"
    ? procedures.data?.sids ?? []
    : kind === "STAR"
      ? procedures.data?.stars ?? []
      : procedures.data?.approaches ?? [];

  // AD_HP 只有机场基础字段，浏览器预览用内置样例补齐跑道/频率，桌面端仍以导航库为准。
  const sample = fallbackAirports.find((item) => item.icao === icao);
  const baseRunways = airport?.runways.length ? airport.runways : sample?.runways ?? [];
  const baseFrequencies = airport?.frequencies.length ? airport.frequencies : sample?.frequencies ?? [];

  const jepp = overview.data ?? null;
  const surfaceByIdent = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of xflyRunways.data ?? []) {
      map.set(row.leIdent.toUpperCase(), surfaceLabel(row.surface));
      map.set(row.heIdent.toUpperCase(), surfaceLabel(row.surface));
    }
    return map;
  }, [xflyRunways.data]);
  const commGroups = useMemo(
    () => groupComms(jepp?.comms ?? []).map((group) => ({ type: group.type, value: group.values.map(mhzLabel).join(" · ") })),
    [jepp],
  );
  const jeppRunways = useMemo(
    () => [...(jepp?.runways ?? [])].sort((a, b) => a.ident.localeCompare(b.ident, "en", { numeric: true })),
    [jepp],
  );

  const runways = useMemo(() => {
    const pool = new Set<string>();
    for (const item of [...(procedures.data?.sids ?? []), ...(procedures.data?.stars ?? []), ...(procedures.data?.approaches ?? [])]) item.runways.forEach((value) => pool.add(value));
    for (const item of baseRunways) {
      const value = item.split(" ")[0]?.split("/")[0];
      if (value) pool.add(value);
    }
    return [...pool];
  }, [procedures.data, baseRunways]);

  useEffect(() => { setRunway(""); }, [icao]);
  const visible = runway ? list.filter((item) => procedureSupportsRunway(item, runway)) : list;

  return <aside className="ctx-panel ap-dock">
    <div className="ctx-head">
      <button className="icon-btn" onClick={onClose} aria-label="收起"><PanelLeftClose size={15} /></button>
      <h3>机场资料</h3>
      <button className="icon-btn" onClick={() => airport && onGround(airport.latitude, airport.longitude)} aria-label="机场地面" title="查看机场地面与机位"><Plane size={15} /></button>
    </div>
    <div className="ap-dock-title">
      <div>
        <h2>{icao || "----"}<small>{airport?.iata ?? ""}</small></h2>
        <p>{airport?.name ?? "选择机场以加载程序与频率"}</p>
      </div>
      <span className="count">{visible.length} 份</span>
    </div>
    <div className="seg block" style={{ margin: "0 10px 10px" }}>
      <button className={tab === "proc" ? "active" : ""} onClick={() => onTabChange("proc")}>程序</button>
      <button className={tab === "info" ? "active" : ""} onClick={() => onTabChange("info")}>信息</button>
    </div>
    <div className="ctx-body">
      {tab === "proc" ? <>
        <div className="seg block" style={{ margin: "0 2px 8px" }}>
          {(["SID", "STAR", "APP"] as const).map((value) => <button key={value} className={kind === value ? "active" : ""} onClick={() => { setKind(value); setRunway(""); }}>
            {value === "SID" ? "离场" : value === "STAR" ? "进场" : "进近"}
          </button>)}
        </div>
        <div className="chart-filter-row">
          <button className={`chip ${runway ? "" : "active"}`} onClick={() => setRunway("")}>全部跑道</button>
          {runways.map((value) => <button key={value} className={`chip ${runway === value ? "active" : ""}`} onClick={() => setRunway(value)}>RW{value}</button>)}
        </div>
        {!isTauri() && <p className="empty">浏览器预览模式：程序数据需在桌面端读取本地导航数据库。</p>}
        {isTauri() && visible.length === 0 && !procedures.isFetching && <p className="empty">该跑道暂无可用程序</p>}
        {visible.map((item) => {
          const selected = procedure?.id === item.id;
          return <button key={item.id} className={`list-item ${selected ? "active" : ""}`} onClick={() => {
            setProcedure(selected ? null : { id: item.id, icao, kind, name: item.name, runway: runway || item.runways[0] || "", transition: item.transitions[0] ?? "" });
          }}>
            <span className="li-icon"><Layers2 size={15} /></span>
            <span className="li-main"><strong>{item.name}</strong><small>{kind === "SID" ? "离场" : kind === "STAR" ? "进场" : "进近"} · {item.runways.join(" / ") || "ALL"}</small></span>
            <ChevronRight size={14} style={{ color: "var(--muted-2)" }} />
          </button>;
        })}
      </> : <>
        <div className="ap-kv">
          <div><span>标高</span><strong>{jepp?.elevation_ft != null ? `${jepp.elevation_ft.toLocaleString("en-US")} ft` : airport?.elevation ?? "—"}</strong></div>
          <div><span>城市</span><strong>{jepp?.city ?? airport?.city ?? "—"}</strong></div>
        </div>
        {jepp && <p className="dock-src">Jeppesen{jepp.cycle ? ` · AIRAC ${airacLabel(jepp.cycle)}` : ""}{jepp.magnetic_variation ? ` · 磁差 ${jepp.magnetic_variation}` : ""}{jepp.utc_offset ? ` · ${jepp.utc_offset}` : ""}</p>}
        <h4 className="dock-h4">跑道</h4>
        <ul className="dock-list">
          {jeppRunways.map((row) => <li key={row.ident}>
            <Radio size={13} />{row.ident} · {Number(row.length_ft).toLocaleString("en-US")} ft · {surfaceByIdent.get(row.ident.toUpperCase()) ?? `${row.elevation_ft} ft`}
          </li>)}
          {!jeppRunways.length && (xflyRunways.data ?? []).map((row) => <li key={`${row.leIdent}-${row.heIdent}`}>
            <Radio size={13} />{row.leIdent}/{row.heIdent} · {Number(row.lengthFt).toLocaleString("en-US")} ft · {surfaceLabel(row.surface)}
          </li>)}
          {!jeppRunways.length && !(xflyRunways.data ?? []).length && (details.data?.runways.length ? details.data.runways : baseRunways).map((value) => <li key={value}><Radio size={13} />{value}</li>)}
          {!jeppRunways.length && !(xflyRunways.data ?? []).length && !details.data?.runways.length && !baseRunways.length && <li className="muted">暂无跑道数据</li>}
        </ul>
        <h4 className="dock-h4">管制单位及频率</h4>
        <table className="freq-table">
          <thead><tr><th>单位</th><th>频率</th></tr></thead>
          <tbody>
            {commGroups.map((row) => <tr key={row.type}><td>{row.type}</td><td className="mono">{row.value}</td></tr>)}
            {!commGroups.length && (xflyFreqs.data ?? []).map((row) => <tr key={`${row.type}-${row.description}-${row.frequencyMhz}`}><td>{row.description || row.type}</td><td>{row.frequencyMhz}</td></tr>)}
            {!commGroups.length && !(xflyFreqs.data ?? []).length && (details.data?.frequencies.length ? details.data.frequencies : baseFrequencies).map((row) => <tr key={`${row.name}-${row.value}`}><td>{row.name}</td><td>{row.value}</td></tr>)}
            {!commGroups.length && !(xflyFreqs.data ?? []).length && !details.data?.frequencies.length && !baseFrequencies.length && <tr><td colSpan={2} className="muted">暂无频率数据</td></tr>}
          </tbody>
        </table>
      </>}
    </div>
    <div className="ctx-foot">
      <button className="btn primary block" disabled={!airport} onClick={() => airport && onLocate(airport.latitude, airport.longitude)}>
        <LocateFixed size={14} />定位到机场
      </button>
    </div>
  </aside>;
}

/**
 * 航图叠加面板：列出当前机场里带地理配准的 Jepp 航图，点一张就叠到地图上。
 * 只有 `is_georeferenced` 的图能叠——没配准的图不知道该贴在哪，
 * 服务端算不出 bbox 就没法换算四角。
 */
type ChartKind = "全部" | "机场" | "离场" | "进场" | "进近";

function chartKind(category: string): Exclude<ChartKind, "全部"> {
  const value = (category ?? "").trim().toUpperCase();
  if (value === "DEPARTURE") return "离场";
  if (value === "ARRIVAL") return "进场";
  if (value === "APPROACH") return "进近";
  return "机场";
}

function ChartOverlayPanel({ onClose, onFrame }: { onClose: () => void; onFrame: () => void }) {
  const icao = useAppStore((state) => state.selectedAirport) ?? "";
  const overlay = useAppStore((state) => state.chartOverlay);
  const status = useAppStore((state) => state.chartOverlayStatus);
  const error = useAppStore((state) => state.chartOverlayError);
  const setOverlay = useAppStore((state) => state.setChartOverlay);
  const patchOverlay = useAppStore((state) => state.patchChartOverlay);
  const [kind, setKind] = useState<ChartKind>("全部");

  const charts = useQuery({
    queryKey: ["jepp-charts", icao],
    // geo=1 带回已缓存的地理范围；新图要等第一次 /geo/bounds 现算，选中时再取。
    queryFn: () => jeppCharts(icao, true),
    enabled: icao.length === 4,
    staleTime: 30 * 60_000,
    retry: 0,
  });

  const georeferenced = useMemo(() => (charts.data?.charts ?? []).filter((chart) => chart.is_georeferenced), [charts.data]);
  const kinds = useMemo(() => {
    const present = new Set(georeferenced.map((chart) => chartKind(chart.category)));
    return (["全部", "机场", "离场", "进场", "进近"] as ChartKind[]).filter((value) => value === "全部" || present.has(value));
  }, [georeferenced]);
  const rows = useMemo(() => {
    const list = kind === "全部" ? georeferenced : georeferenced.filter((chart) => chartKind(chart.category) === kind);
    return [...list].sort((a, b) => String(a.index_no).localeCompare(String(b.index_no), "en", { numeric: true }));
  }, [georeferenced, kind]);

  const pick = (chart: JeppChart) => {
    const active = overlay?.icao === icao && overlay.filename === chart.filename;
    if (active) {
      setOverlay(null);
      return;
    }
    setOverlay({
      icao,
      filename: chart.filename,
      indexNo: chart.index_no,
      title: chart.proc_id || chart.type_name,
      opacity: overlay?.opacity ?? 0.95,
      paper: overlay?.paper ?? "transparent",
    });
  };

  return <section className="chart-pop">
    <header>
      <span className="cp-ico"><FileImage size={15} /></span>
      <div className="grow">
        <strong>航图叠加</strong>
        <small>{icao ? `${icao} · ${georeferenced.length} 张可配准` : "先在地图上点一个机场"}</small>
      </div>
      <button onClick={onClose} aria-label="关闭"><X size={14} /></button>
    </header>

    {!icao && <p className="cp-empty">点地图上的机场，再从航图目录里挑一张叠上去。</p>}

    {icao && <>
      {kinds.length > 2 && <div className="cp-kinds">
        {kinds.map((value) => <button key={value} className={`chip ${kind === value ? "active" : ""}`} onClick={() => setKind(value)}>{value}</button>)}
      </div>}
      <div className="cp-list">
        {charts.isPending && <p className="cp-empty">正在读取 {icao} 的航图目录…</p>}
        {charts.isError && <p className="cp-empty warn">{(charts.error as Error).message}</p>}
        {!charts.isPending && !charts.isError && rows.length === 0 && <p className="cp-empty">该机场没有带地理配准的航图，叠加不了。</p>}
        {rows.map((chart) => {
          const active = overlay?.icao === icao && overlay.filename === chart.filename;
          const runways = chartRunways(chart);
          return <button key={chart.filename} className={`list-item ${active ? "active" : ""}`}
            onClick={() => pick(chart)}
            onMouseEnter={() => { void chartPdf(icao, chart.filename).catch(() => undefined); }}
            onFocus={() => { void chartPdf(icao, chart.filename).catch(() => undefined); }}
          >
            <span className="li-icon"><FileImage size={14} /></span>
            <span className="li-main">
              <strong>{chart.index_no} · {chart.proc_id || chart.type_name}</strong>
              <small>{chart.type_name}{runways ? ` · RW${runways}` : ""}</small>
            </span>
            {active && <i className="cp-on" />}
          </button>;
        })}
      </div>
    </>}

    {overlay && <div className="cp-tools">
      <div className="cp-now">
        <span className={`badge ${status === "ready" ? "green" : status === "error" ? "red" : "gray"}`}>
          {status === "loading" ? "渲染中" : status === "ready" ? "已叠加" : status === "error" ? "失败" : "待渲染"}
        </span>
        <span className="grow ellipsis" title={`${overlay.icao} ${overlay.indexNo} ${overlay.title}`}>{overlay.icao} {overlay.indexNo} {overlay.title}</span>
      </div>
      {error && <p className="cp-empty warn">{error}</p>}
      <label className="cp-slider">
        <span>不透明度</span>
        <input type="range" min={20} max={100} value={Math.round(overlay.opacity * 100)} onChange={(event) => patchOverlay({ opacity: Number(event.target.value) / 100 })} />
        <b>{Math.round(overlay.opacity * 100)}%</b>
      </label>
      <div className="cp-row">
        <button className={`chip ${overlay.paper === "transparent" ? "active" : ""}`} onClick={() => patchOverlay({ paper: "transparent" })} title="去掉纸面白底，只留线条和文字">去底</button>
        <button className={`chip ${overlay.paper === "opaque" ? "active" : ""}`} onClick={() => patchOverlay({ paper: "opaque" })} title="保留航图原本的纸张底色">纸面</button>
        <span className="grow" />
        <button className="link-btn" onClick={() => setOverlay(null)}>移除</button>
      </div>
      <button className="btn soft sm block" style={{ marginTop: 6 }} onClick={onFrame}><LocateFixed size={12} />定位到航图</button>
    </div>}
  </section>;
}

function ProcedureOverlay() {
  const procedure = useAppStore((state) => state.procedure);
  const setProcedure = useAppStore((state) => state.setProcedure);
  const points = useQuery({
    queryKey: ["proc-points", procedure?.id, procedure?.runway, procedure?.transition],
    queryFn: () => getNavigationProcedurePoints(procedure!.id, procedure!.runway, procedure!.transition),
    enabled: Boolean(procedure) && isTauri(),
    staleTime: 10 * 60_000,
    retry: 0,
  });
  const rows = points.data ?? [];

  if (!procedure) return null;
  return <>
    <section className="proc-card">
      <header>
        <div>
          <strong>{procedure.name}</strong>
          <small>{procedure.kind === "SID" ? "SID 离场" : procedure.kind === "STAR" ? "STAR 进场" : "IAC 进近"} · RW{procedure.runway || "—"}</small>
        </div>
        <button className="link-btn" onClick={() => setProcedure(null)}>关闭程序详情</button>
      </header>
      {rows.length > 0 && <div className="proc-chips">
        {rows.slice(0, 6).map((point, index) => <span className="proc-chip" key={`${point.ident}-${index}`}>
          <b>{point.ident || `L${index + 1}`}</b>
          <i>{point.legType ?? "TF"}</i>
        </span>)}
      </div>}
      <div className="proc-meta">
        {rows.length > 0 ? `${rows.length} legs · ${rows.length} 显示点` : isTauri() ? "正在读取程序航段…" : "浏览器预览模式不加载程序航段"}
      </div>
    </section>
  </>;
}

export function MapPage() {
  const mapRef = useRef<MapCanvasHandle>(null);
  const layers = useAppStore((state) => state.layers);
  const toggleLayer = useAppStore((state) => state.toggleLayer);
  const selectedAirport = useAppStore((state) => state.selectedAirport);
  const setSelectedAirport = useAppStore((state) => state.setSelectedAirport);
  const selectedPoint = useAppStore((state) => state.selectedPoint);
  const setSelectedPoint = useAppStore((state) => state.setSelectedPoint);
  const theme = useAppStore((state) => state.theme);
  const setTheme = useAppStore((state) => state.setTheme);
  const trafficSource = useAppStore((state) => state.trafficSource);
  const setTrafficSource = useAppStore((state) => state.setTrafficSource);
  const [layersOpen, setLayersOpen] = useState(false);
  const [chartOpen, setChartOpen] = useState(false);
  const [dockTab, setDockTab] = useState<"proc" | "info">("proc");

  const onlineTraffic = useQuery({
    queryKey: ["online-traffic", trafficSource],
    queryFn: ({ signal }) => loadOnlineTraffic(trafficSource, signal),
    refetchInterval: 30_000,
    // 开发模式 StrictMode 双挂载会把第一次的 signal abort 掉，共享的 in-flight 请求
    // 跟着失败，于是首帧会显示「离线」直到下一次轮询。给一次重试就不留这段难看窗口。
    retry: 1,
    retryDelay: 900,
    staleTime: 20_000,
    networkMode: "always",
  });
  const pilots = onlineTraffic.data?.pilots ?? [];
  const controllers = onlineTraffic.data?.controllers ?? [];

  // 从机场页「在地图查看机位」跳过来时会带一份坐标，挂载后直接飞过去。
  useEffect(() => {
    const raw = sessionStorage.getItem("efb:focus");
    if (!raw) return;
    sessionStorage.removeItem("efb:focus");
    let target: { icao: string; latitude: number; longitude: number } | null = null;
    try {
      target = JSON.parse(raw) as { icao: string; latitude: number; longitude: number };
    } catch {
      return;
    }
    if (!target || typeof target.latitude !== "number" || typeof target.longitude !== "number") return;
    const focus = target;
    setSelectedAirport(focus.icao);
    // 地图实例可能还没就绪，飞两次兜底（目标一致，视觉上是一次稍长的动画）。
    mapRef.current?.flyToAirport(focus.latitude, focus.longitude, 9.6);
    const timer = window.setTimeout(() => mapRef.current?.flyToAirport(focus.latitude, focus.longitude, 9.6), 900);
    return () => window.clearTimeout(timer);
  }, [setSelectedAirport]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ icao: string; latitude: number; longitude: number }>).detail;
      setSelectedAirport(detail.icao);
      mapRef.current?.flyToAirport(detail.latitude, detail.longitude, 9.5);
    };
    window.addEventListener("efb:focus-airport", handler);
    return () => window.removeEventListener("efb:focus-airport", handler);
  }, [setSelectedAirport]);

  return <div className="map-page">
    <MapCanvas
      ref={mapRef}
      onAirportClick={(icao) => { setDockTab("proc"); setSelectedAirport(icao); }}
      onMapClick={() => setSelectedPoint(null)}
    />

    <div className="hud-top">
      <div className="pill-group" title="在线交通数据源">
        <button className={trafficSource === "xfs" ? "on" : ""} onClick={() => setTrafficSource("xfs")}>XFS</button>
        <button className={trafficSource === "vatsim" ? "on" : ""} onClick={() => setTrafficSource("vatsim")}>VAT</button>
      </div>
      <div className="atc-pill">
        <Radio size={13} style={{ color: "var(--muted)" }} />
        <strong>{trafficSource === "vatsim" ? "VATSIM" : "XFS"}</strong>
        <span>{onlineTraffic.isError ? "离线" : `${pilots.length} 航班 · ${controllers.length} 席位`}</span>
        <div className="bars">
          {[0, 1, 2, 3].map((index) => <i key={index} style={{ background: ["#3b82f6", "#22c55e", "#f59e0b", "#ef4444"][index], opacity: index < 3 ? 1 : 0.3 }} />)}
        </div>
      </div>
    </div>

    <div className={"map-toolbar" + (selectedPoint ? " card-open" : "")}>
      <button onClick={() => mapRef.current?.zoomBy(1)} aria-label="放大"><Plus size={16} /></button>
      <button onClick={() => mapRef.current?.zoomBy(-1)} aria-label="缩小"><Minus size={16} /></button>
      <span />
      <button className={chartOpen ? "active" : ""} onClick={() => { setChartOpen((value) => !value); setLayersOpen(false); }} aria-label="航图叠加" title="航图叠加"><FileImage size={15} /></button>
      <button className={layersOpen ? "active" : ""} onClick={() => { setLayersOpen((value) => !value); setChartOpen(false); }} aria-label="图层"><Layers size={16} /></button>
      <button onClick={() => mapRef.current?.resetView()} aria-label="复位"><RotateCcw size={15} /></button>
      <button onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label="主题">{theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}</button>
    </div>

    {chartOpen && <ChartOverlayPanel onClose={() => setChartOpen(false)} onFrame={() => mapRef.current?.frameChart()} />}

    {layersOpen && <div className="layers-pop">
      <h4>地图图层<button className="icon-btn" onClick={() => setLayersOpen(false)} aria-label="关闭"><X size={14} /></button></h4>
      {layerOrder.map((key) => <label className="layer-toggle" key={key}>
        <span>{mapLayerLabels[key]}</span>
        <input type="checkbox" checked={layers[key]} onChange={() => toggleLayer(key)} />
        <i />
      </label>)}
    </div>}

    {selectedPoint && <PointCard pilots={pilots} source={trafficSource} onFrameRoute={() => mapRef.current?.framePilotRoute()} />}
    {selectedAirport && <AirportDock tab={dockTab} onTabChange={setDockTab} onClose={() => setSelectedAirport(null)} onLocate={(latitude, longitude) => mapRef.current?.flyToAirport(latitude, longitude, 9.6)}
      onGround={(latitude, longitude) => {
        if (!layers.ground) toggleLayer("ground");
        mapRef.current?.flyToAirport(latitude, longitude, 14.2);
      }} />}
    <ProcedureOverlay />

    <div className="map-status">
      <span><i />{isTauri() ? "导航数据库已连接" : "浏览器预览"}</span>
      <span>{pilots.length} 架在线航班</span>
      <span>{onlineTraffic.isFetching ? "同步中…" : onlineTraffic.data?.source === "vatsim" ? "VATSIM 已同步" : "XFS 已同步"}</span>
      <span className="grow" />
      <span>© OpenStreetMap contributors</span>
    </div>
  </div>;
}

export default MapPage;

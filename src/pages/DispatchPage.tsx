import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle, ArrowRight, BookOpenCheck, ChevronRight, CircleDot, FileDown, Fuel, Gauge,
  Pencil, Plane, Plus, Radio, Route as RouteIcon, Ruler, Timer, Weight,
} from "lucide-react";
import { MapCanvas, type MapCanvasHandle } from "../map/MapCanvas";
import { ProfileChart } from "../components/dispatch/ProfileChart";
import { useAppStore } from "../stores/app-store";
import { loadAdHpAirports } from "../lib/airport-data";
import { airports as fallbackAirports } from "../lib/data";
import { getCurrentAiracCycle } from "../lib/tauri";
import { AIRCRAFT, buildCandidateRoutes, computePerformance, formatDuration, formatWeight, haversineNm, parseCruiseAltitude, pathLengthNm, type CandidateRoute } from "../lib/route-calc";
import { loadRouteTerrain } from "../lib/terrain";
import { getRouteCycles, getRouteNetwork, parseRoute, queryRoute } from "../lib/xfly";
import { getNaipRoutePoints, getNaipStatus, importSimBriefFlight, searchFlightRoutes, type NaipStatus } from "../lib/tauri";
import type { FlightRoutePoint } from "../types";

type Step = 1 | 2 | 3;

/** 航路来源：官方班机航路 / SimBrief / XFS 查询 / 手工输入。 */
type RouteSource = "caac" | "simbrief" | "xfs" | "manual";

/** 候选航路在通用结构上补几个来源字段。 */
type RouteOption = CandidateRoute & {
  source: RouteSource;
  /** 班机航路：拼进航路串的航段数。 */
  legs?: number;
  /** 班机航路：CSV 里的中文描述，供对照。 */
  note?: string;
};

const SOURCES: Array<{ value: RouteSource; label: string; hint: string }> = [
  { value: "caac", label: "班机航路", hint: "本地 FLIGHT_AIRLINE.csv 里 CAAC 批准的官方航路；航点取自 FLIGHT_AIRLINE_POINT.csv 航段表，坐标查本地导航库，不经 XFS" },
  { value: "simbrief", label: "SimBrief", hint: "按用户名取 SimBrief 最近一份计划的航路与航点" },
  { value: "xfs", label: "XFS 查询", hint: "按 AIRAC 周期向 XFlySim 航路库查询建议航路" },
  { value: "manual", label: "手工输入", hint: "自己写航路串，提交后反向解析成航点" },
];

const SOURCE_LABELS: Record<RouteSource, string> = {
  caac: "班机航路",
  simbrief: "SimBrief",
  xfs: "XFS 查询",
  manual: "手工输入",
};

/** 第二步的说明文字：一眼看清这批候选是怎么来的。 */
const SOURCE_NOTES: Record<RouteSource, string> = {
  caac: "候选来自本地 FLIGHT_AIRLINE.csv（CAAC 批准、按起降场分组）。航点直接解析 FLIGHT_AIRLINE_POINT.csv 航段表，坐标查本地导航库与 AD_HP 机场库，不经 XFS。",
  simbrief: "候选来自 SimBrief 最近一份计划，航点直接取自该计划。",
  xfs: "候选来自 XFlySim 航路库（按起降机场与 AIRAC 周期检索）。",
  manual: "候选来自你输入的航路串，坐标由服务端反向解析。",
};

const steps: Array<{ value: Step; label: string }> = [
  { value: 1, label: "条件" },
  { value: 2, label: "航路" },
  { value: 3, label: "计算" },
];

export function DispatchPage() {
  const navigate = useNavigate();
  const theme = useAppStore((state) => state.theme);
  const mapRef = useRef<MapCanvasHandle>(null);

  const [step, setStep] = useState<Step>(1);
  const [dep, setDep] = useState("ZBAA");
  const [arr, setArr] = useState("ZSAM");
  const [altn, setAltn] = useState("");
  const [aircraftType, setAircraftType] = useState("A320");
  const [cruise, setCruise] = useState("FL331");
  const [pax, setPax] = useState(144);
  const [candidates, setCandidates] = useState<RouteOption[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [editing, setEditing] = useState<string | null>(null);
  const [loadingRoutes, setLoadingRoutes] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [routeError, setRouteError] = useState("");
  const [source, setSource] = useState<RouteSource>("caac");
  const [simbriefUser, setSimbriefUser] = useState("");
  const [manualRoute, setManualRoute] = useState("");
  /** 正在把某条候选的航路串解析成航点。 */
  const [resolving, setResolving] = useState<string | null>(null);
  /** XFS 周期航路网络的加载状态（GET /api/efb/routes/{cycle}）。 */
  const [networkNote, setNetworkNote] = useState("");

  const naip = useQuery<NaipStatus>({ queryKey: ["naip-status"], queryFn: getNaipStatus, staleTime: 60_000, retry: 0 });

  const catalog = useQuery({ queryKey: ["ad-hp-airports"], queryFn: loadAdHpAirports, staleTime: Infinity });
  const airports = catalog.data ?? fallbackAirports;
  const depAirport = airports.find((item) => item.icao === dep);
  const arrAirport = airports.find((item) => item.icao === arr);
  const altnAirport = airports.find((item) => item.icao === altn);

  const airac = useQuery({ queryKey: ["airac-cycle"], queryFn: getCurrentAiracCycle, staleTime: 60 * 60_000, retry: 0 });
  // 航路周期以线上接口为准，取不到时回落到本地导航库的周期号。
  const cycles = useQuery({ queryKey: ["route-cycles"], queryFn: getRouteCycles, staleTime: 6 * 60 * 60_000, retry: 0 });
  const cycle = cycles.data?.[0] ?? airac.data?.cycleId ?? "";

  const aircraft = AIRCRAFT.find((item) => item.type === aircraftType) ?? AIRCRAFT[0];
  const selected = candidates.find((item) => item.id === selectedId) ?? candidates[0];
  const cruiseAltFt = parseCruiseAltitude(cruise);
  const alternateNm = altnAirport && arrAirport ? Math.round(haversineNm(arrAirport, altnAirport)) : 0;
  // 浏览器预览没有跑道库，用 AUTO 占位，避免显示虚构跑道号。
  const depRunway = depAirport?.runways?.[0] ?? "";
  const arrRunway = arrAirport?.runways?.[0] ?? "";

  const performance = useMemo(() => selected
    ? computePerformance({ distanceNm: selected.distanceNm, aircraft, cruiseAltFt, pax, alternateNm })
    : null, [selected, aircraft, cruiseAltFt, pax, alternateNm]);

  const terrain = useQuery({
    queryKey: ["route-terrain", selected?.id, selected?.points.length],
    queryFn: () => loadRouteTerrain(selected!.points, 64),
    enabled: step === 3 && Boolean(selected),
    staleTime: 30 * 60_000,
    retry: 0,
  });

  useEffect(() => {
    if (!mapReady) return;
    // 班机航路的候选一开始没有航点，等解析完（length 变化）再按航路框选一次。
    if (selected && selected.points.length >= 2) { mapRef.current?.fitBounds(selected.points, 90); return; }
    if (depAirport && arrAirport) mapRef.current?.fitBounds([depAirport, arrAirport], 110);
  }, [mapReady, step, selected?.id, selected?.points.length, depAirport?.icao, arrAirport?.icao]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 把航路串交给服务端反向解析成航点；顺带带回服务端的提示。 */
  const resolvePoints = async (routeText: string) => {
    const parsed = await parseRoute(routeText, cycle || undefined);
    const points: FlightRoutePoint[] = parsed.waypoints
      .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lon))
      .map((point) => ({ ident: point.name, name: point.name, latitude: point.lat, longitude: point.lon }));
    return { points, warnings: parsed.warnings ?? [] };
  };

  /** 起降场两点直线：解析彻底失败时的兜底，至少让地图有个方向。 */
  const straightLine = (): FlightRoutePoint[] => {
    if (!depAirport || !arrAirport) return [];
    return [
      { ident: depAirport.icao, name: depAirport.name, latitude: depAirport.latitude, longitude: depAirport.longitude },
      { ident: arrAirport.icao, name: arrAirport.name, latitude: arrAirport.latitude, longitude: arrAirport.longitude },
    ];
  };

  /** 班机航路的候选只有航路串，选中时才去解析坐标（避免一次发几十个请求）。 */
  const ensurePoints = async (option: RouteOption) => {
    if (option.points.length >= 2 || resolving) return;
    setResolving(option.id);
    try {
      let points: FlightRoutePoint[] = [];
      let note = "";
      if (option.source === "caac") {
        // 班机航路：航点直接取 FLIGHT_AIRLINE_POINT.csv 的航段端点，坐标查本地导航库，不经 XFS。
        const result = await getNaipRoutePoints(option.id);
        points = result.points;
        if (result.missing.length) {
          const preview = result.missing.slice(0, 5).join("、");
          note = `${result.missing.length}/${result.total} 个航路点在导航库里没有坐标（${preview}${result.missing.length > 5 ? "…" : ""}），已跳过`;
        } else if (result.note) {
          note = result.note;
        }
      } else {
        const { points: parsed, warnings } = await resolvePoints(option.routeText);
        points = parsed;
        note = warnings[0] ?? "";
      }
      if (points.length < 2) throw new Error("航路点序列里凑不齐两个有坐标的点");
      setCandidates((list) => list.map((item) => item.id === option.id
        ? { ...item, points, distanceNm: item.distanceNm || pathLengthNm(points) }
        : item));
      // 换一条候选时把上一条的告警清掉，别让旧提示挂在新航路上。
      setRouteError(note);
    } catch (error) {
      const fallback = straightLine();
      setCandidates((list) => list.map((item) => item.id === option.id
        ? { ...item, points: fallback, distanceNm: item.distanceNm || pathLengthNm(fallback) }
        : item));
      setRouteError(`航路点解析失败：${(error as Error).message || "接口不可用"}，地图先按起降场直线显示`);
    } finally {
      setResolving(null);
    }
  };

  /** ① 官方班机航路：按起降场从本地 FLIGHT_AIRLINE.csv 里筛。 */
  const generateCaac = async () => {
    if (!depAirport || !arrAirport) return;
    const rows = await searchFlightRoutes(depAirport.icao, arrAirport.icao);
    if (rows.length === 0) {
      setRouteError(naip.data?.routeFile
        ? `${depAirport.icao}→${arrAirport.icao} 在 FLIGHT_AIRLINE.csv 里没有班机航路，可换 XFS 查询或手工输入。`
        : "没有找到本地数据包里的 FLIGHT_AIRLINE.csv，请到设置里选择 NAIP 数据文件夹。");
      setStep(2);
      return;
    }
    const list: RouteOption[] = rows.map((row) => ({
      id: row.id,
      name: row.name,
      routeText: row.route,
      points: [],
      distanceNm: row.distanceNm ?? 0,
      legs: row.legs,
      note: row.description,
      source: "caac",
    }));
    setCandidates(list);
    setSelectedId(list[0].id);
    setStep(2);
    void ensurePoints(list[0]);
  };

  /** ② SimBrief：直接复用计划里的航点，没有航点再去解析航路串。 */
  const generateSimbrief = async () => {
    const username = simbriefUser.trim();
    if (!username) throw new Error("请先填写 SimBrief 用户名");
    const flight = await importSimBriefFlight(username);
    let points = (flight.routePoints ?? []).filter(
      (point) => Number.isFinite(point.latitude) && Number.isFinite(point.longitude),
    );
    if (points.length < 2 && flight.route) points = (await resolvePoints(flight.route)).points;
    if (points.length < 2) throw new Error("SimBrief 计划里没有可用航点");
    if (flight.departure) setDep(flight.departure);
    if (flight.arrival) setArr(flight.arrival);
    const option: RouteOption = {
      id: `simbrief-${flight.callsign || username}`,
      name: `SimBrief · ${flight.callsign || username}`,
      routeText: flight.route ?? "",
      points,
      distanceNm: pathLengthNm(points),
      source: "simbrief",
    };
    setCandidates([option]);
    setSelectedId(option.id);
    setStep(2);
  };

  /** ③ XFS 航路查询：周期航路网络先预热（不阻塞），再按起降场查建议航路。 */
  const generateXfs = async () => {
    if (!depAirport || !arrAirport) return;
    if (cycle) {
      void getRouteNetwork(cycle)
        .then((airways) => setNetworkNote(`AIRAC ${cycle} 航路网络已加载 ${airways.length} 条航路`))
        .catch(() => setNetworkNote(`AIRAC ${cycle} 航路网络暂不可用，仅按接口查询`));
    }
    const result = await queryRoute(depAirport.icao, arrAirport.icao, cycle || undefined);
    const points: FlightRoutePoint[] = result.nodeinformation
      .filter(([, latitude, longitude]) => Number.isFinite(latitude) && Number.isFinite(longitude))
      .map(([ident, latitude, longitude]) => ({ ident, name: ident, latitude, longitude }));
    if (points.length < 2) throw new Error("接口未返回可用航点");
    const option: RouteOption = {
      id: `xfly-${depAirport.icao}-${arrAirport.icao}`,
      name: `建议航路 · AIRAC ${result.data_version}`,
      routeText: result.route,
      points,
      distanceNm: result.distanceNm || pathLengthNm(points),
      source: "xfs",
    };
    setCandidates([option]);
    setSelectedId(option.id);
    setStep(2);
  };

  /** ④ 手工输入：只做反向解析，失败就是失败，不拿直线糊弄。 */
  const generateManual = async () => {
    const text = manualRoute.trim().toUpperCase();
    if (!text) throw new Error("请先输入航路串");
    const { points, warnings } = await resolvePoints(text);
    if (points.length < 2) throw new Error("航路串里没有可解析的航点");
    const option: RouteOption = {
      id: "manual",
      name: "手工航路",
      routeText: text,
      points,
      distanceNm: pathLengthNm(points),
      source: "manual",
    };
    setCandidates([option]);
    setSelectedId(option.id);
    setRouteError(warnings[0] ?? "");
    setStep(2);
  };

  const generate = async () => {
    if (!depAirport || !arrAirport) return;
    setLoadingRoutes(true);
    setRouteError("");
    setCandidates([]);
    try {
      if (source === "caac") await generateCaac();
      else if (source === "simbrief") await generateSimbrief();
      else if (source === "xfs") await generateXfs();
      else await generateManual();
    } catch (error) {
      setRouteError((error as Error).message || "生成失败");
      // 只有按机场查询的来源才回退本地大圆骨架；SimBrief / 手工的航路串本身有错时不该糊弄。
      if (source === "caac" || source === "xfs") {
        const routes = await buildCandidateRoutes(
          { ident: depAirport.icao, latitude: depAirport.latitude, longitude: depAirport.longitude },
          { ident: arrAirport.icao, latitude: arrAirport.latitude, longitude: arrAirport.longitude },
          `${dep}-${arr}`,
        );
        setCandidates(routes.map((item) => ({ ...item, name: `${item.name}（本地估算）`, source })));
        setSelectedId(routes[0]?.id ?? "");
        setStep(2);
      }
    } finally {
      setLoadingRoutes(false);
    }
  };

  /** 手工改过航路串后重新解析坐标与距离。 */
  const reparse = async (route: RouteOption) => {
    setEditing(null);
    const text = route.routeText.trim().toUpperCase();
    if (!text) return;
    try {
      const { points, warnings } = await resolvePoints(text);
      if (points.length < 2) throw new Error("航路串里没有可解析的航点");
      setCandidates((list) => list.map((item) => item.id === route.id
        ? { ...item, points, distanceNm: pathLengthNm(points) }
        : item));
      setRouteError(warnings[0] ?? "");
    } catch (error) {
      setRouteError((error as Error).message || "航路解析失败");
    }
  };

  const waypointMarks = useMemo(() => {
    if (!selected) return [];
    const total = selected.distanceNm;
    const marks: Array<{ ident: string; distanceNm: number }> = [];
    let cumulative = 0;
    selected.points.forEach((point, index) => {
      if (index > 0) cumulative += haversineNm(selected.points[index - 1], point);
      if (index === 0 || index === selected.points.length - 1 || index % Math.max(1, Math.round(selected.points.length / 4)) === 0) {
        marks.push({ ident: point.ident, distanceNm: (cumulative / pathLengthNm(selected.points)) * total });
      }
    });
    return marks;
  }, [selected]);

  const terrainMax = Math.max(0, ...(terrain.data ?? []).map((sample) => sample.elevationFt ?? 0));

  return <div className="page dp-page">
    <aside className="page-panel wide">
      <div className="panel-head"><span className="side-mark" /><h2>航路规划</h2><button className="icon-btn" onClick={() => setStep(1)} aria-label="新建"><Plus size={15} /></button></div>
      <div className="dp-steps">
        {steps.map((item, index) => <div key={item.value} style={{ display: "contents" }}>
          <button className={`dp-step ${step === item.value ? "active" : step > item.value ? "done" : ""}`} onClick={() => setStep(item.value)}>
            <i>{step > item.value ? "✓" : item.value}</i>{item.label}
          </button>
          {index < steps.length - 1 && <ChevronRight size={12} className="dp-step-sep" />}
        </div>)}
      </div>
      <div className="panel-body">
        <p className="dp-note">系统提供建议。航路和手动输入始终由你确认后才进入最终计算。</p>

        {step === 1 && <>
          <div className="dp-deparr">
            <label className="field"><span>起飞机场</span><input value={dep} maxLength={4} onChange={(event) => setDep(event.target.value.toUpperCase())} /></label>
            <label className="field"><span>到达机场</span><input value={arr} maxLength={4} onChange={(event) => setArr(event.target.value.toUpperCase())} /></label>
          </div>
          <div className="dp-deparr">
            <label className="field"><span>备降机场</span><input value={altn} maxLength={4} placeholder="可选" onChange={(event) => setAltn(event.target.value.toUpperCase())} /></label>
            <label className="field"><span>机型</span><select value={aircraftType} onChange={(event) => setAircraftType(event.target.value)}>
              {AIRCRAFT.map((item) => <option key={item.type} value={item.type}>{item.type}</option>)}
            </select></label>
          </div>
          <div className="dp-deparr">
            <label className="field"><span>初始巡航</span><input value={cruise} onChange={(event) => setCruise(event.target.value.toUpperCase())} /></label>
            <label className="field"><span>旅客人数</span><input type="number" min={0} max={aircraft.maxPax} value={pax} onChange={(event) => setPax(Number(event.target.value))} /></label>
          </div>
          <div className="dp-source">
            <span>航路来源</span>
            <div className="seg">
              {SOURCES.map((item) => <button key={item.value} className={source === item.value ? "active" : ""} onClick={() => setSource(item.value)}>{item.label}</button>)}
            </div>
          </div>
          <p className="dp-note">{SOURCES.find((item) => item.value === source)?.hint}</p>
          {source === "simbrief" && <label className="field" style={{ margin: "0 10px 10px" }}>
            <span>SimBrief 用户名</span>
            <input value={simbriefUser} placeholder="填 SimBrief 账号名，取最近一份计划" onChange={(event) => setSimbriefUser(event.target.value.trim())} />
          </label>}
          {source === "manual" && <label className="field" style={{ margin: "0 10px 10px" }}>
            <span>航路串</span>
            <textarea value={manualRoute} placeholder="ELKUR W40 PANKI W158 VIM W127" onChange={(event) => setManualRoute(event.target.value.toUpperCase())} />
          </label>}
          {source === "caac" && (naip.data?.routeFile
            ? <p className="dp-note">{naip.data.routeCount.toLocaleString("en-US")} 条班机航路可用（{naip.data.routeFile}）</p>
            : <div className="dp-warn" style={{ margin: "0 10px 10px" }}><AlertTriangle size={13} />没找到 FLIGHT_AIRLINE.csv，先到设置里选择 NAIP 数据文件夹</div>)}
          {source === "xfs" && networkNote && <p className="dp-note">{networkNote}</p>}
          <p className="dp-note">机型性能取简化模型（爬升 22 分、下降 26 分、巡航 TAS {aircraft.cruiseTas} kt），仅供签派参考。</p>
          <button className="btn primary block" onClick={() => void generate()} disabled={loadingRoutes || !depAirport || !arrAirport}>
            <RouteIcon size={14} />{loadingRoutes ? "正在获取航路…" : "生成候选航路"}
          </button>
        </>}

        {step === 2 && <>
          <div className="dp-section-head" style={{ margin: "0 2px 8px" }}><h3>AIRAC {cycle || "—"} · 选择航路</h3></div>
          <div className="dp-deparr">
            <div className="dp-runway-card"><span>DEP</span><strong>{depRunway ? `RWY ${depRunway}` : "AUTO"}</strong><small>{depAirport?.name ?? dep}</small></div>
            <div className="dp-runway-card"><span>ARR</span><strong>{arrRunway ? `RWY ${arrRunway}` : "AUTO"}</strong><small>{arrAirport?.name ?? arr}</small></div>
          </div>
          <p className="dp-note">{SOURCE_NOTES[source]}可点「编辑」改成自己的走法，失焦后会自动重新解析航点。</p>
          {routeError && <div className="dp-warn" style={{ marginBottom: 8 }}><AlertTriangle size={13} />{routeError}</div>}
          {candidates.length === 0 && <button className="btn primary block" onClick={() => void generate()} disabled={loadingRoutes}>
            <RouteIcon size={14} />{loadingRoutes ? "正在获取…" : "生成候选航路"}
          </button>}
          {candidates.map((route, index) => <div key={route.id} className={`dp-route ${route.id === selected?.id ? "active" : ""}`} role="button" tabIndex={0} onClick={() => { setSelectedId(route.id); void ensurePoints(route); }} onKeyDown={(event) => { if (event.key === "Enter") { setSelectedId(route.id); void ensurePoints(route); } }}>
            <span className="radio"><CircleDot size={9} /></span>
            <div className="rmain">
              <strong>{index + 1} · {route.name}</strong>
              {editing === route.id
                ? <textarea className="field" style={{ width: "100%", minHeight: 58, margin: "4px 0 6px" }} value={route.routeText} onChange={(event) => setCandidates((list) => list.map((item) => item.id === route.id ? { ...item, routeText: event.target.value } : item))} onBlur={() => void reparse(route)} autoFocus />
                : <code title={route.note || undefined}>{route.routeText}</code>}
              <div className="rfoot">
                <span>{SOURCE_LABELS[route.source]} · {resolving === route.id ? "正在解析航点…" : route.distanceNm ? `${route.distanceNm.toFixed(1)} NM` : "距离待解析"}{route.legs ? ` · ${route.legs} 段` : ""}</span>
                <button className="redit" onClick={(event) => { event.stopPropagation(); setEditing(route.id); }}><Pencil size={10} />编辑</button>
              </div>
            </div>
          </div>)}
          {candidates.length > 0 && <button className="btn primary block" style={{ marginTop: 10 }} onClick={() => setStep(3)}>
            <Gauge size={14} />计算结果
          </button>}
        </>}

        {step === 3 && performance && selected && <>
          <div className="dp-section-head" style={{ margin: "0 2px 8px" }}><h3>计算完成</h3></div>
          <div className="dp-summary">
            <div className="dp-summary-row"><span>航班</span><strong>{dep} → {arr}</strong></div>
            <div className="dp-summary-row"><span>机型</span><strong>{aircraft.type}</strong></div>
            <div className="dp-summary-row"><span>航路</span><strong>{selected.name}</strong></div>
            <div className="dp-summary-row"><span>轮挡燃油</span><strong>{formatWeight(performance.blockFuel)} kg</strong></div>
          </div>
          <div className="dp-warn"><AlertTriangle size={13} />另有 1 项需要复核（地形与备降油量）</div>
          <div className="dp-actions">
            <button className="btn primary block" onClick={() => navigate(`/charts?icao=${dep}`)}><FileDown size={14} />导入矢量航图</button>
            <button className="dp-link" onClick={() => setStep(2)}><Pencil size={13} />修改并重新计算</button>
            <button className="dp-link" onClick={() => { setStep(1); setCandidates([]); setSelectedId(""); setRouteError(""); setNetworkNote(""); }}><Plus size={13} />新建飞行计划</button>
          </div>
        </>}
      </div>
    </aside>

    <div className="dp-main">
      {step < 3 ? <>
        <div className="dp-map-head">
          <div>
            <h2>{dep} <ArrowRight size={18} />{arr}</h2>
            <p>{selected ? `已选择 · ${selected.name}` : "尚未选择航路"}</p>
          </div>
          <span className="chip active"><Radio size={11} />AIRAC {cycle || "—"}</span>
        </div>
        <div className="dp-map">
          <MapCanvas ref={mapRef} variant="route" routePoints={selected?.points ?? []} onReady={() => setMapReady(true)} />
        </div>
      </> : <div className="dp-main-body">
        <header className="dp-main-head">
          <div className="grow">
            <h1>{dep}<ArrowRight size={22} />{arr}</h1>
            <p>{selected?.name} · {aircraft.type}</p>
          </div>
          <button className="btn primary" onClick={() => navigate(`/charts?icao=${dep}`)}><FileDown size={15} />导入矢量航图</button>
        </header>

        {performance && <>
          <div className="stat-grid">
            <div className="stat"><span>航路距离</span><strong>{performance.distanceNm.toFixed(1)}<em>NM</em></strong></div>
            <div className="stat"><span>空中时间</span><strong>{formatDuration(performance.airMinutes)}</strong></div>
            <div className="stat"><span>初始巡航</span><strong>{performance.cruiseAltMeters.toLocaleString("en-US")} m<em>/ FL{Math.round(performance.cruiseAltFt / 100)}</em></strong></div>
            <div className="stat"><span>航程燃油</span><strong>{formatWeight(performance.tripFuel)}<em>kg</em></strong></div>
            <div className="stat"><span>轮挡燃油</span><strong>{formatWeight(performance.blockFuel)}<em>kg</em></strong></div>
            <div className="stat"><span>预计起飞重量</span><strong>{formatWeight(performance.tow)}<em>kg</em></strong></div>
          </div>

          <section className="dp-section">
            <div className="dp-section-head"><h3>Altitude &amp; Terrain</h3><span>高度与地形</span></div>
            <div className="dp-card">
              <div className="dp-cols" style={{ gridTemplateColumns: "repeat(4, 1fr)", marginBottom: 6 }}>
                <div><span>走廊最高地形</span><strong>{terrainMax ? `${formatWeight(terrainMax)} ft` : "—"}</strong></div>
                <div><span>最小计划余度</span><strong>{terrainMax ? `+${formatWeight(performance.cruiseAltFt - terrainMax)} ft` : "—"}</strong></div>
                <div><span>地形覆盖</span><strong>{terrain.data?.length ? `${((terrain.data.filter((sample) => sample.elevationFt != null).length / terrain.data.length) * 100).toFixed(1)}%` : "—"}</strong></div>
                <div><span>采样点</span><strong>{terrain.data?.length ?? 0} 个</strong></div>
              </div>
              {terrain.isFetching
                ? <div className="profile-empty">正在获取地形剖面…</div>
                : <ProfileChart samples={terrain.data ?? []} cruiseAltFt={performance.cruiseAltFt} distanceNm={performance.distanceNm} waypoints={waypointMarks} theme={theme} />}
            </div>
          </section>

          <section className="dp-section">
            <div className="dp-section-head"><h3>Flight Info</h3><span>航班信息</span></div>
            <div className="dp-card dp-cols">
              <div><span>起飞</span><strong>{dep}</strong></div>
              <div><span>到达</span><strong>{arr}</strong></div>
              <div><span>备降</span><strong>{altn || "AUTO"}</strong></div>
              <div><span>出发跑道</span><strong>{depRunway || "AUTO"}</strong></div>
              <div><span>到达跑道</span><strong>{arrRunway || "AUTO"}</strong></div>
              <div><span>机型 / 发动机</span><strong>{aircraft.type} · {aircraft.engine}</strong></div>
            </div>
          </section>

          <section className="dp-section">
            <div className="dp-section-head"><h3>Load Sheet</h3><span>载重摘要</span></div>
            <div className="dp-card dp-cols">
              <div><span><Weight size={11} /> 旅客</span><strong>{performance.pax}</strong></div>
              <div><span>运行空重 OEW</span><strong>{formatWeight(performance.oew)} kg</strong></div>
              <div><span>计划业载</span><strong>{formatWeight(performance.payload)} kg</strong></div>
              <div><span>零燃油重量 ZFW</span><strong>{formatWeight(performance.zfw)} kg</strong></div>
              <div><span>起飞重量 TOW</span><strong>{formatWeight(performance.tow)} kg</strong></div>
              <div><span>着陆重量 LW</span><strong>{formatWeight(performance.lw)} kg</strong></div>
            </div>
          </section>

          <section className="dp-section">
            <div className="dp-section-head"><h3>Fuel</h3><span>燃油计划</span></div>
            <div className="dp-card dp-cols">
              <div><span><Fuel size={11} /> 滑行</span><strong>{formatWeight(performance.taxiFuel)} kg</strong></div>
              <div><span>航程</span><strong>{formatWeight(performance.tripFuel)} kg</strong></div>
              <div><span>应急</span><strong>{formatWeight(performance.contingencyFuel)} kg</strong></div>
              <div><span>备降</span><strong>{formatWeight(performance.alternateFuel)} kg</strong></div>
              <div><span>最后储备</span><strong>{formatWeight(performance.reserveFuel)} kg</strong></div>
              <div><span><Timer size={11} /> 轮挡燃油</span><strong>{formatWeight(performance.blockFuel)} kg</strong></div>
            </div>
            <p className="dp-note" style={{ margin: "10px 0 0" }}>数值由本地估算模型计算（距离按航路点大圆累加，油耗按机型小时耗油与爬降固定段），非官方 OFP。</p>
          </section>
        </>}
        {!performance && <div className="dispatch-empty">
          <span className="ico"><Ruler size={22} /></span>
          <h3>还没有可计算的航路</h3>
          <p>先回到「条件」填写机场与机型，生成候选航路后确认一条，再进入计算。</p>
          <button className="btn primary" onClick={() => setStep(1)}><BookOpenCheck size={14} />返回条件</button>
        </div>}
      </div>}
    </div>
  </div>;
}

export default DispatchPage;

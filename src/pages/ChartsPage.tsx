import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/TextLayer.css";
import "react-pdf/dist/Page/AnnotationLayer.css";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  BookOpen, ChevronLeft, ChevronRight, Compass, FileText, Grid2x2, Layers, Minus, Pin, Plus, RotateCcw,
  Search, Settings2, X,
} from "lucide-react";
import { getLocalChartLibraryStatus, isTauri, listLocalCharts, openLocalChart, type LocalChart } from "../lib/tauri";
import { loadAdHpAirports } from "../lib/airport-data";
import { airports as fallbackAirports } from "../lib/data";
import { chartRunways, groupComms, jeppAirportOverview, jeppChartFile, jeppCharts, jeppSidStar, prefetchChartFile, releaseChartFile, type JeppChart } from "../lib/jepp";
import { getAirport, getFrequencies, getRunways, surfaceLabel } from "../lib/xfly";
import { useAppStore } from "../stores/app-store";

pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();

const PAGE_SIZE = 40;

type ChartKind = "机场" | "离场" | "进场" | "进近";

/** 图种筛选的顺序；本地数据把进近并入进场，所以少一档。 */
const KIND_CHIPS: Record<"jepp" | "local", ReadonlyArray<ChartKind | "全部">> = {
  jepp: ["全部", "机场", "离场", "进场", "进近"],
  local: ["全部", "机场", "离场", "进场"],
};

function chartKind(category: string): ChartKind {
  const value = category.trim().toUpperCase();
  if (value === "DEPARTURE") return "离场";
  if (value === "ARRIVAL") return "进场";
  if (value === "APPROACH") return "进近";
  return "机场";
}

function dateLabel(value: string) {
  if (!value) return "—";
  return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : value;
}

/** J3N 周期是 YYYYMMDD，拼成 AIRAC 编号（2026 + 10 → 2610）。 */
function cycleLabel(cycle: { datacycle: string; datacycleyear?: string } | null | undefined) {
  if (!cycle?.datacycle) return "—";
  return `${cycle.datacycleyear ? cycle.datacycleyear.slice(-2) : ""}${cycle.datacycle}`;
}

function compactDate(value?: string) {
  if (!value) return "—";
  return /^\d{8}$/.test(value) ? `${value.slice(4, 6)}-${value.slice(6, 8)}` : value;
}

function formatMhz(value: number) {
  return Number(value).toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

/** J3N 通讯类型码的中文 / 缩写对照。 */
const commLabels: Record<string, string> = {
  ATIS: "ATIS 通播",
  放行: "放行 CLD",
  地面: "地面 GND",
  塔台: "塔台 TWR",
  "进近/离场": "进近 / 离场 APP",
  机坪: "机坪 APR",
  UNICOM: "UNICOM",
};

export function ChartsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialIcao = (searchParams.get("icao") ?? "ZBAA").toUpperCase();
  const [icao, setIcao] = useState(initialIcao);
  const [airportPicker, setAirportPicker] = useState(false);
  const [airportQuery, setAirportQuery] = useState("");
  const [tab, setTab] = useState<"charts" | "info" | "procedures">("charts");
  const [procKind, setProcKind] = useState<"sid" | "star">("sid");
  const [procName, setProcName] = useState<string | null>(null);
  const [kind, setKind] = useState<ChartKind | "全部">("全部");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<JeppChart | null>(null);
  const [localSelected, setLocalSelected] = useState<LocalChart | null>(null);
  const source = useAppStore((state) => state.chartSource);
  const setSource = useAppStore((state) => state.setChartSource);
  const [pdfUrl, setPdfUrl] = useState("");
  const [pdfLoading, setPdfLoading] = useState(false);
  const [pdfError, setPdfError] = useState("");
  const [pageCount, setPageCount] = useState(1);
  const [pageNumber, setPageNumber] = useState(1);
  const [zoom, setZoom] = useState(1.1);
  const [pinned, setPinned] = useState(false);

  const catalog = useQuery({ queryKey: ["ad-hp-airports"], queryFn: loadAdHpAirports, staleTime: Infinity });
  const airports = catalog.data ?? fallbackAirports;
  const airport = airports.find((item) => item.icao === icao);

  const jepp = useQuery({
    queryKey: ["jepp-charts", icao],
    // geo=1 只回已缓存的地理范围，不会触发引擎探测；拿到就能标注「可定位」。
    queryFn: () => jeppCharts(icao, true),
    enabled: icao.length === 4,
    staleTime: 30 * 60_000,
    retry: 0,
  });

  // 机场总览一次给全跑道 / 频率 / ILS / 周期，比分别打三个端点更省也更一致。
  const overview = useQuery({
    queryKey: ["jepp-overview", icao],
    queryFn: () => jeppAirportOverview(icao),
    enabled: icao.length === 4 && tab === "info",
    staleTime: 60 * 60_000,
    retry: 0,
  });
  const procedures = useQuery({
    queryKey: ["jepp-sidstar", icao],
    queryFn: () => jeppSidStar(icao),
    enabled: icao.length === 4 && tab === "procedures",
    staleTime: 60 * 60_000,
    retry: 0,
  });

  const xflyRunways = useQuery({
    queryKey: ["xfly-runways", icao],
    queryFn: () => getRunways(icao),
    enabled: icao.length === 4 && tab === "info",
    staleTime: 60 * 60_000,
    retry: 0,
  });
  // JeppQuery 没有该机场时，信息页整体回落到 XFS：机场名 / 标高、跑道、频率。
  const xflyInfo = useQuery({
    queryKey: ["xfly-airport-info", icao],
    queryFn: () => getAirport(icao),
    enabled: icao.length === 4,
    staleTime: 30 * 60_000,
    retry: 0,
  });
  const xflyFreqs = useQuery({
    queryKey: ["xfly-frequencies", icao],
    queryFn: () => getFrequencies(icao),
    enabled: icao.length === 4 && tab === "info",
    staleTime: 60 * 60_000,
    retry: 0,
  });

  // 标题里的机场名：AD_HP（国内）没有时退 XFS 的中文名 / 英文名。
  const headerName = airport?.name ?? xflyInfo.data?.cnName ?? xflyInfo.data?.enName ?? "";

  const library = useQuery({ queryKey: ["local-chart-library"], queryFn: getLocalChartLibraryStatus, enabled: isTauri(), retry: 0 });
  const local = useQuery({ queryKey: ["local-charts"], queryFn: listLocalCharts, enabled: isTauri() && Boolean(library.data?.ready), retry: 0 });
  const localForAirport = useMemo(() => (local.data ?? []).filter((chart) => chart.airport === icao), [local.data, icao]);

  const charts = jepp.data?.charts ?? [];
  const procedureList = procedures.data?.[procKind] ?? [];
  const currentProc = procedureList.find((proc) => `${proc.name}-${proc.runway}` === procName) ?? null;

  const filtered = useMemo(() => {
    const keyword = query.trim().toUpperCase();
    return charts.filter((chart) => {
      if (kind !== "全部" && chartKind(chart.category) !== kind) return false;
      if (!keyword) return true;
      return `${chart.index_no}${chart.proc_id}${chart.type_name}${chart.category}`.toUpperCase().includes(keyword);
    });
  }, [charts, kind, query]);

  // 本地航图的图种来自 Charts.csv 的分类（机场 / 离场 / 进场 / 航路），
  // 「进近」在本地数据里并入「进场」，筛选时按同一档处理。
  const localFiltered = useMemo(() => {
    const keyword = query.trim().toUpperCase();
    return localForAirport.filter((chart) => {
      if (kind !== "全部") {
        const category = chart.category;
        const matched = category === kind || (kind === "进近" && category === "进场");
        if (!matched) return false;
      }
      if (!keyword) return true;
      return `${chart.revision}${chart.category}${chart.name ?? ""}${chart.chartType ?? ""}${chart.title}`
        .toUpperCase()
        .includes(keyword);
    });
  }, [localForAirport, kind, query]);

  const listLength = source === "jepp" ? filtered.length : localFiltered.length;
  const pageCountTotal = Math.max(1, Math.ceil(listLength / PAGE_SIZE));
  useEffect(() => { setPage(0); }, [icao, kind, query, source]);
  useEffect(() => { setProcName(null); }, [icao]);
  const visible = filtered.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  const visibleLocal = localFiltered.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  useEffect(() => { setSearchParams(icao ? { icao } : {}, { replace: true }); }, [icao, setSearchParams]);

  // 航图 PDF 要先取回本地（桌面端由 Rust 缓存，浏览器端转 blob），
  // 取回期间显示加载态，切换航图时释放上一个地址。
  useEffect(() => {
    if (!selected) {
      setPdfUrl("");
      setPdfError("");
      setPdfLoading(false);
      return;
    }
    let cancelled = false;
    let created = "";
    setPdfUrl("");
    setPdfError("");
    setPdfLoading(true);
    setPageNumber(1);
    setPageCount(1);

    jeppChartFile(selected.icao || icao, selected.filename)
      .then((url) => {
        if (cancelled) {
          releaseChartFile(url);
          return;
        }
        created = url;
        setPdfUrl(url);
      })
      .catch((error: unknown) => {
        if (!cancelled) setPdfError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setPdfLoading(false);
      });

    return () => {
      cancelled = true;
      releaseChartFile(created);
    };
  }, [selected, icao]);

  const openLocal = async (chart: LocalChart) => {
    setSelected(null);
    setLocalSelected(chart);
    setPdfError("");
    setPdfUrl("");
    setPdfLoading(true);
    setPageNumber(1);
    setPageCount(1);
    try {
      const path = await openLocalChart(chart.id);
      setPdfUrl(convertFileSrc(path));
    } catch (error) {
      setPdfError(error instanceof Error ? error.message : String(error));
    } finally {
      setPdfLoading(false);
    }
  };

  const filteredAirports = airportQuery.trim()
    ? airports.filter((item) => `${item.icao}${item.iata}${item.name}${item.city}`.toUpperCase().includes(airportQuery.trim().toUpperCase())).slice(0, 40)
    : airports.slice(0, 40);

  // JeppQuery 只给道面数字代码，用 XFly 的道面字段翻译成中文。
  const surfaceByIdent = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of xflyRunways.data ?? []) {
      map.set(row.leIdent.toUpperCase(), surfaceLabel(row.surface));
      map.set(row.heIdent.toUpperCase(), surfaceLabel(row.surface));
    }
    return map;
  }, [xflyRunways.data]);

  // 图种计数跟随来源：Jepp 按分类码，本地按 Charts.csv 的分类。
  const kindCounts = useMemo(() => {
    const counts: Record<string, number> = { 全部: source === "jepp" ? charts.length : localForAirport.length };
    if (source === "jepp") {
      for (const chart of charts) {
        const label = chartKind(chart.category);
        counts[label] = (counts[label] ?? 0) + 1;
      }
    } else {
      for (const chart of localForAirport) {
        counts[chart.category] = (counts[chart.category] ?? 0) + 1;
      }
      // 本地数据把进近并入进场，这里不单列「进近」。
      counts["进近"] = 0;
    }
    return counts;
  }, [charts, source, localForAirport]);

  return <div className="chart-page">
    <aside className="chart-side">
      <div className="chart-side-head">
        <span className="side-mark" />
        <h2>航图库</h2>
        <button className="icon-btn" onClick={() => setAirportPicker((value) => !value)} aria-label="机场列表"><Grid2x2 size={15} /></button>
      </div>
      <div className="chart-ap-row">
        <button className="back-inline" onClick={() => setAirportPicker(true)}><ChevronLeft size={14} />机场列表</button>
        <h3>{icao}<span>{headerName ? ` ${headerName.replace(/国际机场|机场/g, "")}` : ""}</span></h3>
        <span className="count">{tab === "charts"
          ? `${source === "jepp" ? charts.length : localForAirport.length} 份`
          : tab === "info"
            ? `${overview.data?.runways.length ?? 0} 跑道`
            : `${(procedures.data?.[procKind] ?? []).length} 程序`}</span>
        <a className="icon-btn" href="/settings" aria-label="数据源设置"><Settings2 size={14} /></a>
      </div>

      {airportPicker && <div className="airport-pop">
        <label className="input-icon">
          <Search size={14} />
          <input autoFocus value={airportQuery} onChange={(event) => setAirportQuery(event.target.value)} placeholder="搜索 ICAO / IATA / 机场名" />
        </label>
        <div className="airport-pop-list">
          {filteredAirports.map((item) => <button key={item.icao} className={item.icao === icao ? "active" : ""} onClick={() => { setIcao(item.icao); setAirportPicker(false); setAirportQuery(""); setSelected(null); }}>
            <code>{item.icao}</code>
            <span><strong>{item.name}</strong><small>{item.city} · {item.iata}</small></span>
          </button>)}
        </div>
      </div>}

      <div className="seg block" style={{ margin: "0 10px 10px" }}>
        <button className={tab === "charts" ? "active" : ""} onClick={() => setTab("charts")}>航图</button>
        <button className={tab === "info" ? "active" : ""} onClick={() => setTab("info")}>信息</button>
        <button className={tab === "procedures" ? "active" : ""} onClick={() => setTab("procedures")}>程序</button>
      </div>

      {tab === "charts" ? <>
        <div className="chart-search">
          <Search size={14} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索图号 / 程序名，如 10-9 或 ILS" />
          {query && <button onClick={() => setQuery("")} aria-label="清除"><X size={13} /></button>}
        </div>
        <div className="chart-filter-row">
          <span className="filter-label">图种</span>
          {KIND_CHIPS[source].map((value) => <button
            key={value}
            className={`chip ${kind === value ? "active" : ""}`}
            onClick={() => setKind(value)}
          >{value}<em className="chip-count">{kindCounts[value] ?? 0}</em></button>)}
        </div>
        <div className="chart-filter-row">
          <span className="filter-label">来源</span>
          <button className={`chip ${source === "jepp" ? "active" : ""}`} onClick={() => setSource("jepp")}>
            JeppQuery<em className="chip-count">{charts.length}</em>
          </button>
          <button
            className={`chip ${source === "local" ? "active" : ""}`}
            onClick={() => setSource("local")}
            disabled={!localForAirport.length}
            title={localForAirport.length ? `${library.data?.airportCount ?? 0} 个机场 · ${library.data?.chartCount ?? 0} 份本地航图` : "先在设置里选择 NAIP 数据文件夹"}
          >本地 Terminal<em className="chip-count">{localForAirport.length}</em></button>
        </div>
        <div className="chart-side-body">
          {source === "jepp" ? <>
            {jepp.isFetching && charts.length === 0 && <p className="empty">正在获取航图目录…</p>}
            {jepp.isError && <div className="empty">
              <p>无法连接航图服务</p>
              <p className="muted" style={{ marginTop: 6 }}>{(jepp.error as Error)?.message ?? "请稍后重试，或改用本地航图库"}</p>
            </div>}
            {!jepp.isFetching && !jepp.isError && visible.length === 0 && <p className="empty">没有匹配的航图</p>}
            {visible.map((chart) => {
              const rwy = chartRunways(chart);
              return <button key={chart.filename} className={`chart-item ${selected?.filename === chart.filename ? "active" : ""}`}
                onClick={() => setSelected(chart)}
                // 悬停预热：扫过列表就开始把 PDF 拉到本地缓存，点开几乎秒出。
                onMouseEnter={() => prefetchChartFile(chart.icao || icao, chart.filename)}
                onFocus={() => prefetchChartFile(chart.icao || icao, chart.filename)}
              >
                <span className="ci-thumb"><FileText size={14} /></span>
                <span className="ci-main">
                  <strong>{chart.index_no} · {chart.proc_id || chart.type_name}</strong>
                  <small>
                    {chartKind(chart.category)} · {dateLabel(chart.date_rev)}
                    {rwy ? ` · RWY ${rwy}` : ""}
                    {chart.ilsText ? ` · ILS ${chart.ilsText}` : ""}
                    {chart.precision_approach ? " · 精密进近" : ""}
                    {chart.is_vfr ? " · VFR" : ""}
                    {chart.geo_bounds?.coverage ? " · 可定位" : ""}
                    {chart.has_tcl === false ? " · 未抽取" : ""}
                  </small>
                </span>
                <ChevronRight size={13} style={{ color: "var(--muted-2)" }} />
              </button>;
            })}
          </> : <>
            {local.isFetching && <p className="empty">正在读取本地航图索引…</p>}
            {local.isError && <p className="empty">{(local.error as Error)?.message ?? "读取本地航图库失败"}</p>}
            {!local.isFetching && !library.data?.ready && <p className="empty">还没有选择本地数据包，请到设置里选择 NAIP 数据文件夹。</p>}
            {library.data?.ready && !localForAirport.length && <p className="empty">本地航图库里没有 {icao} 的航图</p>}
            {library.data?.ready && localForAirport.length > 0 && visibleLocal.length === 0 && <p className="empty">没有匹配的航图</p>}
            {visibleLocal.map((chart) => <button
              key={chart.id}
              className={`chart-item ${localSelected?.id === chart.id ? "active" : ""}`}
              onClick={() => void openLocal(chart)}
              title={chart.id}
            >
              <span className="ci-thumb"><BookOpen size={14} /></span>
              <span className="ci-main">
                <strong>{chart.revision ? `${chart.revision} · ` : ""}{chart.chartType || chart.title}</strong>
                <small>{[chart.name && chart.name !== chart.chartType ? chart.name : null, chart.category].filter(Boolean).join(" · ")}</small>
              </span>
              <ChevronRight size={13} style={{ color: "var(--muted-2)" }} />
            </button>)}
          </>}
        </div>
        <footer className="chart-pager">
          <button disabled={page === 0} onClick={() => setPage((value) => Math.max(0, value - 1))}><ChevronLeft size={14} />上一页</button>
          <span>{listLength === 0 ? "0" : `${page * PAGE_SIZE + 1}-${Math.min(listLength, (page + 1) * PAGE_SIZE)}`} / {listLength} · 第 {page + 1}/{pageCountTotal} 页</span>
          <button disabled={page + 1 >= pageCountTotal} onClick={() => setPage((value) => Math.min(pageCountTotal - 1, value + 1))}>下一页<ChevronRight size={14} /></button>
        </footer>
      </> : tab === "info" ? <div className="chart-side-body info-scroll">
        {overview.isFetching && !overview.data && <p className="empty">正在获取机场资料…</p>}
        {overview.isError && <p className="empty">{(overview.error as Error)?.message ?? "无法获取机场总览"}</p>}
        {!overview.data && (xflyInfo.isFetching || xflyRunways.isFetching || xflyFreqs.isFetching) &&
          !xflyInfo.data && !(xflyRunways.data ?? []).length && !(xflyFreqs.data ?? []).length &&
          <p className="empty">正在获取机场资料…</p>}
        {/* Jepp 没有该机场（404 / 超时）时整页回落到 XFS 数据。 */}
        {!overview.data && !overview.isFetching && ((xflyInfo.data && (xflyInfo.data.cnName || xflyInfo.data.enName || xflyInfo.data.elevationFt != null)) || (xflyRunways.data ?? []).length > 0 || (xflyFreqs.data ?? []).length > 0) && <>
          <p className="muted" style={{ margin: "0 0 12px", fontSize: 10.5 }}>
            航图服务上没有该机场的导航数据，以下信息来自 XFS。
          </p>
          <div className="info-cycle">
            <span>机场</span>
            <strong>{xflyInfo.data?.cnName || xflyInfo.data?.enName || icao}</strong>
            <small>{[xflyInfo.data?.municipalityCn || xflyInfo.data?.municipality, xflyInfo.data?.iataCode, xflyInfo.data?.elevationFt != null ? `标高 ${xflyInfo.data.elevationFt.toLocaleString("en-US")} ft` : ""].filter(Boolean).join(" · ")}</small>
          </div>

          <h3 className="info-title">跑道</h3>
          <table className="freq-table">
            <thead><tr><th>跑道</th><th>长度</th><th>道面</th><th>入口标高</th></tr></thead>
            <tbody>
              {(xflyRunways.data ?? []).map((row) => <tr key={`${row.leIdent}-${row.heIdent}`}>
                <td className="mono">{row.leIdent}/{row.heIdent}</td>
                <td>{Number(row.lengthFt)?.toLocaleString("en-US") ?? "—"} ft</td>
                <td>{surfaceLabel(row.surface)}</td>
                <td>{row.leElevationFt || "—"} / {row.heElevationFt || "—"} ft</td>
              </tr>)}
              {!(xflyRunways.data ?? []).length && <tr><td colSpan={4} className="muted">暂无跑道数据</td></tr>}
            </tbody>
          </table>

          <h3 className="info-title">管制单位及频率</h3>
          <table className="freq-table">
            <thead><tr><th>单位</th><th>频率（MHz）</th></tr></thead>
            <tbody>
              {(xflyFreqs.data ?? []).map((row) => <tr key={`${row.type}-${row.description}-${row.frequencyMhz}`}>
                <td>{row.description || row.type}</td>
                <td className="mono">{formatMhz(Number(row.frequencyMhz))}</td>
              </tr>)}
              {!(xflyFreqs.data ?? []).length && <tr><td colSpan={2} className="muted">暂无频率数据</td></tr>}
            </tbody>
          </table>
        </>}
        {!overview.data && !overview.isFetching && !xflyInfo.isFetching && !xflyRunways.isFetching && !xflyFreqs.isFetching &&
          !(xflyInfo.data && (xflyInfo.data.cnName || xflyInfo.data.enName)) && !(xflyRunways.data ?? []).length && !(xflyFreqs.data ?? []).length &&
          <p className="empty">航图服务与 XFS 上都没有该机场的数据</p>}

        {overview.data && <>
          <div className="info-cycle">
            <span>数据周期</span>
            <strong>AIRAC {cycleLabel(overview.data.cycle)}</strong>
            <small>{compactDate(overview.data.cycle?.effective)} → {compactDate(overview.data.cycle?.expiration)}{overview.data.cycle?.version ? ` · ${overview.data.cycle.version}` : ""}</small>
          </div>
          <p className="muted" style={{ margin: "0 0 12px", fontSize: 10.5 }}>
            标高 {overview.data.elevation_ft?.toLocaleString("en-US") ?? "—"} ft · 磁差 {overview.data.magnetic_variation || "—"} · {overview.data.utc_offset || "—"}
          </p>

          <h3 className="info-title">跑道</h3>
          <table className="freq-table">
            <thead><tr><th>跑道</th><th>长度</th><th>道面</th><th>标高</th></tr></thead>
            <tbody>
              {overview.data.runways.map((row) => <tr key={row.ident}>
                <td className="mono">{row.ident}</td>
                <td>{row.length_ft?.toLocaleString("en-US")} ft</td>
                <td>{surfaceByIdent.get(row.ident.toUpperCase()) ?? (row.surface_code != null ? `代码 ${row.surface_code}` : "—")}</td>
                <td>{row.elevation_ft} ft</td>
              </tr>)}
              {!overview.data.runways.length && <tr><td colSpan={4} className="muted">暂无跑道数据</td></tr>}
            </tbody>
          </table>

          <h3 className="info-title">管制单位及频率</h3>
          <table className="freq-table">
            <thead><tr><th>单位</th><th>频率（MHz）</th></tr></thead>
            <tbody>
              {groupComms(overview.data.comms).map((group) => <tr key={group.type}>
                <td>{commLabels[group.type] ?? group.type}</td>
                <td className="mono">{group.values.map(formatMhz).join(" · ")}</td>
              </tr>)}
              {!overview.data.comms.length && <tr><td colSpan={2} className="muted">暂无频率数据</td></tr>}
            </tbody>
          </table>

          <h3 className="info-title">ILS</h3>
          <table className="freq-table">
            <thead><tr><th>识别码</th><th>跑道</th><th>频率</th><th>下滑角</th></tr></thead>
            <tbody>
              {overview.data.ils.map((row) => <tr key={`${row.ident}-${row.runway}`}>
                <td className="mono">{row.ident}</td>
                <td className="mono">{row.runway}</td>
                <td className="mono">{row.frequency_mhz.toFixed(2)}</td>
                <td>{row.glide_slope?.toFixed(1) ?? "—"}°</td>
              </tr>)}
              {!overview.data.ils.length && <tr><td colSpan={4} className="muted">暂无 ILS 数据</td></tr>}
            </tbody>
          </table>
        </>}
      </div> : <div className="chart-side-body info-scroll">
        <div className="seg block" style={{ marginBottom: 10 }}>
          <button className={procKind === "sid" ? "active" : ""} onClick={() => { setProcKind("sid"); setProcName(null); }}>SID 离场</button>
          <button className={procKind === "star" ? "active" : ""} onClick={() => { setProcKind("star"); setProcName(null); }}>STAR 进场</button>
        </div>

        {currentProc ? <>
          <button className="back-inline" style={{ marginBottom: 8 }} onClick={() => setProcName(null)}>
            <ChevronLeft size={14} />程序列表
          </button>
          <h3 className="info-title">路径点 · {currentProc.name} <span className="muted" style={{ fontWeight: 400, fontSize: 11 }}>{currentProc.runway}</span></h3>
          <table className="freq-table">
            <thead><tr><th>#</th><th>点</th><th>类型</th><th>坐标</th></tr></thead>
            <tbody>
              {currentProc.path.map((point, index) => <tr key={`${point.ident}-${index}`}>
                <td className="muted" style={{ width: 20 }}>{index + 1}</td>
                <td className="mono">{point.ident ?? "—"}</td>
                <td>{point.kind === "ENRT" ? "航路" : point.kind === "TERM" ? "终端" : "—"}</td>
                <td className="mono" style={{ fontSize: 10 }}>
                  {point.latitude == null || point.longitude == null
                    ? "—"
                    : `${point.latitude.toFixed(3)} / ${point.longitude.toFixed(3)}`}
                </td>
              </tr>)}
            </tbody>
          </table>
        </> : <>
          {procedures.isFetching && <p className="empty">正在解析程序目录…</p>}
          {procedures.isError && <p className="empty">{(procedures.error as Error)?.message ?? "无法获取程序目录"}</p>}
          {procedureList.map((proc) => <button
            key={`${proc.name}-${proc.runway}`}
            className="chart-item"
            onClick={() => setProcName(`${proc.name}-${proc.runway}`)}
          >
            <span className="ci-thumb"><Compass size={14} /></span>
            <span className="ci-main"><strong>{proc.name}</strong><small>{proc.runway || "全部跑道"} · {proc.points} 个路径点</small></span>
            <ChevronRight size={13} style={{ color: "var(--muted-2)" }} />
          </button>)}
          {!procedures.isFetching && !procedures.isError && procedureList.length === 0 && <p className="empty">没有该类型程序</p>}
        </>}
      </div>}
    </aside>

    <section className="chart-viewer-pane">
      <div className="viewer-toolbar">
        <button onClick={() => selected && setSelected({ ...selected })} aria-label="重新加载"><RotateCcw size={14} /></button>
        <button disabled={pageNumber <= 1} onClick={() => setPageNumber((value) => Math.max(1, value - 1))} aria-label="上一页"><ChevronLeft size={15} /></button>
        <span className="zoom-val">{pageNumber} / {pageCount}</span>
        <button disabled={pageNumber >= pageCount} onClick={() => setPageNumber((value) => Math.min(pageCount, value + 1))} aria-label="下一页"><ChevronRight size={15} /></button>
        <span className="sep" />
        <button onClick={() => setZoom((value) => Math.max(0.5, Number((value - 0.15).toFixed(2))))} aria-label="缩小"><Minus size={14} /></button>
        <span className="zoom-val">{Math.round(zoom * 100)}%</span>
        <button onClick={() => setZoom((value) => Math.min(3, Number((value + 0.15).toFixed(2))))} aria-label="放大"><Plus size={14} /></button>
        <span className="sep" />
        <button aria-label="图层"><Layers size={14} /></button>
        <button className={pinned ? "active" : ""} onClick={() => setPinned((value) => !value)} aria-label="固定航图"><Pin size={14} />固定航图</button>
      </div>

      <div className="chart-viewer has-toolbar">
        {pdfLoading ? <div className="chart-placeholder">
          <FileText size={30} className="spinning" />
          <strong>正在获取航图</strong>
          <p>首次打开需要从航图服务取回 PDF，之后会命中本地缓存。</p>
        </div> : pdfError ? <div className="chart-placeholder">
          <FileText size={32} />
          <strong>航图获取失败</strong>
          <p>{pdfError}</p>
        </div> : pdfUrl ? <div className="chart-canvas">
          <Document
            file={pdfUrl}
            onLoadSuccess={({ numPages }) => { setPageCount(numPages); setPageNumber(1); }}
            onLoadError={() => setPageCount(1)}
            loading={<div className="chart-placeholder">正在渲染航图…</div>}
            error={<div className="chart-placeholder"><FileText size={32} /><strong>航图渲染失败</strong><p>请确认航图服务可访问，且字体与打印驱动已就绪。</p></div>}
          >
            <Page pageNumber={pageNumber} width={820 * zoom} renderTextLayer={false} renderAnnotationLayer={false} />
          </Document>
        </div> : <div className="chart-placeholder">
          <BookOpen size={40} />
          <strong>选择左侧航图以查看</strong>
          <p>{source === "local"
            ? "当前来源是本地 Terminal 航图库，按图号、图名或图种筛选。"
            : "航图来自 JeppQuery 服务，按图号、程序名或图种筛选。固定航图后会保留当前页面。"}</p>
        </div>}
      </div>

      <div className="viewer-pager">
        <button onClick={() => setPageNumber((value) => Math.max(1, value - 1))} disabled={pageNumber <= 1} aria-label="上一页"><ChevronLeft size={14} /></button>
        <span>{pageNumber} / {pageCount}</span>
        <button onClick={() => setPageNumber((value) => Math.min(pageCount, value + 1))} disabled={pageNumber >= pageCount} aria-label="下一页"><ChevronRight size={14} /></button>
        <span className="sep" />
        <span>{selected
          ? `${selected.icao || icao} · ${selected.index_no} · ${selected.proc_id || selected.type_name}`
          : localSelected
            ? `${localSelected.airport} · ${localSelected.revision || "—"} · ${localSelected.chartType || localSelected.title}`
            : "未选择航图"}</span>
        {selected?.geo_bounds?.coverage && <>
          <span className="sep" />
          <span className="mono">{selected.geo_bounds.coverage.lon_min.toFixed(3)}–{selected.geo_bounds.coverage.lon_max.toFixed(3)}E · {selected.geo_bounds.coverage.lat_min.toFixed(3)}–{selected.geo_bounds.coverage.lat_max.toFixed(3)}N</span>
        </>}
      </div>
    </section>
  </div>;
}

export default ChartsPage;

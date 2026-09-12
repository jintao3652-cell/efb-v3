import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/TextLayer.css";
import "react-pdf/dist/Page/AnnotationLayer.css";
import { open } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Archive, ArrowLeft, BookOpen, Building2, ChevronLeft, ChevronRight, Download, ExternalLink, FilePlus2, FileText, FolderOpen, Minus, PenLine, Plus, RefreshCw, RotateCw, Search, Trash2 } from "lucide-react";
import { cacheChartPdf, getLocalChartLibraryStatus, isTauri, listChartFoxCharts, listLocalCharts, openLocalChart, setLocalChartLibrary } from "../lib/tauri";
import type { Chart } from "../types";
import { StatusBadge } from "../components/common/StatusBadge";

pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();

type PdfSource = File | string;
type ChartSource = "local" | "chartfox";
type InkPoint = { x: number; y: number };
type InkStroke = { points: InkPoint[]; color: string; width: number };
type AirportChartGroup = { airport: string; charts: Chart[] };

function categoryForChartFox(type: string): Chart["category"] {
  if (/arrival|approach|star|iac/i.test(type)) return "进场";
  if (/departure|sid/i.test(type)) return "离场";
  if (/enroute|route/i.test(type)) return "航路";
  return "机场";
}

function airportChartSummary(chartsForAirport: Chart[]) {
  const counts = new Map<Chart["category"], number>();
  for (const chart of chartsForAirport) counts.set(chart.category, (counts.get(chart.category) ?? 0) + 1);
  return (["机场", "进场", "离场", "航路"] as const).filter((category) => counts.has(category)).map((category) => `${category} ${counts.get(category)}`).join(" · ");
}

export function ChartsPage() {
  const client = useQueryClient();
  const [searchParams] = useSearchParams();
  const requestedIcao = (searchParams.get("icao") ?? "").trim().toUpperCase();
  const appliedRequestedIcao = useRef("");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<"全部" | Chart["category"]>("全部");
  const [source, setSource] = useState<ChartSource>("local");
  const [selectedAirport, setSelectedAirport] = useState("");
  const [chartFoxIcao, setChartFoxIcao] = useState(/^[A-Z0-9]{4}$/.test(requestedIcao) ? requestedIcao : "ZBAA");
  const [selected, setSelected] = useState<Chart | null>(null);
  const [chartFoxUrl, setChartFoxUrl] = useState("");
  const [pdfSource, setPdfSource] = useState<PdfSource | null>(null);
  const [fileName, setFileName] = useState("");
  const [pageCount, setPageCount] = useState(0);
  const [pageNumber, setPageNumber] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [drawMode, setDrawMode] = useState(false);
  const [hasInk, setHasInk] = useState(false);
  const [viewerWidth, setViewerWidth] = useState(720);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const pageStageRef = useRef<HTMLDivElement>(null);
  const inkCanvasRef = useRef<HTMLCanvasElement>(null);
  const inkByPageRef = useRef(new Map<number, InkStroke[]>());
  const activeStrokeRef = useRef<InkStroke | null>(null);

  const resetPdfTools = () => {
    setPageCount(0);
    setPageNumber(1);
    setZoom(1);
    setRotation(0);
    setDrawMode(false);
    setHasInk(false);
    inkByPageRef.current.clear();
    activeStrokeRef.current = null;
    const context = inkCanvasRef.current?.getContext("2d");
    if (context && inkCanvasRef.current) context.clearRect(0, 0, inkCanvasRef.current.width, inkCanvasRef.current.height);
  };
  const resetPreview = () => {
    setPdfSource(null);
    setFileName("");
    setError("");
    resetPdfTools();
  };

  const localLibrary = useQuery({ queryKey: ["local-chart-library"], queryFn: getLocalChartLibraryStatus, retry: 0 });
  const localCharts = useQuery({ queryKey: ["local-charts"], queryFn: listLocalCharts, enabled: source === "local" && localLibrary.data?.ready, retry: 0 });
  const chartFox = useQuery({ queryKey: ["chartfox", chartFoxIcao], queryFn: () => listChartFoxCharts(chartFoxIcao), enabled: source === "chartfox" && chartFoxIcao.length === 4, retry: 1 });
  const localLibraryMutation = useMutation({
    mutationFn: setLocalChartLibrary,
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["local-chart-library"] });
      client.invalidateQueries({ queryKey: ["local-charts"] });
      setSelectedAirport("");
      setQuery("");
      setCategory("全部");
      resetPreview();
    },
  });

  const activeCharts = useMemo<Chart[]>(() => localLibrary.data?.ready ? (localCharts.data ?? []).map((chart) => ({ id: chart.id, airport: chart.airport, category: chart.category, title: chart.title, revision: chart.revision, cached: true })) : [], [localCharts.data, localLibrary.data?.ready]);
  const airportGroups = useMemo<AirportChartGroup[]>(() => {
    const groups = new Map<string, Chart[]>();
    for (const chart of activeCharts) groups.set(chart.airport, [...(groups.get(chart.airport) ?? []), chart]);
    return [...groups.entries()].map(([airport, airportCharts]) => ({ airport, charts: airportCharts })).sort((first, second) => first.airport.localeCompare(second.airport));
  }, [activeCharts]);
  const visibleAirportGroups = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return airportGroups;
    return airportGroups.filter((group) => group.airport.toLowerCase().includes(normalizedQuery) || group.charts.some((chart) => chart.title.toLowerCase().includes(normalizedQuery)));
  }, [airportGroups, query]);
  const visibleAirportCharts = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return (airportGroups.find((group) => group.airport === selectedAirport)?.charts ?? []).filter((chart) => (category === "全部" || chart.category === category) && (!normalizedQuery || chart.title.toLowerCase().includes(normalizedQuery)));
  }, [airportGroups, category, query, selectedAirport]);

  useEffect(() => {
    if (!/^[A-Z0-9]{4}$/.test(requestedIcao) || appliedRequestedIcao.current === requestedIcao) return;
    if (localLibrary.isFetching || (localLibrary.data?.ready && localCharts.isFetching)) return;
    setSelected(null);
    setChartFoxUrl("");
    setQuery("");
    setCategory("全部");
    resetPreview();
    if (localLibrary.data?.ready && airportGroups.some((group) => group.airport === requestedIcao)) {
      setSource("local");
      setSelectedAirport(requestedIcao);
    } else {
      setSource("chartfox");
      setSelectedAirport("");
      setChartFoxIcao(requestedIcao);
    }
    appliedRequestedIcao.current = requestedIcao;
  }, [airportGroups, localCharts.isFetching, localLibrary.data?.ready, localLibrary.isFetching, requestedIcao]);

  const redrawInk = useCallback(() => {
    const canvas = inkCanvasRef.current;
    const stage = pageStageRef.current;
    if (!canvas || !stage || stage.clientWidth <= 0 || stage.clientHeight <= 0) return;
    const ratio = window.devicePixelRatio || 1;
    const width = stage.clientWidth;
    const height = stage.clientHeight;
    const bitmapWidth = Math.max(1, Math.round(width * ratio));
    const bitmapHeight = Math.max(1, Math.round(height * ratio));
    if (canvas.width !== bitmapWidth || canvas.height !== bitmapHeight) {
      canvas.width = bitmapWidth;
      canvas.height = bitmapHeight;
    }
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    context.lineCap = "round";
    context.lineJoin = "round";
    for (const stroke of inkByPageRef.current.get(pageNumber) ?? []) {
      context.strokeStyle = stroke.color;
      context.fillStyle = stroke.color;
      context.lineWidth = stroke.width;
      if (stroke.points.length === 1) {
        context.beginPath();
        context.arc(stroke.points[0].x * width, stroke.points[0].y * height, stroke.width / 2, 0, Math.PI * 2);
        context.fill();
        continue;
      }
      context.beginPath();
      stroke.points.forEach((point, index) => {
        const x = point.x * width;
        const y = point.y * height;
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      });
      context.stroke();
    }
  }, [pageNumber]);

  useEffect(() => {
    if (!pdfSource || !viewerRef.current) return;
    const viewer = viewerRef.current;
    const updateWidth = () => {
      const styles = window.getComputedStyle(viewer);
      const horizontalPadding = Number.parseFloat(styles.paddingLeft) + Number.parseFloat(styles.paddingRight);
      setViewerWidth(Math.max(280, Math.floor(viewer.clientWidth - horizontalPadding)));
    };
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(viewer);
    window.addEventListener("resize", updateWidth);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateWidth);
    };
  }, [pdfSource]);

  useEffect(() => {
    const stage = pageStageRef.current;
    if (!pdfSource || !stage) return;
    const observer = new ResizeObserver(redrawInk);
    observer.observe(stage);
    const frame = window.requestAnimationFrame(redrawInk);
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, [pdfSource, pageNumber, rotation, viewerWidth, zoom, redrawInk]);

  useEffect(() => {
    setHasInk((inkByPageRef.current.get(pageNumber)?.length ?? 0) > 0);
  }, [pageNumber, pdfSource]);

  const pointForEvent = (event: ReactPointerEvent<HTMLCanvasElement>): InkPoint => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)), y: Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height)) };
  };
  const startInk = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drawMode) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const stroke: InkStroke = { points: [pointForEvent(event)], color: "#ef3f4c", width: 2.6 };
    const pageInk = inkByPageRef.current.get(pageNumber) ?? [];
    pageInk.push(stroke);
    inkByPageRef.current.set(pageNumber, pageInk);
    activeStrokeRef.current = stroke;
    setHasInk(true);
    redrawInk();
  };
  const continueInk = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drawMode || !activeStrokeRef.current) return;
    activeStrokeRef.current.points.push(pointForEvent(event));
    redrawInk();
  };
  const finishInk = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    activeStrokeRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const clearInk = () => {
    inkByPageRef.current.delete(pageNumber);
    activeStrokeRef.current = null;
    setHasInk(false);
    redrawInk();
  };
  const rotatePdf = () => {
    for (const [inkPage, strokes] of inkByPageRef.current.entries()) {
      inkByPageRef.current.set(inkPage, strokes.map((stroke) => ({ ...stroke, points: stroke.points.map((point) => ({ x: 1 - point.y, y: point.x })) })));
    }
    setRotation((current) => (current + 90) % 360);
  };
  const changeZoom = (amount: number) => setZoom((current) => Math.min(3, Math.max(0.5, Number((current + amount).toFixed(1)))));
  const switchSource = (nextSource: ChartSource) => {
    setSource(nextSource);
    setSelected(null);
    setQuery("");
    setCategory("全部");
    setError("");
    resetPreview();
  };
  const chooseAirport = (airport: string) => {
    setSelectedAirport(airport);
    setQuery("");
    setCategory("全部");
  };
  const leaveAirport = () => {
    setSelectedAirport("");
    setQuery("");
    setCategory("全部");
  };
  const chooseChart = (chart: Chart) => {
    setSelected(chart);
    setChartFoxUrl("");
    resetPreview();
  };
  const chooseChartFox = (chart: { id: string; title: string; chartType: string; url: string }) => {
    setSelected({ id: `chartfox-${chart.id}`, airport: chartFoxIcao, category: categoryForChartFox(chart.chartType), title: chart.title, revision: "ChartFox", cached: false });
    setChartFoxUrl(chart.url);
    resetPreview();
  };
  const loadPdf = (file: File) => {
    setPdfSource(file);
    setFileName(file.name);
    setError("");
    resetPdfTools();
  };
  const chooseLibrary = async (sourceType: "folder" | "zip") => {
    if (!isTauri()) {
      setError("浏览器模式不支持本地航图库。");
      return;
    }
    const path = await open(sourceType === "folder" ? { multiple: false, directory: true } : { multiple: false, directory: false, filters: [{ name: "ZIP 航图库", extensions: ["zip"] }] });
    if (path && !Array.isArray(path)) localLibraryMutation.mutate(path);
  };
  const chooseLocalChart = async (chart: Chart) => {
    chooseChart(chart);
    try {
      const cachedPath = await openLocalChart(chart.id);
      setPdfSource(convertFileSrc(cachedPath));
      setFileName(/\.pdf$/i.test(chart.title) ? chart.title : `${chart.title}.pdf`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法打开本地航图");
    }
  };
  const importPdf = async () => {
    if (!isTauri()) {
      inputRef.current?.click();
      return;
    }
    const sourcePath = await open({ multiple: false, directory: false, filters: [{ name: "PDF 航图", extensions: ["pdf"] }] });
    if (!sourcePath || Array.isArray(sourcePath)) return;
    try {
      const cachedPath = await cacheChartPdf(sourcePath, selected?.id ?? `manual-${crypto.randomUUID()}`);
      setPdfSource(convertFileSrc(cachedPath));
      setFileName(sourcePath.split(/[\\/]/).pop() ?? "航图.pdf");
      setError("");
      resetPdfTools();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法导入航图");
    }
  };

  const pageWidth = Math.max(280, Math.round(viewerWidth * zoom));

  return <div className="chart-page split-page">
    <section className="panel chart-sidebar">
      <div className="chart-source-selector"><button className={source === "local" ? "active" : ""} onClick={() => switchSource("local")}>本地航图库</button><button className={source === "chartfox" ? "active" : ""} onClick={() => switchSource("chartfox")}>CHARTFOX</button></div>
      {source === "local" ? <>
        <div className="local-library-actions"><button className="button secondary" onClick={() => chooseLibrary("folder")} disabled={localLibraryMutation.isPending}><FolderOpen size={16} />选择文件夹</button><button className="button secondary" onClick={() => chooseLibrary("zip")} disabled={localLibraryMutation.isPending}><Archive size={16} />选择 ZIP</button></div>
        <p className="source-description">选择 <code>Terminal</code> 文件夹或其上级目录。第一层 <code>&lt;ICAO&gt;/</code> 文件夹用于机场分类，同级 <code>Charts.csv</code> 用于读取航图编号和类型。</p>
        <p className={localLibrary.data?.ready ? "local-library-status" : "chartfox-state"}>{localLibraryMutation.isPending ? "正在扫描本地航图库…" : localLibraryMutation.isError ? localLibraryMutation.error.message : localLibrary.data?.message}</p>
        {localLibrary.data?.ready && !selectedAirport && <>
          <div className="local-airport-browser-heading"><div><strong>全部机场</strong><span>{airportGroups.length} 个机场</span></div><small>选择机场后查看该机场的全部航图</small></div>
          <div className="search-box"><Search size={18} /><input placeholder="搜索机场 ICAO" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
          <div className="local-airport-grid">{localCharts.isFetching && <p className="chartfox-state">正在读取航图目录…</p>}{visibleAirportGroups.map((group) => <button className="local-airport-card" key={group.airport} onClick={() => chooseAirport(group.airport)}><span className="local-airport-icon"><Building2 size={20} /></span><span><strong>{group.airport}</strong><small>{group.charts.length} 份航图</small><em>{airportChartSummary(group.charts)}</em></span><ChevronRight size={18} /></button>)}{!localCharts.isFetching && visibleAirportGroups.length === 0 && <p className="chartfox-state">没有匹配的机场。</p>}</div>
        </>}
        {localLibrary.data?.ready && selectedAirport && <>
          <div className="local-airport-breadcrumb"><button onClick={leaveAirport}><ArrowLeft size={16} />全部机场</button><div><strong>{selectedAirport}</strong><span>{airportGroups.find((group) => group.airport === selectedAirport)?.charts.length ?? 0} 份航图</span></div></div>
          <div className="search-box"><Search size={18} /><input placeholder={`搜索 ${selectedAirport} 航图`} value={query} onChange={(event) => setQuery(event.target.value)} /></div>
          <div className="chart-filter">{(["全部", "机场", "进场", "离场", "航路"] as const).map((item) => <button key={item} className={category === item ? "active" : ""} onClick={() => setCategory(item)}>{item}</button>)}</div>
          <div className="chart-list">{visibleAirportCharts.map((chart) => <button key={chart.id} onClick={() => chooseLocalChart(chart)} className={selected?.id === chart.id ? "selected" : ""}><FileText size={18} /><span><strong>{chart.title}</strong><small>{chart.category} · {chart.revision}</small></span><Download size={15} className="cached-icon" /></button>)}{visibleAirportCharts.length === 0 && <p className="chartfox-state">当前筛选条件下没有航图。</p>}</div>
        </>}
      </> : <>
        <div className="chartfox-search"><label>ICAO 机场代码<input value={chartFoxIcao} maxLength={4} onChange={(event) => setChartFoxIcao(event.target.value.toUpperCase())} /></label><button className="icon-button" onClick={() => chartFox.refetch()} disabled={chartFox.isFetching} aria-label="刷新 ChartFox"><RefreshCw className={chartFox.isFetching ? "spinning" : ""} size={17} /></button></div><p className="source-description">ChartFox 提供的航图索引。可用性、内容与许可由 ChartFox 决定。</p><div className="chart-list">{chartFox.isFetching && <p className="chartfox-state">正在查询 ChartFox…</p>}{chartFox.isError && <p className="chartfox-state error">{chartFox.error.message}</p>}{chartFox.data?.length === 0 && <p className="chartfox-state">此机场暂无可用航图。</p>}{chartFox.data?.map((chart) => <button key={chart.id} onClick={() => chooseChartFox(chart)} className={selected?.id === `chartfox-${chart.id}` ? "selected" : ""}><FileText size={18} /><span><strong>{chart.title}</strong><small>{chart.chartType || "CHARTFOX"} · {chartFoxIcao}</small></span><ExternalLink size={15} className="cached-icon" /></button>)}</div>
      </>}
    </section>
    <section className="chart-viewer">
      <div className="chart-viewer-header"><div><p className="eyebrow">{selected ? `${selected.airport} · ${source === "chartfox" ? "CHARTFOX" : selected.category}` : "航图预览"}</p><h2>{pdfSource ? fileName : selected?.title ?? "请选择机场与航图"}</h2></div><StatusBadge tone={pdfSource ? "success" : selected ? "warning" : "neutral"}>{pdfSource ? "本地已打开" : selected ? source === "chartfox" ? "在线索引" : "未打开" : "等待选择"}</StatusBadge></div>
      <input className="visually-hidden" ref={inputRef} type="file" accept="application/pdf" onChange={(event) => { const file = event.target.files?.[0]; if (file) loadPdf(file); }} />
      {pdfSource ? <>
        <div className="pdf-toolbar">
          <div className="pdf-toolbar-group"><button onClick={() => changeZoom(-0.1)} disabled={zoom <= 0.5} aria-label="缩小航图" title="缩小"><Minus size={17} /></button><button className="pdf-zoom-value" onClick={() => setZoom(1)} title="恢复适应宽度">{Math.round(zoom * 100)}%</button><button onClick={() => changeZoom(0.1)} disabled={zoom >= 3} aria-label="放大航图" title="放大"><Plus size={17} /></button></div>
          <div className="pdf-toolbar-group"><button onClick={rotatePdf} title="顺时针旋转"><RotateCw size={17} /><span>旋转</span></button><button className={drawMode ? "active" : ""} onClick={() => setDrawMode((current) => !current)} aria-pressed={drawMode} title="画笔标注"><PenLine size={17} /><span>画笔</span></button><button onClick={clearInk} disabled={!hasInk} title="清除当前页标注"><Trash2 size={17} /><span>清除</span></button></div>
          <div className="pdf-toolbar-group pdf-page-controls"><button disabled={pageNumber <= 1} onClick={() => setPageNumber((page) => page - 1)} aria-label="上一页"><ChevronLeft size={17} /></button><span>{pageNumber} / {pageCount || "–"}</span><button disabled={pageCount === 0 || pageNumber >= pageCount} onClick={() => setPageNumber((page) => page + 1)} aria-label="下一页"><ChevronRight size={17} /></button></div>
        </div>
        <div className="pdf-viewer" ref={viewerRef}><Document file={pdfSource} onLoadSuccess={({ numPages }: { numPages: number }) => { setPageCount(numPages); setPageNumber(1); }} onLoadError={(reason) => setError(`无法读取 PDF：${reason instanceof Error ? reason.message : "文件加载失败"}`)} loading={<div className="pdf-loading">正在渲染航图…</div>}><div className="pdf-page-stage" ref={pageStageRef}><Page pageNumber={pageNumber} width={pageWidth} rotate={rotation} renderTextLayer renderAnnotationLayer /><canvas ref={inkCanvasRef} className={`pdf-ink-canvas ${drawMode ? "active" : ""}`} onPointerDown={startInk} onPointerMove={continueInk} onPointerUp={finishInk} onPointerCancel={finishInk} /></div></Document></div>
      </> : <div className="chart-placeholder"><BookOpen size={42} /><strong>{selected ? "尚未打开 PDF" : "没有正在预览的航图"}</strong><p>{selected ? "点击本地航图可直接打开，或导入一份合法授权的 PDF。" : "先选择本地航图库中的机场与航图，或切换到 ChartFox 查询。"}</p></div>}
      <div className="chart-controls"><button className="button secondary" onClick={importPdf}><FilePlus2 size={17} />导入单份 PDF</button>{chartFoxUrl && <a className="button secondary" href={chartFoxUrl} target="_blank" rel="noreferrer"><ExternalLink size={16} />在 ChartFox 查看</a>}{!isTauri() && <span className="chart-cache-note"><BookOpen size={15} />浏览器模式仅临时预览</span>}</div>
      {error && <p className="form-error">{error}</p>}
      <div className="chart-meta"><span>来源：{source === "chartfox" ? "ChartFox" : localLibrary.data?.sourceType === "zip" ? "本地 ZIP" : "本地文件夹"}</span><span>格式：PDF</span><span>请遵守数据源的使用条款</span></div>
    </section>
  </div>;
}

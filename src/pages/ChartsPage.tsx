import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Document, Page, pdfjs } from "react-pdf";
import { open } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import { BookOpen, ChevronLeft, ChevronRight, Download, ExternalLink, FilePlus2, FileText, RefreshCw, Search } from "lucide-react";
import { charts } from "../lib/data";
import { cacheChartPdf, isTauri, listChartFoxCharts } from "../lib/tauri";
import type { Chart } from "../types";
import { StatusBadge } from "../components/common/StatusBadge";

pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
type PdfSource = File | string;
type ChartSource = "local" | "chartfox";

function categoryForChartFox(type: string): Chart["category"] {
  if (/arrival|approach|star|iac/i.test(type)) return "进场";
  if (/departure|sid/i.test(type)) return "离场";
  if (/enroute|route/i.test(type)) return "航路";
  return "机场";
}
function ProcedurePreview({ chart }: { chart: Chart }) { return <div className="procedure-preview"><svg viewBox="0 0 700 460" role="img" aria-label={`${chart.title} 航图示意`}><rect width="700" height="460" rx="12" className="procedure-paper" /><text x="42" y="50" className="procedure-title">{chart.airport} · {chart.title}</text><text x="42" y="74" className="procedure-subtitle">DEMO PROCEDURE OVERVIEW · {chart.revision}</text><path className="procedure-route" d="M90 346 C156 280 140 202 243 191 S357 92 442 154 S533 328 620 253" /><circle className="procedure-fix" cx="90" cy="346" r="7" /><circle className="procedure-fix" cx="243" cy="191" r="7" /><circle className="procedure-fix" cx="442" cy="154" r="7" /><circle className="procedure-fix" cx="620" cy="253" r="7" /><text x="70" y="372">START</text><text x="218" y="175">FIX 1</text><text x="420" y="138">FIX 2</text><text x="590" y="280">RWY</text><path className="procedure-runway" d="M545 330 l98 -34 l8 23 l-98 34z" /><text x="42" y="417" className="procedure-note">示意预览不能用于真实飞行导航。请导入合法授权的 PDF 航图。</text></svg></div>; }

export function ChartsPage() {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<"全部" | Chart["category"]>("全部");
  const [source, setSource] = useState<ChartSource>("local");
  const [chartFoxIcao, setChartFoxIcao] = useState("ZBAA");
  const [selected, setSelected] = useState<Chart>(charts[0]);
  const [chartFoxUrl, setChartFoxUrl] = useState("");
  const [pdfSource, setPdfSource] = useState<PdfSource | null>(null);
  const [fileName, setFileName] = useState("");
  const [pageCount, setPageCount] = useState(0);
  const [pageNumber, setPageNumber] = useState(1);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const filtered = useMemo(() => charts.filter((chart) => (category === "全部" || chart.category === category) && `${chart.airport} ${chart.title}`.toLowerCase().includes(query.toLowerCase())), [category, query]);
  const chartFox = useQuery({ queryKey: ["chartfox", chartFoxIcao], queryFn: () => listChartFoxCharts(chartFoxIcao), enabled: source === "chartfox" && chartFoxIcao.length === 4, retry: 1 });
  const resetPreview = () => { setPdfSource(null); setFileName(""); setPageCount(0); setPageNumber(1); setError(""); };
  const chooseChart = (chart: Chart) => { setSelected(chart); setChartFoxUrl(""); resetPreview(); };
  const chooseChartFox = (chart: { id: string; title: string; chartType: string; url: string }) => { setSelected({ id: `chartfox-${chart.id}`, airport: chartFoxIcao, category: categoryForChartFox(chart.chartType), title: chart.title, revision: "ChartFox", cached: false }); setChartFoxUrl(chart.url); resetPreview(); };
  const loadPdf = (file: File) => { setPdfSource(file); setFileName(file.name); setPageCount(0); setPageNumber(1); setError(""); };
  const importPdf = async () => { if (!isTauri()) { inputRef.current?.click(); return; } const sourcePath = await open({ multiple: false, directory: false, filters: [{ name: "PDF 航图", extensions: ["pdf"] }] }); if (!sourcePath || Array.isArray(sourcePath)) return; try { const cachedPath = await cacheChartPdf(sourcePath, selected.id); setPdfSource(convertFileSrc(cachedPath)); setFileName(sourcePath.split(/[\\/]/).pop() ?? "航图.pdf"); setPageCount(0); setPageNumber(1); setError(""); } catch (reason) { setError(reason instanceof Error ? reason.message : "无法导入航图"); } };
  return <div className="chart-page split-page"><section className="panel chart-sidebar"><div className="chart-source-selector"><button className={source === "local" ? "active" : ""} onClick={() => setSource("local")}>本地缓存</button><button className={source === "chartfox" ? "active" : ""} onClick={() => setSource("chartfox")}>CHARTFOX</button></div>{source === "local" ? <><div className="search-box"><Search size={18} /><input placeholder="搜索航图或机场" value={query} onChange={(event) => setQuery(event.target.value)} /></div><div className="chart-filter">{(["全部", "机场", "进场", "离场", "航路"] as const).map((item) => <button key={item} className={category === item ? "active" : ""} onClick={() => setCategory(item)}>{item}</button>)}</div><div className="chart-list">{filtered.map((chart) => <button key={chart.id} onClick={() => chooseChart(chart)} className={selected.id === chart.id ? "selected" : ""}><FileText size={18} /><span><strong>{chart.title}</strong><small>{chart.airport} · {chart.revision}</small></span>{chart.cached && <Download size={15} className="cached-icon" />}</button>)}</div></> : <><div className="chartfox-search"><label>ICAO 机场代码<input value={chartFoxIcao} maxLength={4} onChange={(event) => setChartFoxIcao(event.target.value.toUpperCase())} /></label><button className="icon-button" onClick={() => chartFox.refetch()} disabled={chartFox.isFetching} aria-label="刷新 ChartFox"><RefreshCw className={chartFox.isFetching ? "spinning" : ""} size={17} /></button></div><p className="source-description">ChartFox 提供的航图索引。可用性、内容与许可由 ChartFox 决定。</p><div className="chart-list">{chartFox.isFetching && <p className="chartfox-state">正在查询 ChartFox…</p>}{chartFox.isError && <p className="chartfox-state error">{chartFox.error.message}</p>}{chartFox.data?.length === 0 && <p className="chartfox-state">此机场暂无可用航图。</p>}{chartFox.data?.map((chart) => <button key={chart.id} onClick={() => chooseChartFox(chart)} className={selected.id === `chartfox-${chart.id}` ? "selected" : ""}><FileText size={18} /><span><strong>{chart.title}</strong><small>{chart.chartType || "CHARTFOX"} · {chartFoxIcao}</small></span><ExternalLink size={15} className="cached-icon" /></button>)}</div></>}</section>
    <section className="chart-viewer"><div className="chart-viewer-header"><div><p className="eyebrow">{selected.airport} · {source === "chartfox" ? "CHARTFOX" : selected.category}</p><h2>{pdfSource ? fileName : selected.title}</h2></div><StatusBadge tone={pdfSource || selected.cached ? "success" : "warning"}>{pdfSource ? "本地已导入" : selected.cached ? "演示缓存" : source === "chartfox" ? "在线索引" : "未下载"}</StatusBadge></div><input className="visually-hidden" ref={inputRef} type="file" accept="application/pdf" onChange={(event) => { const file = event.target.files?.[0]; if (file) loadPdf(file); }} />{pdfSource ? <div className="pdf-viewer"><Document file={pdfSource} onLoadSuccess={({ numPages }: { numPages: number }) => { setPageCount(numPages); setPageNumber(1); }} onLoadError={() => setError("无法读取 PDF，请确认文件未损坏。")} loading={<div className="pdf-loading">正在渲染航图…</div>}><Page pageNumber={pageNumber} width={760} renderTextLayer renderAnnotationLayer /></Document></div> : <ProcedurePreview chart={selected} />}<div className="chart-controls"><button className="button secondary" onClick={importPdf}><FilePlus2 size={17} />导入并缓存 PDF</button>{chartFoxUrl && <a className="button secondary" href={chartFoxUrl} target="_blank" rel="noreferrer"><ExternalLink size={16} />在 ChartFox 查看</a>}{pdfSource && <><button className="icon-button" disabled={pageNumber <= 1} onClick={() => setPageNumber((page) => page - 1)} aria-label="上一页"><ChevronLeft size={18} /></button><span>第 {pageNumber} / {pageCount || "–"} 页</span><button className="icon-button" disabled={pageCount === 0 || pageNumber >= pageCount} onClick={() => setPageNumber((page) => page + 1)} aria-label="下一页"><ChevronRight size={18} /></button></>}<span className="chart-cache-note"><BookOpen size={15} />{isTauri() ? "PDF 将复制到本机缓存" : "浏览器模式仅临时预览"}</span></div>{error && <p className="form-error">{error}</p>}<div className="chart-meta"><span>来源：{source === "chartfox" ? "ChartFox" : "本地缓存"}</span><span>格式：PDF</span><span>请遵守数据源的使用条款</span></div></section></div>;
}

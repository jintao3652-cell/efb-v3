import { useMemo, useState } from "react";
import { BookOpen, Download, FileText, FolderOpen, Search } from "lucide-react";
import { charts } from "../lib/data";
import type { Chart } from "../types";
import { StatusBadge } from "../components/common/StatusBadge";

export function ChartsPage() {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<"全部" | Chart["category"]>("全部");
  const [selected, setSelected] = useState<Chart>(charts[0]);
  const filtered = useMemo(() => charts.filter((chart) => (category === "全部" || chart.category === category) && `${chart.airport} ${chart.title}`.toLowerCase().includes(query.toLowerCase())), [category, query]);
  return <div className="chart-page split-page"><section className="panel chart-sidebar"><div className="search-box"><Search size={18} /><input placeholder="搜索航图或机场" value={query} onChange={(event) => setQuery(event.target.value)} /></div><div className="chart-filter">{(["全部", "机场", "进场", "离场", "航路"] as const).map((item) => <button key={item} className={category === item ? "active" : ""} onClick={() => setCategory(item)}>{item}</button>)}</div><div className="chart-list">{filtered.map((chart) => <button key={chart.id} onClick={() => setSelected(chart)} className={selected.id === chart.id ? "selected" : ""}><FileText size={18} /><span><strong>{chart.title}</strong><small>{chart.airport} · {chart.revision}</small></span>{chart.cached && <Download size={15} className="cached-icon" />}</button>)}</div></section><section className="chart-viewer"><div className="chart-viewer-header"><div><p className="eyebrow">{selected.airport} · {selected.category}</p><h2>{selected.title}</h2></div><StatusBadge tone={selected.cached ? "success" : "warning"}>{selected.cached ? "已缓存" : "未下载"}</StatusBadge></div><div className="chart-placeholder"><FolderOpen size={46} /><h3>本地 PDF 航图预览</h3><p>{selected.cached ? "航图文件已缓存。接入授权数据源后将使用 PDF.js 在这里渲染。" : "此航图尚未缓存，连接授权航图数据源后可下载。"}</p><button className="button primary"><Download size={17} />{selected.cached ? "打开本地文件" : "下载至本机"}</button></div><div className="chart-meta"><span>修订：{selected.revision}</span><span>格式：PDF</span><span>存储：{selected.cached ? "本地缓存" : "按需下载"}</span></div></section></div>;
}

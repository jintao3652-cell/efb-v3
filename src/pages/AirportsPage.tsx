import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { BookOpen, CloudSun, Compass, MapPin, Plane, Radio, RefreshCw, Search, Wind } from "lucide-react";
import { getNotams, isTauri } from "../lib/tauri";
import { loadAdHpAirports } from "../lib/airport-data";
import { airports as fallbackAirports } from "../lib/data";
import { loadStationWeather, weatherRegion } from "../lib/weather";
import { parseMetar, windLabel } from "../lib/metar";
import { groupComms, jeppAirportOverview } from "../lib/jepp";
import { fetchNotams, notamStateLabel, shortUtc } from "../lib/notam";
import { gateKindLabel, getAirport, getFrequencies, getGates, getRunways, sortGates, surfaceLabel, type XflyAirport, type XflyGate } from "../lib/xfly";
import { useAppStore } from "../stores/app-store";

/** 管制单位按塔台运行顺序排列，避免接口返回顺序随机。 */
const frequencyOrder = ["ATIS", "CLD", "DEL", "GND", "TWR", "APP", "DEP", "CTR", "FSS", "UNICOM", "OPS"];

function frequencyRank(type: string) {
  const index = frequencyOrder.indexOf((type ?? "").trim().toUpperCase());
  return index === -1 ? frequencyOrder.length : index;
}

function formatFt(value: number | string | null | undefined) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? `${numeric.toLocaleString("en-US")} ft` : "—";
}

function formatMhz(value: number | string) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value);
  return numeric.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

/** J3N 周期日期是 YYYYMMDD，拼成 AIRAC 编号（如 2026 + 10 → 2610）。 */
function cycleLabel(cycle: { datacycle: string; datacycleyear?: string } | null | undefined) {
  if (!cycle?.datacycle) return "";
  const year = cycle.datacycleyear ? cycle.datacycleyear.slice(-2) : "";
  return `${year}${cycle.datacycle}`;
}

/** J3N 通讯类型码的中文 / 缩写对照，比裸类型名更贴近机组用语。 */
const commLabels: Record<string, string> = {
  ATIS: "ATIS 通播",
  放行: "放行 CLD",
  地面: "地面 GND",
  塔台: "塔台 TWR",
  "进近/离场": "进近 / 离场 APP",
  机坪: "机坪 APR",
  UNICOM: "UNICOM",
};

/** 跑道端排序：01 → 18L → 18R → 19 → 36L。 */
function runwaySort(a: string, b: string) {
  return a.localeCompare(b, "en", { numeric: true });
}

export function AirportsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [icao, setIcao] = useState((searchParams.get("icao") ?? "ZBAA").toUpperCase());
  const [query, setQuery] = useState("");
  const navigate = useNavigate();
  const setSelectedAirport = useAppStore((state) => state.setSelectedAirport);
  const groundLayerOn = useAppStore((state) => state.layers.ground);
  const toggleLayer = useAppStore((state) => state.toggleLayer);

  const catalog = useQuery({ queryKey: ["ad-hp-airports"], queryFn: loadAdHpAirports, staleTime: Infinity });
  const airports = catalog.data ?? fallbackAirports;
  const local = airports.find((item) => item.icao === icao);

  // 机场资料以 JeppQuery 为准：一次总览拿全名称 / 坐标 / 频率 / 跑道 / ILS / 周期。
  const overview = useQuery({
    queryKey: ["jepp-overview", icao],
    queryFn: () => jeppAirportOverview(icao),
    enabled: icao.length === 4,
    staleTime: 60 * 60_000,
    retry: 0,
  });
  // NOTAM 走 ATIS View（多云 AIS 源聚合）；接口不可用时回落到本地导航库。
  const notams = useQuery({
    queryKey: ["atis-notams", icao],
    queryFn: () => fetchNotams(icao, 10),
    enabled: icao.length === 4,
    staleTime: 10 * 60_000,
    retry: 0,
  });

  // XFly 只补 Jepp 没有的：中文名、机场类型、停机位、道面文字。
  const xflyAirport = useQuery({
    queryKey: ["xfly-airport-info", icao],
    queryFn: () => getAirport(icao),
    enabled: icao.length === 4,
    staleTime: 30 * 60_000,
    retry: 0,
  });
  const xflyRunways = useQuery({
    queryKey: ["xfly-runways", icao],
    queryFn: () => getRunways(icao),
    enabled: icao.length === 4,
    staleTime: 60 * 60_000,
    retry: 0,
  });
  const xflyFreqs = useQuery({
    queryKey: ["xfly-frequencies", icao],
    queryFn: () => getFrequencies(icao),
    enabled: icao.length === 4,
    staleTime: 60 * 60_000,
    retry: 0,
  });
  const xflyGates = useQuery({
    queryKey: ["xfly-gates", icao],
    queryFn: () => getGates(icao),
    enabled: icao.length === 4,
    staleTime: 60 * 60_000,
    retry: 0,
  });
  const localNotams = useQuery({
    queryKey: ["notams", icao],
    queryFn: () => getNotams(icao),
    enabled: isTauri() && icao.length === 4,
    staleTime: 10 * 60_000,
    retry: 0,
  });
  // 气象源按「中国 / 境外」分开配置，与气象页保持同一份偏好。
  const weatherSourceCn = useAppStore((state) => state.weatherSourceCn);
  const weatherSourceIntl = useAppStore((state) => state.weatherSourceIntl);
  const weatherPreference = weatherRegion(icao) === "cn" ? weatherSourceCn : weatherSourceIntl;
  const weather = useQuery({
    queryKey: ["station-weather", icao, weatherPreference],
    queryFn: () => loadStationWeather(icao, { preference: weatherPreference }),
    staleTime: 4 * 60_000,
    retry: 1,
  });

  useEffect(() => { setSearchParams({ icao }, { replace: true }); }, [icao, setSearchParams]);

  const visible = useMemo(() => {
    const keyword = query.trim().toUpperCase();
    if (!keyword) return airports.slice(0, 60);
    return airports.filter((item) => `${item.icao}${item.iata}${item.name}${item.city}`.toUpperCase().includes(keyword)).slice(0, 60);
  }, [airports, query]);

  const info: XflyAirport | null = xflyAirport.data ?? null;
  const o = overview.data ?? null;
  const metar = weather.data ? parseMetar(weather.data.raw) : null;
  const cycle = o?.cycle ?? null;

  const nameCn = info?.cnName ?? local?.name ?? "";
  const nameEn = o?.name ?? info?.enName ?? "";
  const iata = o?.iata || info?.iataCode || local?.iata || "";
  const city = o?.city || info?.municipalityCn || info?.municipality || local?.city || "";
  const regionCode = o?.region || info?.isoRegion || "";
  const countryLabel = o?.country_name || o?.country || "";
  const elevationFt = o?.elevation_ft ?? info?.elevationFt ?? null;

  const comms = o?.comms ?? [];
  const frequencies = useMemo(() => {
    if (comms.length) {
      return groupComms(comms).map((group) => ({
        type: group.type,
        name: commLabels[group.type] ?? group.type,
        value: group.values.map(formatMhz).join(" · "),
      }));
    }
    // Jepp 没有频率记录时退回 XFly。
    return (xflyFreqs.data ?? [])
      .map((row) => ({ type: row.type, name: row.description || row.type, value: formatMhz(row.frequencyMhz) }))
      .sort((a, b) => frequencyRank(a.type) - frequencyRank(b.type) || a.name.localeCompare(b.name));
  }, [comms, xflyFreqs.data]);

  // Jepp 只给道面数字码（语义未确认），用 XFly 的跑道道面字段翻成中文。
  const surfaceByIdent = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of xflyRunways.data ?? []) {
      map.set(row.leIdent.toUpperCase(), surfaceLabel(row.surface));
      map.set(row.heIdent.toUpperCase(), surfaceLabel(row.surface));
    }
    return map;
  }, [xflyRunways.data]);

  const runwayRows = useMemo(() => {
    if ((o?.runways ?? []).length) {
      return [...o!.runways]
        .sort((a, b) => runwaySort(a.ident, b.ident))
        .map((row) => ({
          key: row.ident,
          label: row.ident,
          lengthFt: row.length_ft,
          widthFt: row.width_ft,
          surface: surfaceByIdent.get(row.ident.toUpperCase()) ?? (row.surface_code != null ? `代码 ${row.surface_code}` : "—"),
          elevation: `${formatFt(row.elevation_ft)}`,
          heading: row.magnetic_heading != null ? `${row.magnetic_heading.toFixed(0)}°` : "—",
        }));
    }
    return (xflyRunways.data ?? []).map((row) => ({
      key: `${row.leIdent}-${row.heIdent}`,
      label: `${row.leIdent}/${row.heIdent}`,
      lengthFt: Number(row.lengthFt),
      widthFt: Number(row.widthFt),
      surface: surfaceLabel(row.surface),
      elevation: `${row.leElevationFt} / ${row.heElevationFt} ft`,
      heading: `${row.leHeadingDegt}°`,
    }));
  }, [o, surfaceByIdent, xflyRunways.data]);

  const gates = xflyGates.data ?? [];
  /** 停机位按 XFS 的 `gateType` 分组：登机口（廊桥）在前，其余（远机位）在后。 */
  const gateGroups = useMemo(() => {
    const buckets = new Map<string, XflyGate[]>();
    for (const row of sortGates(xflyGates.data ?? [])) {
      const key = row.gateType || "other";
      const list = buckets.get(key);
      if (list) list.push(row);
      else buckets.set(key, [row]);
    }
    return [...buckets.entries()]
      .sort(([a], [b]) => (a === "gate" ? -1 : b === "gate" ? 1 : a.localeCompare(b)))
      .map(([key, rows]) => ({ key, label: gateKindLabel(key), rows }));
  }, [xflyGates.data]);
  const ilsRows = o?.ils ?? [];
  const longestRunway = (o?.runway_ft ?? 0) || (runwayRows.length ? Math.max(...runwayRows.map((row) => Number(row.lengthFt))) : 0);

  const notamRows = notams.data?.notams ?? [];
  const localNotamRows = localNotams.data?.notams ?? [];

  const stationType = useMemo(() => {
    const value = info?.type ?? "";
    if (value === "large_airport") return "大型机场";
    if (value === "medium_airport") return "中型机场";
    if (value === "small_airport") return "小型机场";
    if (value === "heliport") return "直升机场";
    if (value === "seaplane_base") return "水上机场";
    return value || "";
  }, [info]);

  const subtitle = [city, countryLabel, regionCode, stationType, cycle ? `AIRAC ${cycleLabel(cycle)}` : ""].filter(Boolean).join(" · ");

  return <div className="page">
    <aside className="page-panel">
      <div className="panel-head"><span className="side-mark" /><h2>机场资料</h2><span className="count">{airports.length}</span></div>
      <div style={{ padding: "0 10px 8px" }}>
        <label className="input-icon"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 ICAO / IATA / 机场" /></label>
      </div>
      <div className="panel-body">
        {visible.map((item) => <button key={item.icao} className={`airport-row ${item.icao === icao ? "active" : ""}`} onClick={() => setIcao(item.icao)}>
          <span className="code">{item.icao}</span>
          <span className="grow"><strong>{item.name}</strong><small>{item.city} · {item.iata} · {item.elevation}</small></span>
        </button>)}
        {visible.length === 0 && <p className="empty">没有匹配的机场</p>}
      </div>
    </aside>

    <div className="airport-content">
      <header className="airport-head">
        <div>
          <h1>{icao}<span className="ap-iata">{iata}</span>
            {o?.precision_approach && <span className="badge green" style={{ marginLeft: 8, verticalAlign: "middle" }}>精密进近</span>}
          </h1>
          <h2>{[nameCn, nameEn].filter(Boolean).join(" · ") || "—"}</h2>
          <p className="ap-sub">{subtitle}</p>
        </div>
        <div className="ap-actions">
          <button className="btn soft" onClick={() => { setSelectedAirport(icao); navigate("/"); }}><MapPin size={14} />地图定位</button>
          <button className="btn soft" onClick={() => navigate(`/charts?icao=${icao}`)}><BookOpen size={14} />航图库</button>
          <button className="btn primary" onClick={() => navigate(`/weather?icao=${icao}`)}><CloudSun size={14} />气象</button>
        </div>
      </header>

      {overview.isError && <div className="set-msg" style={{ marginBottom: 12 }}>
        机场总览获取失败：{(overview.error as Error)?.message ?? "未知错误"}——以下回退到 XFly 数据。
      </div>}
      {!overview.isFetching && !overview.isError && !overview.data && <div className="set-msg" style={{ marginBottom: 12 }}>
        JeppQuery 没有该机场的导航数据（404），以下回退到 XFly。
      </div>}

      <div className="info-grid">
        <div className="info-cell"><span title="全场跑道入口标高的最高值">标高</span><strong>{formatFt(elevationFt)}</strong></div>
        <div className="info-cell"><span>磁差 / 时区</span><strong>{o?.magnetic_variation || "—"} · {o?.utc_offset || "—"}</strong></div>
        <div className="info-cell"><span>跑道</span><strong>{runwayRows.length} 端 · 最长 {formatFt(longestRunway)}</strong></div>
        <div className="info-cell"><span>数据周期</span><strong>{cycle ? `AIRAC ${cycleLabel(cycle)}` : "—"}</strong></div>
        <div className="info-cell"><span title="来自 XFS 的机位点数据">停机位 · XFS</span><strong>{gates.length ? `${gates.length} 个` : "—"}</strong></div>
        <div className="info-cell"><span>地面风</span><strong>{metar ? windLabel(metar.wind) : "—"}</strong></div>
        <div className="info-cell"><span>QNH</span><strong>{metar?.qnh ? `${metar.qnh} hPa` : "—"}</strong></div>
      </div>

      <section className="dp-section">
        <div className="dp-section-head"><h3><Radio size={14} />管制单位及频率</h3><span>{frequencies.length} 组 · Frequencies</span></div>
        <div className="dp-card" style={{ padding: 0, overflow: "hidden" }}>
          <table className="freq-table">
            <thead><tr><th>类型</th><th>单位</th><th>频率（MHz）</th></tr></thead>
            <tbody>
              {frequencies.map((row) => <tr key={`${row.type}-${row.name}`}>
                <td>{row.type ? <span className="badge gray">{row.type}</span> : "—"}</td>
                <td>{row.name}</td>
                <td className="mono">{row.value}</td>
              </tr>)}
              {frequencies.length === 0 && <tr><td colSpan={3} className="muted">暂无频率数据</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="dp-section">
        <div className="dp-section-head"><h3><Plane size={14} />跑道</h3><span>{runwayRows.length} 端 · Runways</span></div>
        <div className="dp-card" style={{ padding: 0, overflow: "hidden" }}>
          <table className="freq-table">
            <thead><tr><th>跑道</th><th>长度</th><th>宽度</th><th>道面</th><th>入口标高</th><th>磁航向</th></tr></thead>
            <tbody>
              {runwayRows.map((row) => <tr key={row.key}>
                <td className="mono">{row.label}</td>
                <td>{Number(row.lengthFt).toLocaleString("en-US")} ft</td>
                <td>{Number(row.widthFt).toLocaleString("en-US")} ft</td>
                <td>{row.surface}</td>
                <td>{row.elevation}</td>
                <td className="mono">{row.heading}</td>
              </tr>)}
              {runwayRows.length === 0 && <tr><td colSpan={6} className="muted">暂无跑道数据</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      {ilsRows.length > 0 && <section className="dp-section">
        <div className="dp-section-head"><h3><Compass size={14} />ILS</h3><span>{ilsRows.length} 套 · Instrument Landing</span></div>
        <div className="dp-card" style={{ padding: 0, overflow: "hidden" }}>
          <table className="freq-table">
            <thead><tr><th>识别码</th><th>跑道</th><th>频率</th><th>磁航向</th><th>下滑角</th></tr></thead>
            <tbody>
              {ilsRows.map((row) => <tr key={`${row.ident}-${row.runway}`}>
                <td className="mono">{row.ident}</td>
                <td className="mono">{row.runway || "—"}</td>
                <td className="mono">{row.frequency_mhz.toFixed(2)}</td>
                <td className="mono">{row.magnetic_course?.toFixed(0)}°</td>
                <td>{row.glide_slope?.toFixed(1)}°</td>
              </tr>)}
            </tbody>
          </table>
        </div>
      </section>}

      <section className="dp-section">
        <div className="dp-section-head"><h3><CloudSun size={14} />当前气象</h3><span>{weather.data?.source ?? "METAR"}</span>
          <button className="link-btn" style={{ marginLeft: "auto" }} onClick={() => weather.refetch()}><RefreshCw size={11} className={weather.isFetching ? "spinning" : ""} />刷新</button>
        </div>
        <div className="dp-card">
          <p className="wx-raw" style={{ marginTop: 0 }}>{weather.data?.raw ?? (weather.isError ? (weather.error as Error).message : "正在获取…")}</p>
          <div className="dp-cols" style={{ marginTop: 10 }}>
            <div><span><Wind size={11} /> 风</span><strong>{metar ? windLabel(metar.wind) : "—"}</strong></div>
            <div><span>能见度</span><strong>{metar?.visibility.label ?? "—"}</strong></div>
            <div><span>云况</span><strong>{metar?.clouds.label ?? "—"}</strong></div>
          </div>
          {weather.data?.taf && <p className="wx-raw" style={{ marginTop: 10 }}>{weather.data.taf}</p>}
        </div>
      </section>

      <section className="dp-section">
        <div className="dp-section-head">
          <h3><MapPin size={14} />停机位</h3>
          <span>{gates.length ? `${gates.length} 个 · XFS${gateGroups.length > 1 ? `（${gateGroups.map((group) => `${group.label} ${group.rows.length}`).join(" / ")}）` : ""}` : "XFS"}</span>
        </div>
        <div className="dp-card">
          {gates.length > 0 ? <>
            {gateGroups.map((group) => <div key={group.key} className="gate-group">
              <div className="gate-group-head"><span>{group.label}</span><small>{group.rows.length}</small></div>
              <div className="gate-chips">
                {group.rows.slice(0, 60).map((gate) => <span
                  key={`${gate.gateRef}-${gate.latitude}-${gate.longitude}`}
                  className={`gate-chip ${group.key === "gate" ? "bridge" : ""}`}
                  title={`${group.label} · ${gate.gateRef} · ${gate.latitude.toFixed(5)}, ${gate.longitude.toFixed(5)}`}
                >{(gate.gateRef || "—").replace(/;/g, " / ")}</span>)}
                {group.rows.length > 60 && <span className="gate-chip muted">+{group.rows.length - 60}</span>}
              </div>
            </div>)}
            <div className="row" style={{ justifyContent: "flex-end", marginTop: 10 }}>
              <button
                className="btn soft sm"
                onClick={() => {
                  setSelectedAirport(icao);
                  // 机位点在「地面」图层里，没开的话地图上是空的，顺手打开。
                  if (!groundLayerOn) toggleLayer("ground");
                  // 地图页挂载后自己飞过去，比在这里直接调地图 ref 稳。
                  if (o?.latitude != null && o?.longitude != null) {
                    sessionStorage.setItem("efb:focus", JSON.stringify({ icao, latitude: o.latitude, longitude: o.longitude }));
                  }
                  navigate("/map");
                }}
              >在地图查看机位</button>
            </div>
          </> : <p className="muted" style={{ fontSize: 11.5 }}>
            {xflyGates.isFetching ? "正在获取停机位…" : xflyGates.isError ? `停机位获取失败：${(xflyGates.error as Error)?.message ?? "未知错误"}` : "XFS 暂无该机场的停机位数据"}
          </p>}
        </div>
      </section>

      <section className="dp-section">
        <div className="dp-section-head">
          <h3>NOTAM</h3>
          <span>{notamRows.length ? `${notamRows.length} 条 · ATIS View` : localNotamRows.length ? `${localNotamRows.length} 条 · 本地导航库` : "0 条"}</span>
        </div>
        <div className="dp-card" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {notamRows.map((item) => <div key={`${item.id}-${item.number}`} className="notam-row">
            <div className="row" style={{ gap: 6, marginBottom: 3, flexWrap: "wrap" }}>
              <span className={`badge ${item.isEffectiveNow ? "green" : item.isCancelled ? "red" : "gray"}`}>{item.number || "NOTAM"}</span>
              {item.kind && item.kind !== "NOTAM" && <span className="badge blue">{item.kind}</span>}
              <small className="muted">
                {shortUtc(item.validFromUtc)} → {item.validUntilUtc ? shortUtc(item.validUntilUtc) : "UFN"}
                {item.isEstimatedEnd ? " (估算)" : ""}
              </small>
              {item.schedule && <span className="badge gray mono">{item.schedule}</span>}
              {notamStateLabel(item) && <span className="badge gray">{notamStateLabel(item)}</span>}
              {item.lowerLimit && item.upperLimit && (item.lowerLimit !== "000" || item.upperLimit !== "999") &&
                <span className="badge gray mono">{item.lowerLimit}–{item.upperLimit}</span>}
            </div>
            <p>{item.text || item.raw}</p>
            <small className="muted mono" style={{ fontSize: 10 }}>
              {[item.fir, item.qCode, item.affectedLocations !== item.location ? `影响 ${item.affectedLocations}` : "", item.source].filter(Boolean).join(" · ")}
            </small>
          </div>)}

          {!notamRows.length && localNotamRows.slice(0, 8).map((item) => <div key={item.id} className="notam-row">
            <div className="row" style={{ gap: 6, marginBottom: 3 }}>
              <span className={`badge ${item.isEffectiveNow ? "green" : "gray"}`}>{item.number}</span>
              <small className="muted">{item.validFromUtc} → {item.validUntilUtc ?? "UFN"}</small>
            </div>
            <p>{item.displayText}</p>
          </div>)}

          {!notamRows.length && !localNotamRows.length && <p className="muted" style={{ fontSize: 11.5 }}>
            {notams.isFetching ? "正在获取 NOTAM…" : notams.isError ? `NOTAM 获取失败：${(notams.error as Error)?.message ?? "未知错误"}` : "该机场暂无有效 NOTAM"}
          </p>}
        </div>
      </section>
    </div>
  </div>;
}

export default AirportsPage;

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";
import { CloudSun, CornerDownLeft, Moon, PanelLeft, Plane, Search, Sun, X } from "lucide-react";
import { loadAdHpAirports } from "../../lib/airport-data";
import { airports as fallbackAirports } from "../../lib/data";
import { getCurrentAiracCycle, isTauri, searchNavigationAirports } from "../../lib/tauri";
import { getRouteCycles, searchAirports } from "../../lib/xfly";
import { useAppStore } from "../../stores/app-store";
import type { Airport } from "../../types";

function Brand() {
  return <div className="brand">
    <span className="brand-mark" aria-hidden>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
        <path d="M17.8 19.2 16 11l3.5-3.5a2.1 2.1 0 0 0-3-3L13 8 4.8 6.2a.5.5 0 0 0-.5.8l4.4 4.4-2 2-2.6-.4-.9.9 3.4 2.3 2.3 3.4.9-.9-.4-2.6 2-2 4.4 4.4a.5.5 0 0 0 .8-.5Z" fill="currentColor" />
      </svg>
    </span>
    <span className="brand-word"><b>SkyBoard</b><span>EFB</span></span>
  </div>;
}

export function TopBar({ title }: { title: string }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const theme = useAppStore((state) => state.theme);
  const setTheme = useAppStore((state) => state.setTheme);
  const toggleRail = useAppStore((state) => state.toggleRail);
  const setSelectedAirport = useAppStore((state) => state.setSelectedAirport);
  const [searchOpen, setSearchOpen] = useState(false);

  const airac = useQuery({ queryKey: ["airac-cycle"], queryFn: getCurrentAiracCycle, staleTime: 60 * 60_000, retry: 0 });
  // 周期号以线上航路库为准，取不到再退回本地导航库。
  const cycles = useQuery({ queryKey: ["route-cycles"], queryFn: getRouteCycles, staleTime: 6 * 60 * 60_000, retry: 0 });
  const cycleLabel = cycles.data?.[0] ?? airac.data?.cycleId ?? "—";

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
      if (event.key === "Escape") setSearchOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return <>
    <header className="topbar">
      <div className="topbar-left">
        <Brand />
        <button className="topbar-toggle" onClick={toggleRail} title="显示 / 隐藏图标栏"><PanelLeft size={16} /></button>
      </div>
      <div className="topbar-title">{title}</div>
      <div className="topbar-right">
        <span className="net-pill" title="AIRAC 周期"><i />{cycleLabel}</span>
        <label className="search-pill" onClick={() => setSearchOpen(true)}>
          <Search size={14} />
          <input readOnly placeholder="搜索航点、航路或机场" aria-label="搜索" />
          <kbd>Ctrl K</kbd>
        </label>
        <button className="icon-btn" onClick={() => setSearchOpen(true)} title="机场检索"><Plane size={16} /></button>
        <button className="icon-btn" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} title={theme === "dark" ? "切换到浅色" : "切换到深色"}>
          {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
        </button>
        <button className={`icon-btn ${pathname === "/weather" ? "active" : ""}`} onClick={() => navigate("/weather")} title="机场气象"><CloudSun size={16} /></button>
      </div>
    </header>
    {searchOpen && <GlobalSearch onClose={() => setSearchOpen(false)} onPick={(airport) => {
      setSearchOpen(false);
      setSelectedAirport(airport.icao);
      if (pathname === "/") {
        window.dispatchEvent(new CustomEvent("efb:focus-airport", { detail: { icao: airport.icao, latitude: airport.latitude, longitude: airport.longitude } }));
      } else {
        navigate(`/airports?icao=${airport.icao}`);
      }
    }} />}
  </>;
}

function GlobalSearch({ onClose, onPick }: { onClose: () => void; onPick: (airport: Airport) => void }) {
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const catalog = useQuery({ queryKey: ["ad-hp-airports"], queryFn: loadAdHpAirports, staleTime: Infinity });
  const navSearch = useQuery({
    queryKey: ["nav-airport-search", query],
    queryFn: () => searchNavigationAirports(query),
    enabled: isTauri() && query.trim().length >= 2,
    retry: 0,
    staleTime: 60_000,
  });
  // XFly 机场库带中文名与 IATA，用来补全 AD_HP 里只有英文名的记录。
  const xflySearch = useQuery({
    queryKey: ["xfly-airport-search", query],
    queryFn: () => searchAirports(query),
    enabled: query.trim().length >= 2,
    retry: 0,
    staleTime: 5 * 60_000,
  });

  useEffect(() => { inputRef.current?.focus(); }, []);

  const pool = useMemo(() => {
    const merged = new Map<string, Airport>();
    for (const airport of [...fallbackAirports, ...(catalog.data ?? [])]) merged.set(airport.icao, airport);
    for (const airport of navSearch.data ?? []) {
      if (!merged.has(airport.icao)) merged.set(airport.icao, { ...airport, runways: [], frequencies: [] });
    }
    for (const row of xflySearch.data ?? []) {
      const icao = (row.gpsCode || row.ident || "").toUpperCase();
      if (!icao) continue;
      const existing = merged.get(icao);
      merged.set(icao, {
        icao,
        iata: row.iataCode ?? existing?.iata ?? "",
        name: row.cnName ?? existing?.name ?? row.enName ?? icao,
        city: row.municipalityCn ?? existing?.city ?? row.municipality ?? "",
        elevation: row.elevationFt != null ? `${row.elevationFt} ft` : existing?.elevation ?? "—",
        international: existing?.international,
        runways: existing?.runways ?? [],
        frequencies: existing?.frequencies ?? [],
        latitude: row.latitudeDeg ?? existing?.latitude ?? 0,
        longitude: row.longitudeDeg ?? existing?.longitude ?? 0,
      });
    }
    return [...merged.values()];
  }, [catalog.data, navSearch.data, xflySearch.data]);

  const results = useMemo(() => {
    const keyword = query.trim().toUpperCase();
    if (!keyword) return pool.filter((airport) => ["ZBAA", "ZSPD", "ZGGG", "ZUUU", "ZSSS", "VHHH"].includes(airport.icao)).slice(0, 6);
    return pool.filter((airport) => `${airport.icao}${airport.iata}${airport.name}${airport.city}`.toUpperCase().includes(keyword)).slice(0, 9);
  }, [pool, query]);

  return <div className="palette-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="palette" role="dialog" aria-label="搜索机场">
      <div className="palette-input">
        <Search size={17} />
        <input
          ref={inputRef}
          value={query}
          placeholder="输入 ICAO、IATA 或机场名称"
          onChange={(event) => { setQuery(event.target.value); setHighlight(0); }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") { event.preventDefault(); setHighlight((index) => Math.min(results.length - 1, index + 1)); }
            if (event.key === "ArrowUp") { event.preventDefault(); setHighlight((index) => Math.max(0, index - 1)); }
            if (event.key === "Enter" && results[highlight]) onPick(results[highlight]);
          }}
        />
        <button className="icon-btn" onClick={onClose} aria-label="关闭"><X size={16} /></button>
      </div>
      <div className="palette-list">
        {results.length === 0 && <p className="empty">没有匹配的机场</p>}
        {results.map((airport, index) => <button
          key={airport.icao}
          className={`palette-item ${index === highlight ? "hl" : ""}`}
          onMouseEnter={() => setHighlight(index)}
          onClick={() => onPick(airport)}
        >
          <span className="code">{airport.icao}</span>
          <span className="grow">
            <strong>{airport.name || airport.icao}</strong>
            <small>{[airport.city, airport.iata].filter(Boolean).join(" · ") || "—"}</small>
          </span>
          {index === highlight && <CornerDownLeft size={14} style={{ color: "var(--muted-2)" }} />}
        </button>)}
      </div>
      <footer className="palette-foot"><span>↑↓ 选择</span><span>Enter 打开</span><span>Esc 关闭</span></footer>
    </section>
  </div>;
}

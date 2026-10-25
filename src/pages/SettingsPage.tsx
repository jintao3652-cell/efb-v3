import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { open } from "@tauri-apps/plugin-dialog";
import { BookOpen, CloudSun, Database, FolderOpen, HardDriveDownload, Info, Monitor, Moon, Plane, Radio, Server, Sun, Trash2 } from "lucide-react";
import { useAppStore, type BaseMap, type ChartSource, type Theme, type TrafficSource } from "../stores/app-store";
import {
  clearCache, getCurrentAiracCycle, getLocalChartLibraryStatus, getNaipStatus, getNavigationDatabaseStatus,
  isTauri, setLocalChartLibrary, setNavigationDatabase,
} from "../lib/tauri";
import { jeppAirportOverview, jeppHealth } from "../lib/jepp";
import { getRouteCycles } from "../lib/xfly";
import { loadOnlineTraffic, trafficSourceLabel } from "../lib/traffic";
import { weatherRegionLabel, weatherSourceOptions, type WeatherRegion } from "../lib/weather";
import { supportsFolderPicker } from "../lib/platform";

/** 浏览器预览读不到本机磁盘：给一句明确解释，别让按钮点了毫无反应。 */
const DESKTOP_ONLY = "浏览器预览读不到本机磁盘。请用 start-test.bat 选「1 桌面端应用」启动，或在安装好的应用里设置。";
/** 移动端没有系统目录选择框，本地航图库 / NAIP 数据包暂不可用。 */
const MOBILE_FOLDER = "移动端暂不支持选择文件夹。本地航图库与 NAIP 数据包请在桌面端配置；移动端请使用 Jeppesen 航图服务与在线数据。";

export function SettingsPage() {
  const theme = useAppStore((state) => state.theme);
  const setTheme = useAppStore((state) => state.setTheme);
  const baseMap = useAppStore((state) => state.baseMap);
  const setBaseMap = useAppStore((state) => state.setBaseMap);
  const trafficSource = useAppStore((state) => state.trafficSource);
  const setTrafficSource = useAppStore((state) => state.setTrafficSource);
  const weatherSourceCn = useAppStore((state) => state.weatherSourceCn);
  const weatherSourceIntl = useAppStore((state) => state.weatherSourceIntl);
  const setWeatherSource = useAppStore((state) => state.setWeatherSource);
  const chartSource = useAppStore((state) => state.chartSource);
  const setChartSource = useAppStore((state) => state.setChartSource);
  const [message, setMessage] = useState("");
  const [probe, setProbe] = useState("");
  const [checks, setChecks] = useState<{ label: string; ok: boolean; detail: string }[]>([]);
  /** 正在打开哪个目录选择框；非空时按钮显示「正在打开…」并禁用，避免连点开出一叠对话框。 */
  const [choosing, setChoosing] = useState<"library" | "database" | null>(null);

  /** 一次探测：/health 报依赖可用性，机场总览顺带拿 AIRAC 周期。地址与令牌来自内置配置。 */
  const runProbe = async () => {
    setProbe("正在连接…");
    setChecks([]);
    try {
      const health = await jeppHealth();
      const labels: Record<string, string> = {
        catalog: "航图目录", tcl_dir: "TCL 图源", renderer: "渲染器 tcl2emf", fonts: "Jeppesen 字体",
        georef: "地理参考", airports: "机场索引", navdata: "J3N 导航库", notams: "NOTAM",
      };
      const count = (value: unknown) => (typeof value === "number" ? value.toLocaleString("en-US") : "—");
      const rows = Object.entries(health.checks).map(([key, check]) => ({
        label: labels[key] ?? key,
        ok: check.ok,
        detail: key === "catalog" ? `${count(check.charts)} 份 · ${count(check.airports)} 机场`
          : key === "tcl_dir" ? `${count(check.files)} 个 TCL`
            : key === "fonts" ? `${count(check.files)} 个字体`
              : key === "navdata" ? `航路点 ${count(check.waypoints)} · 频率 ${count(check.comms)}`
                : check.ok ? "就绪" : "不可用",
      }));
      setChecks(rows);
      let cycle = "";
      try {
        const overview = await jeppAirportOverview("ZBAA");
        if (overview?.cycle) cycle = ` · AIRAC ${overview.cycle.datacycleyear?.slice(-2) ?? ""}${overview.cycle.datacycle}`;
      } catch {
        // 周期只是附加信息，取不到不影响连通性结论
      }
      setProbe(health.ready ? `服务就绪 · 四个必需依赖全部可用${cycle}` : `服务降级：标红的依赖不可用，航图可能无法渲染${cycle}`);
    } catch (error) {
      setProbe(error instanceof Error ? `连接失败：${error.message}` : "连接失败");
    }
  };

  const cycles = useQuery({ queryKey: ["route-cycles"], queryFn: getRouteCycles, staleTime: 6 * 60 * 60_000, retry: 0 });
  // 网络状态跟着「在线交通」走：选 XFS 就看 XFS 在线列表，选 VATSIM 就看 VATSIM 快照。
  // query key 与地图页完全一致，切过去时直接命中同一份缓存，不会重复请求。
  const online = useQuery({
    queryKey: ["online-traffic", trafficSource],
    queryFn: ({ signal }) => loadOnlineTraffic(trafficSource, signal),
    staleTime: 20_000,
    // 开发模式下 StrictMode 会挂载两次，第一次的 signal 被 abort 后
    // 共享的 in-flight 请求会一起失败；给一次重试就不会把状态条停在「离线」。
    retry: 1,
    retryDelay: 900,
    refetchInterval: 30_000,
    networkMode: "always",
  });
  const onlineLabel = trafficSourceLabel(trafficSource);
  // 正在拉取（尤其是 2.8 MB 的 VATSIM 快照）时先别报「离线」，
  // 否则刚打开设置页会看到一闪而过的错误，几秒后自己变回在线。
  const onlineBusy = online.isFetching && !online.data;
  const onlineDown = online.isError && !online.isFetching;

  const database = useQuery({ queryKey: ["navigation-database"], queryFn: getNavigationDatabaseStatus, enabled: isTauri(), retry: 0, staleTime: 60_000 });
  const library = useQuery({ queryKey: ["local-chart-library"], queryFn: getLocalChartLibraryStatus, enabled: isTauri(), retry: 0 });
  const naip = useQuery({ queryKey: ["naip-status"], queryFn: getNaipStatus, enabled: isTauri(), retry: 0, staleTime: 60_000 });
  const airac = useQuery({ queryKey: ["airac-cycle"], queryFn: getCurrentAiracCycle, retry: 0, staleTime: 60 * 60_000 });

  const chooseDatabase = async () => {
    if (!isTauri()) {
      setMessage(DESKTOP_ONLY);
      return;
    }
    if (choosing) return;
    setChoosing("database");
    setMessage("");
    try {
      // 导航库只认 Navigraph DFD v2 的原始数据库文件，所以直接弹文件选择框，
      // 不再让人先选目录、再由后端去猜目录里的哪个文件是数据库。
      const path = await open({
        directory: false,
        multiple: false,
        title: "选择 Navigraph DFD v2 数据库文件",
        defaultPath: database.data?.databasePath || undefined,
        filters: [{ name: "导航数据库", extensions: ["s3db", "db3", "db", "sqlite", "sqlite3"] }],
      });
      // 用户取消时返回 null：保持安静，不要报错。
      if (typeof path !== "string" || !path) return;
      const status = await setNavigationDatabase("dfdv2", path);
      setMessage(status.message);
      await database.refetch();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "设置失败");
    } finally {
      setChoosing(null);
    }
  };

  const chooseLibrary = async () => {
    if (!isTauri()) {
      setMessage(DESKTOP_ONLY);
      return;
    }
    // Android SAF / iOS 文件 App 都没有"选目录给 App 常驻读"的形态，别让按钮弹错框。
    if (!supportsFolderPicker()) {
      setMessage(MOBILE_FOLDER);
      return;
    }
    if (choosing) return;
    setChoosing("library");
    setMessage("");
    try {
      const path = await open({
        directory: true,
        multiple: false,
        title: "选择 NAIP 数据文件夹（包含 Terminal 的那一级）",
        // 已配置过就定位到上次选的目录，省得每次从盘符根目录翻。
        defaultPath: library.data?.path || undefined,
      });
      if (typeof path !== "string" || !path) return;
      const status = await setLocalChartLibrary(path);
      setMessage(status.message);
      await Promise.all([library.refetch(), naip.refetch()]);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "设置失败");
    } finally {
      setChoosing(null);
    }
  };

  return <div className="content">
    <div className="settings-wrap">
      <header>
        <h1>设置</h1>
        <p>外观、导航数据源与本地航图库。所有设置保存在本机。</p>
      </header>

      {message && <div className={`set-msg${message === DESKTOP_ONLY ? " warn" : ""}`}>{message}</div>}

      <section className="set-group">
        <div className="set-head">
          <span className="ico"><Monitor size={16} /></span>
          <div className="grow"><strong>外观</strong><p>浅色对齐 eAIP 阅读风格，深色适合夜间驾驶舱</p></div>
        </div>
        <div className="set-row">
          <div className="grow"><strong>主题</strong><p>深色为同一套设计变量的反色版，地图底图同步切换。</p></div>
          <div className="seg">
            {(["light", "dark"] as Theme[]).map((value) => <button key={value} className={theme === value ? "active" : ""} onClick={() => setTheme(value)}>
              {value === "light" ? <Sun size={13} /> : <Moon size={13} />}{value === "light" ? "浅色" : "深色"}
            </button>)}
          </div>
        </div>
        <div className="set-row">
          <div className="grow"><strong>底图</strong><p>矢量底图为低饱和路网，卫星底图用于目视参考地形。</p></div>
          <div className="seg">
            {(["vector", "satellite"] as BaseMap[]).map((value) => <button key={value} className={baseMap === value ? "active" : ""} onClick={() => setBaseMap(value)}>
              {value === "vector" ? "矢量" : "卫星"}
            </button>)}
          </div>
        </div>
      </section>

      <section className="set-group">
        <div className="set-head">
          <span className="ico"><Server size={16} /></span>
          <div className="grow"><strong>数据服务</strong><p>航图、气象、航路与在线交通的外部接口</p></div>
        </div>
        <div className="set-row">
          <div className="grow"><strong>航图服务（JeppQuery）</strong><p>提供 Jeppesen 航图目录、机场资料与 PDF 渲染。接入参数随版本内置，不在此处配置。</p></div>
          <div className="row" style={{ gap: 8 }}>
            <span className="badge green">已内置</span>
            <button className="btn soft sm" onClick={() => void runProbe()}>测试连接</button>
          </div>
        </div>
        {probe && <p className="set-hint">{probe}</p>}
        {checks.length > 0 && <div className="set-checks">
          {checks.map((row) => <span key={row.label} className={row.ok ? "ok" : "bad"}>
            <i />{row.label}<em>{row.detail}</em>
          </span>)}
        </div>}
        <p className="set-hint">
          航图服务的地址与访问令牌由发布版本固定，界面不显示、也不可修改；服务迁移或令牌轮换会通过升级包下发。
          测试连接会探测目录、图源、渲染器与字体等依赖，仅用于确认当前版本能否正常出图。</p>

        <div className="set-row">
          <div className="grow">
            <strong>航图来源</strong>
            <p>默认使用内置 JeppQuery 服务；本地 Terminal 航图目录配置好后可切换过去，切换结果会在航图库页面沿用。</p>
          </div>
          <div className="seg">
            {(["jepp", "local"] as ChartSource[]).map((value) => <button
              key={value}
              className={chartSource === value ? "active" : ""}
              onClick={() => setChartSource(value)}
              disabled={value === "local" && !library.data?.ready}
              title={value === "local" && !library.data?.ready ? "先在下方选择 NAIP 数据文件夹" : undefined}
            >{value === "jepp" ? "JeppQuery" : "本地 Terminal"}</button>)}
          </div>
        </div>
        <div className="set-row">
          <div className="grow"><strong>在线交通</strong><p>地图上的航班与管制席位来源。XFS 为 XFlySim 网络，VATSIM 为全球网络。</p></div>
          <div className="seg">
            {(["xfs", "vatsim"] as TrafficSource[]).map((value) => <button key={value} className={trafficSource === value ? "active" : ""} onClick={() => setTrafficSource(value)}>
              <Plane size={13} />{value === "xfs" ? "XFS" : "VATSIM"}
            </button>)}
          </div>
        </div>
        <div className="set-row">
          <div className="grow">
            <strong>网络状态</strong>
            <p>{onlineBusy
              ? `${onlineLabel} 正在同步在线列表…`
              : onlineDown
                ? `${onlineLabel} 在线列表暂不可达`
                : `${onlineLabel} 当前 ${online.data?.pilots.length ?? 0} 架航班、${online.data?.controllers.length ?? 0} 个席位在线`}</p>
          </div>
          <span className={`badge ${onlineDown ? "gray" : onlineBusy ? "gray" : "green"}`}>{onlineBusy ? "同步中" : onlineDown ? "离线" : "在线"}</span>
        </div>
        <div className="set-row">
          <div className="grow"><strong>航路数据周期</strong><p>航路检索与反向解析使用的 AIRAC 周期，默认取最新一版。</p></div>
          <span className="tail"><Radio size={11} /> {cycles.data?.[0] ?? "—"}</span>
        </div>
      </section>

      <section className="set-group">
        <div className="set-head">
          <span className="ico"><CloudSun size={16} /></span>
          <div className="grow"><strong>气象数据源</strong><p>中国机场与境外机场分别指定 METAR / TAF 来源</p></div>
        </div>
        {(["cn", "intl"] as WeatherRegion[]).map((region) => <div className="set-row" key={region}>
          <div className="grow">
            <strong>{weatherRegionLabel(region)}</strong>
            <p>{region === "cn"
              ? "ICAO 以 Z / V / RC 开头（含中国香港、中国澳门、中国台湾）的机场"
              : "其余国家与地区的机场"}</p>
          </div>
          <div className="seg wrap">
            {weatherSourceOptions().map((option) => <button
              key={option.id}
              className={(region === "cn" ? weatherSourceCn : weatherSourceIntl) === option.id ? "active" : ""}
              onClick={() => setWeatherSource(region, option.id)}
              title={option.detail}
            >{option.short}</button>)}
          </div>
        </div>)}
        <p className="set-hint">
          自动：中国机场优先 <code>ruri</code>，境外机场优先 <code>xflysim</code>，首选源 5 秒内未返回即换源。
          <code>ruri</code>（naip.ruri8557.top）报文带中文解读，服务端回源较慢（约 2–10 秒）；
          <code>vataim</code> 是 VATSIM 公开 METAR，只有 METAR 没有 TAF；<code>faa</code> 取
          <code>aviationweather.gov</code> 的 METAR + TAF；<code>caac</code> 走本机后端（中国气象局 → faa → OpenWeather），仅在桌面端可选。所有回退都会在气象页标注原因。
        </p>
      </section>

      <section className="set-group">
        <div className="set-head">
          <span className="ico"><Database size={16} /></span>
          <div className="grow"><strong>导航数据库</strong><p>航路、航路点、SID / STAR / 进近程序来源</p></div>
          {/* 优先显示数据库自带的周期：DFD v2 取自 tbl_hdr_header.cycle，LNM 取自 metadata。 */}
          <span className="tail">{database.data?.airacCycle
            ? `AIRAC ${database.data.airacCycle}`
            : airac.data?.cycleId ? `AIRAC ${airac.data.cycleId}` : "—"}</span>
        </div>
        <div className="set-row">
          <div className="grow"><strong>当前状态</strong><p>{database.data?.message ?? (isTauri() ? "正在检测…" : "浏览器预览模式不支持本地数据库")}</p></div>
          <span className={`badge ${database.data?.ready ? "green" : "gray"}`}>{database.data?.ready ? "已连接" : "未连接"}</span>
        </div>
        <div className="db-choice">
          <button className={database.data?.ready && database.data?.source === "dfdv2" ? "active" : ""} onClick={() => void chooseDatabase()} disabled={choosing !== null}>
            <FolderOpen size={15} />
            <span className="grow">
              <strong>Navigraph DFD v2</strong>
              <span>{choosing === "database" ? "正在打开文件管理器…" : "直接选择 .s3db / .db3 / .sqlite 数据库文件"}</span>
            </span>
          </button>
        </div>
        {database.data?.databasePath && <p className="set-hint mono-path" title={database.data.databasePath}>{database.data.databasePath}</p>}
        <p className="set-hint">
          只支持 Navigraph DFD v2 的原始数据库（表名以 <code>tbl_</code> 开头，如 <code>tbl_pa_airports</code> /
          <code>tbl_er_enroute_airways</code>）。选文件而不是目录，程序会当场校验表结构，格式不符直接报错。
        </p>
      </section>

      <section className="set-group">
        <div className="set-head">
          <span className="ico"><BookOpen size={16} /></span>
          <div className="grow"><strong>本地航图（NAIP 数据包）</strong><p>选择 NAIP 数据文件夹，航图、机场中文名与班机航路一并接管</p></div>
          <span className="tail">{library.data?.ready ? `${library.data.airportCount} 机场 · ${library.data.chartCount} 份` : isTauri() ? "未设置" : "仅桌面端"}</span>
        </div>
        <div className="set-row">
          <div className="grow">
            <strong>{library.data?.ready ? "已就绪" : "未配置"}</strong>
            <p>{library.data?.message ?? "未选择文件夹。选中 NAIP 数据文件夹后，会读取 AD_HP.csv 的机场中文名与 FLIGHT_AIRLINE.csv 的班机航路。"}</p>
          </div>
          <button className="btn soft" onClick={() => void chooseLibrary()} disabled={choosing !== null}>
            <FolderOpen size={14} />{choosing === "library" ? "正在打开…" : "选择 NAIP 数据文件夹"}
          </button>
        </div>
        {isTauri() && <div className="set-checks" style={{ paddingTop: 0 }}>
          <span className={naip.data?.airportCount ? "ok" : "bad"} title={naip.data?.airportMessage}><i />机场库<em>{naip.data?.airportCount ? `${naip.data.airportCount} 座 · 中文名` : naip.data?.airportMessage ?? "未读取"}</em></span>
          <span className={naip.data?.routeCount ? "ok" : "bad"} title={naip.data?.routeMessage}><i />班机航路<em>{naip.data?.routeCount ? `${naip.data.routeCount.toLocaleString("en-US")} 条` : naip.data?.routeMessage ?? "未读取"}</em></span>
          <span className={naip.data?.pointFile ? "ok" : "bad"}><i />航段表<em>{naip.data?.pointFile ? "已找到，航路按航段拼接" : "缺 FLIGHT_AIRLINE_POINT.csv"}</em></span>
        </div>}
        {!isTauri() && <p className="set-hint">浏览器预览读不到本机磁盘，这条按钮点了不会有文件管理器；请用桌面端应用设置。</p>}
        {library.data?.path && <p className="set-hint mono-path" title={library.data.path}>{library.data.path}</p>}
        <p className="set-hint">
          数据包结构：<code>AD_HP.csv</code>（机场名）、<code>FLIGHT_AIRLINE.csv</code>（班机航路）、
          <code>Terminal/&lt;ICAO&gt;/*.pdf</code>（航图，同目录 <code>Charts.csv</code> 提供
          <code>ChartName</code>、<code>ChartTypeEx_CH</code>、<code>PAGE_NUMBER</code>）。
          所以要选中<strong>包含 Terminal 的那一级文件夹</strong>（即 NAIP 数据文件夹本身），不要进到 Terminal 里面。
          本地数据只在桌面端可用，浏览器预览会回落到 JeppQuery。
        </p>
      </section>

      <section className="set-group">
        <div className="set-head">
          <span className="ico"><HardDriveDownload size={16} /></span>
          <div className="grow"><strong>缓存</strong><p>航图、气象与边界数据缓存</p></div>
        </div>
        <div className="set-row">
          <div className="grow"><strong>清理缓存</strong><p>删除已缓存的航图缩略图与网络数据，不会影响飞行计划。</p></div>
          <button className="btn soft" onClick={async () => { try { await clearCache(); setMessage("缓存已清理"); } catch (error) { setMessage(error instanceof Error ? error.message : "清理失败"); } }} disabled={!isTauri()}>
            <Trash2 size={14} />清理
          </button>
        </div>
      </section>

      <section className="set-group">
        <div className="set-head">
          <span className="ico"><Info size={16} /></span>
          <div className="grow"><strong>关于</strong><p>SkyBoard EFB · 本地优先的电子飞行包</p></div>
        </div>
        <div className="set-row">
          <div className="grow"><strong>版本</strong><p>Tauri 2 · React 19 · MapLibre，航图与导航数据版权归各数据源所有。</p></div>
          <span className="tail">{airac.data?.cycleStartDate ? `生效 ${airac.data?.cycleStartDate}` : "—"}</span>
        </div>
      </section>
    </div>
  </div>;
}

export default SettingsPage;

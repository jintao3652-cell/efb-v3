import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { WeatherRegion, WeatherSourcePreference } from "../lib/weather";

export type Theme = "light" | "dark";
export type BaseMap = "vector" | "satellite";
/** 在线交通数据源：XFS（XFlySim 自有网络）或 VATSIM。 */
export type TrafficSource = "xfs" | "vatsim";

/** 航图来源：内置 JeppQuery 服务，或设置里指定的本地 Terminal 航图目录。 */
export type ChartSource = "jepp" | "local";

export type MapLayerKey =
  | "airways"
  | "waypoints"
  | "airports"
  | "airspace"
  | "onlineControl"
  | "traffic"
  | "ground"
  | "route"
  | "chart"
  | "weather";

export const mapLayerLabels: Record<MapLayerKey, string> = {
  airways: "航路 · 航路点",
  waypoints: "终端航路点",
  airports: "机场",
  airspace: "空域 / FIR 边界",
  onlineControl: "在线管制扇区",
  traffic: "在线实时交通",
  ground: "机场地面 / 机位",
  route: "飞行计划航路",
  chart: "航图叠加",
  weather: "天气雷达",
};

export const trafficSourceLabels: Record<TrafficSource, string> = {
  xfs: "XFS 网络",
  vatsim: "VATSIM",
};

export interface ProcedureSelection {
  /** 导航数据库中的程序主键 */
  id: number;
  icao: string;
  kind: "SID" | "STAR" | "APP";
  name: string;
  runway: string;
  transition: string;
}

export interface SelectedPoint {
  type: "airport" | "waypoint" | "navaid";
  ident: string;
  name: string;
  latitude: number;
  longitude: number;
  detail?: string;
  /** 在线航班才有：机组 CID，用于查历史轨迹（vataware / XFS）。 */
  cid?: number;
}

/** 叠在地图上的终端航图（只有带地理配准的 Jepp 航图能叠）。 */
export interface ChartOverlaySelection {
  icao: string;
  /** DBF 文件名（不透明哈希），不是图号 */
  filename: string;
  /** 图号，如 `10-9` */
  indexNo: string;
  /** 图名 / 程序名，面板上显示用 */
  title: string;
  /** 0.15–1 */
  opacity: number;
  /** transparent：去掉纸面白底；opaque：保留纸张 */
  paper: "transparent" | "opaque";
}

export type ChartOverlayStatus = "idle" | "loading" | "ready" | "error";

interface AppState {
  theme: Theme;
  baseMap: BaseMap;
  railHidden: boolean;
  layers: Record<MapLayerKey, boolean>;
  selectedAirport: string | null;
  selectedPoint: SelectedPoint | null;
  procedure: ProcedureSelection | null;
  /** 机场地面图模式：进入后地图锁定机场范围并高亮停机位 */
  groundMode: boolean;
  /** 在线交通数据源 */
  trafficSource: TrafficSource;
  /** 航图来源，默认走内置 JeppQuery */
  chartSource: ChartSource;
  /** 中国境内机场的气象数据源偏好 */
  weatherSourceCn: WeatherSourcePreference;
  /** 境外机场的气象数据源偏好 */
  weatherSourceIntl: WeatherSourcePreference;
  /** 航路数据周期，空串表示用接口返回的最新周期 */
  navCycle: string;
  /** 当前叠在地图上的航图，null 表示没有 */
  chartOverlay: ChartOverlaySelection | null;
  chartOverlayStatus: ChartOverlayStatus;
  chartOverlayError: string;
  setTheme: (theme: Theme) => void;
  setBaseMap: (baseMap: BaseMap) => void;
  toggleRail: () => void;
  toggleLayer: (key: MapLayerKey) => void;
  setSelectedAirport: (icao: string | null) => void;
  setSelectedPoint: (point: SelectedPoint | null) => void;
  setProcedure: (procedure: ProcedureSelection | null) => void;
  setGroundMode: (on: boolean) => void;
  setTrafficSource: (source: TrafficSource) => void;
  setChartSource: (source: ChartSource) => void;
  setWeatherSource: (region: WeatherRegion, source: WeatherSourcePreference) => void;
  setNavCycle: (cycle: string) => void;
  setChartOverlay: (selection: ChartOverlaySelection | null) => void;
  patchChartOverlay: (patch: Partial<ChartOverlaySelection>) => void;
  setChartOverlayStatus: (status: ChartOverlayStatus, error?: string) => void;
}

const defaultLayers: Record<MapLayerKey, boolean> = {
  airways: true,
  // 终端航路点默认打开：这是导航数据的核心图层，老版本默认 false 导致用户以为没加载
  waypoints: true,
  airports: true,
  airspace: false,
  onlineControl: true,
  traffic: true,
  ground: false,
  route: true,
  chart: true,
  weather: false,
};

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      theme: "light",
      baseMap: "vector",
      railHidden: false,
      layers: defaultLayers,
      selectedAirport: null,
      selectedPoint: null,
      procedure: null,
      groundMode: false,
      trafficSource: "xfs",
      chartSource: "jepp",
      weatherSourceCn: "auto",
      weatherSourceIntl: "auto",
      navCycle: "",
      chartOverlay: null,
      chartOverlayStatus: "idle",
      chartOverlayError: "",
      setTheme: (theme) => set({ theme }),
      setBaseMap: (baseMap) => set({ baseMap }),
      toggleRail: () => set((state) => ({ railHidden: !state.railHidden })),
      toggleLayer: (key) => set((state) => ({ layers: { ...state.layers, [key]: !state.layers[key] } })),
      setSelectedAirport: (selectedAirport) => set({ selectedAirport }),
      setSelectedPoint: (selectedPoint) => set({ selectedPoint }),
      setProcedure: (procedure) => set({ procedure }),
      setGroundMode: (groundMode) => set({ groundMode }),
      setTrafficSource: (trafficSource) => set({ trafficSource }),
      setChartSource: (chartSource) => set({ chartSource }),
      setWeatherSource: (region, source) => set(region === "cn" ? { weatherSourceCn: source } : { weatherSourceIntl: source }),
      setNavCycle: (navCycle) => set({ navCycle }),
      setChartOverlay: (chartOverlay) => set((state) => ({
        chartOverlay,
        chartOverlayStatus: chartOverlay ? "loading" : "idle",
        chartOverlayError: "",
        // 选了图就把「航图叠加」图层打开，否则用户会以为没生效。
        layers: chartOverlay ? { ...state.layers, chart: true } : state.layers,
      })),
      patchChartOverlay: (patch) => set((state) => (state.chartOverlay ? { chartOverlay: { ...state.chartOverlay, ...patch } } : {})),
      setChartOverlayStatus: (chartOverlayStatus, error) => set({ chartOverlayStatus, chartOverlayError: error ?? "" }),
    }),
    {
      name: "skyboard-efb-preferences",
      // v1：终端航路点图层默认从 false 改为 true；旧偏好（无版本号 = v0）
      // 在 migrate 里一次性升级，之后用户手动关闭会正常保留。
      version: 1,
      migrate: (persisted) => {
        const saved = (persisted ?? {}) as Partial<AppState>;
        const layers = { ...defaultLayers, ...(saved.layers ?? {}) };
        layers.waypoints = true;
        return {
          theme: saved.theme ?? "light",
          baseMap: saved.baseMap ?? "vector",
          layers,
          railHidden: saved.railHidden ?? false,
          trafficSource: saved.trafficSource ?? "xfs",
          chartSource: saved.chartSource ?? "jepp",
          weatherSourceCn: saved.weatherSourceCn ?? "auto",
          weatherSourceIntl: saved.weatherSourceIntl ?? "auto",
          navCycle: saved.navCycle ?? "",
        };
      },
      partialize: (state) => ({
        theme: state.theme,
        baseMap: state.baseMap,
        layers: state.layers,
        railHidden: state.railHidden,
        trafficSource: state.trafficSource,
        chartSource: state.chartSource,
        weatherSourceCn: state.weatherSourceCn,
        weatherSourceIntl: state.weatherSourceIntl,
        navCycle: state.navCycle,
      }),
      merge: (persisted, current) => {
        const saved = { ...(persisted ?? {}) } as Record<string, unknown>;
        // 旧版本曾把航图服务地址 / token 存进偏好，现已内置到发布包，读到就丢掉。
        delete saved.jeppBaseUrl;
        delete saved.jeppToken;
        // 旧版的「公开源」拆成了 vataim（METAR）/ faa（METAR+TAF），默认落到 faa。
        if (saved.weatherSourceCn === "public") saved.weatherSourceCn = "faa";
        if (saved.weatherSourceIntl === "public") saved.weatherSourceIntl = "faa";
        return { ...current, ...(saved as Partial<AppState>), layers: { ...current.layers, ...((saved.layers as AppState["layers"]) ?? {}) } };
      },
    },
  ),
);

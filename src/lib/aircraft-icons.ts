import type { Map as MapLibreMap } from "maplibre-gl";

// 机型 SVG 图标库（src/ACF-ICONS/<ICAO 机型小写>.svg，机头朝上=北）。
// eager glob 拿到的是 Vite 资产 URL（哈希文件名），SVG 内容不进 JS 包；
// 按需光栅化后 addImage，未加载到的 icon-image 引用只是暂不渲染，加载完 MapLibre 会自动重绘。
const modules = import.meta.glob("../ACF-ICONS/*.svg", { import: "default", eager: true }) as Record<string, string>;
const iconUrls = new Map<string, string>();
for (const [path, url] of Object.entries(modules)) {
  const type = path.replaceAll("\\", "/").split("/").pop()?.replace(/\.svg$/i, "").toLowerCase();
  if (type) iconUrls.set(type, url);
}

// 常见 ICAO 机型代码在图标库里的近似对应（库按具体型号命名，缺 neo/衍生型号时用同族外形兜底）。
const typeAliases: Record<string, string> = {
  a21n: "a321",   // A321neo → A321
  e75l: "e75s",   // E175LL → E175
  p28r: "p28x", p28a: "p28x", // PA-28R/A → PA-28
  be30: "b350",   // King Air 300 → King Air 350
  at45: "at7x", at72: "at7x", at75: "at7x", atr: "at7x", // ATR 42/72 家族
};

export const fallbackAircraftIconId = "acf-fallback";

// 机型在图标库里查不到时的通用客机顶视兜底（机头同样朝上，白填充黑描边与整套图标风格一致）。
const fallbackAircraftSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64"><path d="M32 3c1.9 0 3.2 2.1 3.4 4.6l.9 13.9 17.4 9.6c.8.5 1.3 1.3 1.3 2.2v3.4c0 1-1 1.7-1.9 1.4L36.9 32l-.8 12.6 5.6 4.3c.5.4.8 1 .8 1.6v3c0 .9-.9 1.5-1.7 1.2L32 51l-8.8 3.7c-.8.3-1.7-.3-1.7-1.2v-3c0-.6.3-1.2.8-1.6l5.6-4.3-.8-12.6-16.2 6.1c-.9.3-1.9-.4-1.9-1.4v-3.4c0-.9.5-1.7 1.3-2.2l17.4-9.6.9-13.9C28.8 5.1 30.1 3 32 3z" fill="#ffffff" stroke="#0a0f14" stroke-width="2"/></svg>`;

// VATSIM 的 aircraft_short（B738/A20N/BCS3…）小写后正好是图标文件名；先查原名，再查同族别名，查不到走兜底。
export function aircraftIconId(aircraftType?: string | null) {
  const type = (aircraftType ?? "").trim().toLowerCase();
  const resolved = type && (iconUrls.has(type) ? type : typeAliases[type]);
  return resolved ? `acf-${resolved}` : fallbackAircraftIconId;
}

// 光栅化成 ImageData：图标 SVG 宽高比差异极大（客机 351×404、滑翔机 155×69），
// 直接塞进固定正方形画布会拉变形，按固有宽高比缩放到 maxEdge 内。
async function rasterizeAircraftSvg(source: string, maxEdge: number): Promise<ImageData> {
  const widthMatch = /<svg[^>]*\bwidth\s*=\s*"([\d.]+)/i.exec(source);
  const heightMatch = /<svg[^>]*\bheight\s*=\s*"([\d.]+)/i.exec(source);
  const viewMatch = /viewBox\s*=\s*"[^\s"]+\s+[^\s"]+\s+([\d.]+)\s+([\d.]+)"/i.exec(source);
  let width = widthMatch ? Number(widthMatch[1]) : 0;
  let height = heightMatch ? Number(heightMatch[1]) : 0;
  if (!width || !height) {
    width = width || Number(viewMatch?.[1] ?? maxEdge);
    height = height || Number(viewMatch?.[2] ?? maxEdge);
  }
  const scale = maxEdge / Math.max(width, height);
  const canvasWidth = Math.max(2, Math.round(width * scale));
  const canvasHeight = Math.max(2, Math.round(height * scale));
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error("机型 SVG 加载失败"));
    element.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
  });
  const canvas = document.createElement("canvas");
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas 2d 不可用");
  context.drawImage(image, 0, 0, canvasWidth, canvasHeight);
  return context.getImageData(0, 0, canvasWidth, canvasHeight);
}

const rasterCache = new Map<string, ImageData>();
const pendingJobs = new Map<string, Promise<void>>();

// 确保这些机型图标已注册进地图（重复调用按 map.hasImage / 任务去重）。
// pixelRatio 2：64px 光栅 → 32 逻辑 px，高清屏不糊。
export function ensureAircraftIcons(map: MapLibreMap, aircraftTypes: Iterable<string | null | undefined>, maxEdge = 64): Promise<void[]> {
  const wanted = new Set<string>([fallbackAircraftIconId]);
  for (const type of aircraftTypes) wanted.add(aircraftIconId(type));
  const jobs: Array<Promise<void>> = [];
  for (const id of wanted) {
    if (map.hasImage(id)) continue;
    let job = pendingJobs.get(id);
    if (!job) {
      job = (async () => {
        let imageData = rasterCache.get(id);
        if (!imageData) {
          const source = id === fallbackAircraftIconId ? fallbackAircraftSvg : await (await fetch(iconUrls.get(id.slice("acf-".length))!)).text();
          imageData = await rasterizeAircraftSvg(source, maxEdge);
          rasterCache.set(id, imageData);
        }
        if (!map.hasImage(id)) map.addImage(id, imageData, { pixelRatio: 2 });
      })();
      pendingJobs.set(id, job);
      void job.catch(() => {}).finally(() => { if (pendingJobs.get(id) === job) pendingJobs.delete(id); });
    }
    jobs.push(job);
  }
  return Promise.all(jobs);
}

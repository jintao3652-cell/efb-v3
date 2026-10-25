import type { Map as MapLibreMap } from "maplibre-gl";

/**
 * 在线交通的飞机标记。
 *
 * 形状取自 `static/aircraft/a320.svg`（发布包里的机型剪影），颜色只有两种：
 * 默认蓝色、被选中时琥珀色——地图上不需要按机型区分，颜色才是状态信号。
 * SVG 是白色填充的，光栅化前把 `fill="white"` 换成目标色即可，黑色描边保留。
 */

export const TRAFFIC_PLANE_ICON = "traffic-plane";
export const TRAFFIC_PLANE_ACTIVE_ICON = "traffic-plane-active";

/** 默认蓝（浅色底图和深色底图都能看清）与选中琥珀。 */
const PLANE_BLUE = "#2b8ce6";
const PLANE_AMBER = "#ffa940";

/** 取不到 static 资源时的兜底轮廓：机头朝上的客机顶视，64×64。 */
const FALLBACK_PLANE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64"><path d="M32 3c1.9 0 3.2 2.1 3.4 4.6l.9 13.9 17.4 9.6c.8.5 1.3 1.3 1.3 2.2v3.4c0 1-1 1.7-1.9 1.4L36.9 32l-.8 12.6 5.6 4.3c.5.4.8 1 .8 1.6v3c0 .9-.9 1.5-1.7 1.2L32 51l-8.8 3.7c-.8.3-1.7-.3-1.7-1.2v-3c0-.6.3-1.2.8-1.6l5.6-4.3-.8-12.6-16.2 6.1c-.9.3-1.9-.4-1.9-1.4v-3.4c0-.9.5-1.7 1.3-2.2l17.4-9.6.9-13.9C28.8 5.1 30.1 3 32 3z" fill="white" stroke="#0a0f14" stroke-width="2"/></svg>`;

let planeSource: string | null = null;

function tint(source: string, color: string) {
  return source
    .replace(/fill="white"/gi, `fill="${color}"`)
    .replace(/fill="#fff(?:fff)?"/gi, `fill="${color}"`);
}

async function loadPlaneSource(): Promise<string> {
  if (planeSource) return planeSource;
  try {
    // 走 Vite 的静态资源 URL：dev 由服务器给，构建后是带哈希的文件。
    const url = new URL("../../static/aircraft/a320.svg", import.meta.url).href;
    const response = await fetch(url);
    if (response.ok) planeSource = await response.text();
  } catch {
    // 资源缺失不致命，用内置轮廓
  }
  return planeSource ?? FALLBACK_PLANE_SVG;
}

async function rasterize(source: string, maxEdge: number): Promise<ImageData> {
  const widthMatch = /<svg[^>]*\bwidth\s*=\s*"([\d.]+)/i.exec(source);
  const heightMatch = /<svg[^>]*\bheight\s*=\s*"([\d.]+)/i.exec(source);
  const viewMatch = /viewBox\s*=\s*"[^\s"]+\s+[^\s"]+\s+([\d.]+)\s+([\d.]+)"/i.exec(source);
  let width = Number(widthMatch?.[1] ?? 0);
  let height = Number(heightMatch?.[1] ?? 0);
  if (!width || !height) {
    width = width || Number(viewMatch?.[1] ?? maxEdge);
    height = height || Number(viewMatch?.[2] ?? maxEdge);
  }
  const scale = maxEdge / Math.max(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(2, Math.round(width * scale));
  canvas.height = Math.max(2, Math.round(height * scale));
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error("飞机图标加载失败"));
    element.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
  });
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas 2d 不可用");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

let pending: Promise<void> | null = null;

/** 注册两种颜色的飞机图标；重复调用是幂等的。 */
export function ensureTrafficPlaneIcons(map: MapLibreMap): Promise<void> {
  if (map.hasImage(TRAFFIC_PLANE_ICON) && map.hasImage(TRAFFIC_PLANE_ACTIVE_ICON)) return Promise.resolve();
  if (pending) return pending;
  pending = (async () => {
    const source = await loadPlaneSource();
    for (const [id, color] of [[TRAFFIC_PLANE_ICON, PLANE_BLUE], [TRAFFIC_PLANE_ACTIVE_ICON, PLANE_AMBER]] as const) {
      if (map.hasImage(id)) continue;
      const data = await rasterize(tint(source, color), 72);
      // pixelRatio 2：72px 光栅 → 36 逻辑 px，高清屏不糊。
      map.addImage(id, data, { pixelRatio: 2 });
    }
  })().finally(() => { pending = null; });
  return pending;
}

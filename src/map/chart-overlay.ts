/**
 * 把 Jepp 终端航图渲染成栅格并叠到 MapLibre 上。
 *
 * 链路：`geo/bounds` 拿像素矩形 + 经纬度范围 → `chartQuad()` 算四角 →
 * 取 PDF 用 pdf.js 画到画布 → 按需把白纸底去掉（暗色主题反转油墨）→
 * 异步编码成 blob URL 塞进 `image` source，四个角就是刚才算出来的经纬度。
 *
 * 加载/渲染提速的三板斧：
 *  1. 渐进渲染：先出半分辨率预览贴上地图，再在后台出全分辨率替换；
 *  2. pdf.js 文档 LRU（3 份）：来回切图不重复解析同一份 PDF；
 *  3. 成品栅格 LRU（4 张）：切换「去底/反色」或切回看过的图直接命中缓存。
 *
 * 航图 PDF 是 A4 版面，但服务端的地理配准是在航图原始出图尺寸上做的，
 * 两个坐标系只有「整页 ↔ 整页」的对应关系，所以四角直接由 page_pixels 外推。
 */
import { pdfjs } from "react-pdf";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { ImageSource, Map as MapLibreMap } from "maplibre-gl";
import { jeppChartFile, releaseChartFile } from "../lib/jepp";
import type { ChartQuad, LngLat } from "../lib/chart-geo";

pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();

/** 叠加层的 source / layer id，和 overlays.ts 的图层分组对得上。 */
export const CHART_SOURCE = "ov-chart-src";
export const CHART_LAYER = "ov-chart";

/** 全分辨率渲染的长边上限：再大也看不出差别，只会多占几十兆内存。 */
const MAX_EDGE = 2400;
/** 同时缓存的 pdf.js 文档数（解析一份 PDF 要几百毫秒，值得留）。 */
const DOC_CACHE_CAP = 3;
/** 成品栅格缓存张数（每张是几 MB 的 blob，4 张够来回切图用）。 */
const RASTER_CACHE_CAP = 4;

export interface ChartRenderOptions {
  /** transparent：去掉纸面白底，只留油墨；opaque：保留纸张原样 */
  paper: "transparent" | "opaque";
  /** 暗色主题下把油墨反成浅色，否则黑线压在深色底图上等于没画 */
  invert: boolean;
}

export interface ChartRaster {
  /** blob:image/png，MapLibre image source 直接吃 */
  url: string;
  coordinates: ChartQuad["coordinates"];
  width: number;
  height: number;
  southwest: LngLat;
  northeast: LngLat;
}

/* ───────────────────────── 像素处理 ───────────────────────── */

/**
 * 亮度 → 不透明度查找表。白纸（亮度 ≥ 249）→ 全透明，
 * gamma 0.75 把浅灰底纹（水系、地形）抬起来，不至于一去掉就没了。
 * 用整数近似 0.299/0.587/0.114 的亮度系数，整条循环快一倍多。
 */
const INK_ALPHA = (() => {
  const table = new Uint8ClampedArray(256);
  for (let level = 0; level < 256; level++) {
    table[level] = level >= 249
      ? 0
      : Math.min(255, Math.round(255 * (1 - level / 255) ** 0.75 * 1.06));
  }
  return table;
})();

/**
 * 去底：亮度当不透明度。白纸 → 全透明，黑线 → 不透明。
 */
function paintInk(context: CanvasRenderingContext2D, width: number, height: number, invert: boolean) {
  const image = context.getImageData(0, 0, width, height);
  const data = image.data;
  for (let index = 0; index < data.length; index += 4) {
    const luminance = (data[index] * 77 + data[index + 1] * 150 + data[index + 2] * 29) >> 8;
    data[index + 3] = INK_ALPHA[luminance];
    if (luminance < 249 && invert) {
      data[index] = 255 - data[index];
      data[index + 1] = 255 - data[index + 1];
      data[index + 2] = 255 - data[index + 2];
    }
  }
  context.putImageData(image, 0, 0);
}

/** 保留纸张但整体反色（暗色主题下的「夜航图」版式）。 */
function invertCanvas(context: CanvasRenderingContext2D, width: number, height: number) {
  const image = context.getImageData(0, 0, width, height);
  const data = image.data;
  for (let index = 0; index < data.length; index += 4) {
    data[index] = 255 - data[index];
    data[index + 1] = 255 - data[index + 1];
    data[index + 2] = 255 - data[index + 2];
  }
  context.putImageData(image, 0, 0);
}

/**
 * 异步编码画布。`toDataURL` 在主线程同步编 PNG，两千多像素宽的图能卡死半秒；
 * `toBlob` 把编码挪出主线程，再配 object URL，内存也比 base64 字符串省三成。
 */
function canvasToUrl(canvas: HTMLCanvasElement): Promise<string> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(URL.createObjectURL(blob)) : reject(new Error("航图 PNG 编码失败"))),
      "image/png",
    );
  });
}

/* ───────────────────────── pdf.js 文档缓存 ───────────────────────── */

const docCache = new Map<string, Promise<PDFDocumentProxy>>();

/** LRU 取文档；解析失败的不缓存，腾位置时销毁最旧的。 */
function getPdfDoc(url: string): Promise<PDFDocumentProxy> {
  const pending = docCache.get(url);
  if (pending) {
    docCache.delete(url);
    docCache.set(url, pending);
    return pending;
  }
  const task = pdfjs.getDocument({ url }).promise;
  docCache.set(url, task);
  void task.catch(() => {
    if (docCache.get(url) === task) docCache.delete(url);
  });
  if (docCache.size > DOC_CACHE_CAP) {
    const oldest = docCache.keys().next().value as string | undefined;
    if (oldest && oldest !== url) {
      const evicted = docCache.get(oldest);
      docCache.delete(oldest);
      void evicted?.then((doc) => doc.destroy()).catch(() => undefined);
    }
  }
  return task;
}

/**
 * pdf.js 不允许同一页并发 render。快速切图时上一个全分辨率渲染可能还在跑，
 * 每份文档排一条队列串行执行，避免「Cannot use the same canvas」式报错。
 */
const docQueues = new WeakMap<PDFDocumentProxy, Promise<unknown>>();

function withDocLock<T>(doc: PDFDocumentProxy, task: () => Promise<T>): Promise<T> {
  const previous = docQueues.get(doc) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  docQueues.set(doc, next);
  return next;
}

/* ───────────────────────── 成品栅格缓存 ───────────────────────── */

const rasterCache = new Map<string, ChartRaster>();

/** 命中即刷新 LRU 顺序。 */
export function peekChartRaster(key: string): ChartRaster | undefined {
  const raster = rasterCache.get(key);
  if (raster) {
    rasterCache.delete(key);
    rasterCache.set(key, raster);
  }
  return raster;
}

export function rememberChartRaster(key: string, raster: ChartRaster) {
  rasterCache.delete(key);
  rasterCache.set(key, raster);
  if (rasterCache.size <= RASTER_CACHE_CAP) return;
  const oldest = rasterCache.keys().next().value as string | undefined;
  if (oldest === undefined) return;
  const evicted = rasterCache.get(oldest);
  rasterCache.delete(oldest);
  // 延迟回收：MapLibre 可能刚拿到这个 URL 还没把图取完。
  if (evicted?.url.startsWith("blob:")) {
    setTimeout(() => URL.revokeObjectURL(evicted.url), 60_000);
  }
}

export function clearChartRasterCache() {
  for (const raster of rasterCache.values()) {
    if (raster.url.startsWith("blob:")) URL.revokeObjectURL(raster.url);
  }
  rasterCache.clear();
}

/* ───────────────────────── 渲染 ───────────────────────── */

/** 画一版：page → 画布（缩放）→ 去底/反色 → blob URL。 */
async function paintPage(doc: PDFDocumentProxy, quad: ChartQuad, options: ChartRenderOptions, maxEdge: number): Promise<ChartRaster> {
  return withDocLock(doc, async () => {
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(3, maxEdge / Math.max(base.width, base.height));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("无法创建画布上下文");
    // pdfjs 5 的 render 参数里 canvas 与 canvasContext 都要给，类型声明比实际更松。
    await page.render({ canvasContext: context, canvas, viewport } as never).promise;
    if (options.paper === "transparent") paintInk(context, canvas.width, canvas.height, options.invert);
    else if (options.invert) invertCanvas(context, canvas.width, canvas.height);
    const url = await canvasToUrl(canvas);
    const width = canvas.width;
    const height = canvas.height;
    canvas.width = 0;
    canvas.height = 0;
    return {
      url,
      coordinates: quad.coordinates,
      width,
      height,
      southwest: quad.southwest,
      northeast: quad.northeast,
    };
  });
}

/**
 * 画第一页 → 去底 / 反色 → PNG。
 *
 * 传了 `onPreview` 就先出一版半分辨率的预览（像素量只有全图 1/4，
 * 一般一两百毫秒就能贴上地图），全分辨率在后台接着画。全图完成前
 * 预览回调先行生效，用户几乎感觉不到等待。
 */
export async function renderChartRaster(
  pdfUrl: string,
  quad: ChartQuad,
  options: ChartRenderOptions,
  onPreview?: (preview: ChartRaster) => void,
): Promise<ChartRaster> {
  const doc = await getPdfDoc(pdfUrl);
  const page = await doc.getPage(1);
  const base = page.getViewport({ scale: 1 });
  const fullScale = Math.min(3, MAX_EDGE / Math.max(base.width, base.height));
  page.cleanup();

  if (onPreview && fullScale > 0.6) {
    const preview = await paintPage(doc, quad, options, MAX_EDGE / 2);
    onPreview(preview);
    // 预览图等 30 秒再回收，给 MapLibre 足够的取图时间。
    if (preview.url.startsWith("blob:")) setTimeout(() => URL.revokeObjectURL(preview.url), 30_000);
  }
  const raster = await paintPage(doc, quad, options, MAX_EDGE);
  return raster;
}

/** 叠加层压在底图之上、航路 / 程序 / 交通之下。 */
function chartInsertBefore(map: MapLibreMap) {
  for (const id of ["ov-airway-line", "ov-waypoint", "ov-airport", "ov-procedure-casing", "ov-route-casing"]) {
    if (map.getLayer(id)) return id;
  }
  return undefined;
}

/** 装/换/卸航图图层。`raster` 为 null 表示整个移除。 */
export function applyChartLayer(map: MapLibreMap, raster: ChartRaster | null, visible: boolean, opacity: number) {
  if (!raster) {
    if (map.getLayer(CHART_LAYER)) map.removeLayer(CHART_LAYER);
    if (map.getSource(CHART_SOURCE)) map.removeSource(CHART_SOURCE);
    return;
  }
  const existing = map.getSource(CHART_SOURCE) as ImageSource | undefined;
  if (existing) {
    existing.updateImage({ url: raster.url, coordinates: raster.coordinates as never });
  } else {
    map.addSource(CHART_SOURCE, { type: "image", url: raster.url, coordinates: raster.coordinates as never });
  }
  if (!map.getLayer(CHART_LAYER)) {
    map.addLayer({
      id: CHART_LAYER,
      type: "raster",
      source: CHART_SOURCE,
      layout: { visibility: visible ? "visible" : "none" },
      paint: { "raster-opacity": opacity, "raster-fade-duration": 0, "raster-resampling": "linear" },
    }, chartInsertBefore(map));
  } else {
    map.setLayoutProperty(CHART_LAYER, "visibility", visible ? "visible" : "none");
    map.setPaintProperty(CHART_LAYER, "raster-opacity", opacity);
  }
}

/* 同一张图切换「去底 / 反色」时要重画，PDF 没必要重下：只缓存当前这一份。 */
let cachedKey = "";
let cachedUrl = "";

export async function chartPdf(icao: string, filename: string) {
  const key = `${icao.toUpperCase()}/${filename}`;
  if (cachedKey === key && cachedUrl) return cachedUrl;
  const url = await jeppChartFile(icao, filename);
  if (cachedUrl) releaseChartFile(cachedUrl);
  cachedKey = key;
  cachedUrl = url;
  return url;
}

export function releaseChartPdf() {
  if (cachedUrl) releaseChartFile(cachedUrl);
  cachedKey = "";
  cachedUrl = "";
}

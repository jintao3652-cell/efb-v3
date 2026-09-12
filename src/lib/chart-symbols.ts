import type { Map as MapLibreMap } from "maplibre-gl";

export type ChartSymbolName =
  | "airport-ifr" | "airport-vfr"
  | "waypoint" | "waypoint-compulsory" | "waypoint-flyover"
  | "intersection" | "intersection-compulsory" | "intersection-flyover"
  | "ndb" | "dme" | "vor" | "vor-dme" | "tacan" | "vortac"
  | "holding";

// Jeppesen Introduction to Jeppesen Navigation Charts, ENROUTE-7 图例键第 28 条：
//   "Compulsory Reporting Point represented by screened fill.
//    Non Compulsory Reporting point is open, no fill."
// 即强制报告点用网点（screened）填充，非强制报告点空心。
// 印刷版以灰网表现 screened；本应用底图为深色，故用半透明同色填充等效表达，
// 在小尺寸图标上比灰网更易辨识，同时保持"有填充 / 无填充"的语义对立。
const screenedFill = "rgba(233, 248, 255, 0.55)";
// Jeppesen SYMBOLS-8 "Fly Over Fix — Indicated by circle around fix"：
// 飞越点以圆圈套住定位点图形表示，故内层图形需相应缩小以容纳外圈。
// 外圈 19 与图例 swatch 的 r=11.2 成同一比例（图例 : 画布 = 1 : 1.7），确保两处同形。
const flyOverRing = 19;
const flyOverStarRadius = 13.3;
const flyOverTriangleRadius = 11.7;

const canvasSize = 64;
const center = canvasSize / 2;
const symbolColor = "#e9f8ff";
const haloColor = "#06131d";

function polar(radius: number, angle: number): [number, number] {
  return [center + Math.cos(angle) * radius, center + Math.sin(angle) * radius];
}

function polygonPath(points: number, outerRadius: number, innerRadius = outerRadius, rotation = -Math.PI / 2) {
  const path = new Path2D();
  const count = innerRadius === outerRadius ? points : points * 2;
  for (let index = 0; index < count; index++) {
    const radius = innerRadius === outerRadius || index % 2 === 0 ? outerRadius : innerRadius;
    const [x, y] = polar(radius, rotation + index * Math.PI * 2 / count);
    if (index === 0) path.moveTo(x, y); else path.lineTo(x, y);
  }
  path.closePath();
  return path;
}

function strokePath(context: CanvasRenderingContext2D, path: Path2D, color = symbolColor, width = 3) {
  context.strokeStyle = haloColor;
  context.lineWidth = width + 4;
  context.stroke(path);
  context.strokeStyle = color;
  context.lineWidth = width;
  context.stroke(path);
}

function fillPath(context: CanvasRenderingContext2D, path: Path2D, color: string) {
  context.strokeStyle = haloColor;
  context.lineWidth = 5;
  context.stroke(path);
  context.fillStyle = color;
  context.fill(path);
}

function circlePath(radius: number) {
  const path = new Path2D();
  path.arc(center, center, radius, 0, Math.PI * 2);
  return path;
}

function squarePath(radius: number) {
  const path = new Path2D();
  path.rect(center - radius, center - radius, radius * 2, radius * 2);
  return path;
}

// Jeppesen CHARTING SYMBOLS LEGEND, Symbol Category: NAVAIDS 中 NDB/LOCATOR
// 以「点状圆」表示（SYMBOLS-2）。
function dotsRingPath(radius: number, count: number, dotRadius: number) {
  const path = new Path2D();
  for (let index = 0; index < count; index++) {
    const [x, y] = polar(radius, index * Math.PI * 2 / count);
    path.moveTo(x + dotRadius, y);
    path.arc(x, y, dotRadius, 0, Math.PI * 2);
  }
  return path;
}

// TACAN 为「三尖星」、VORTAC 为「三尖星带条纹点」（Navigraph 符号章原文）。
// Jeppesen SYMBOLS-2 的图形为一点朝下、两点朝上，凹口约为外径的三分之一。
const THREE_POINT_RADIUS = 12.5;
function threePointStarPath() {
  return polygonPath(3, THREE_POINT_RADIUS, THREE_POINT_RADIUS / 3, Math.PI / 2);
}

function bandMarksPath(radius: number, halfWidth: number) {
  const path = new Path2D();
  for (const degrees of [90, 210, 330]) {
    const angle = degrees * Math.PI / 180;
    const [startX, startY] = polar(radius, angle - halfWidth);
    const [endX, endY] = polar(radius, angle + halfWidth);
    path.moveTo(startX, startY);
    path.lineTo(endX, endY);
  }
  return path;
}

// 强制报告点：先描边再叠填充。
// 顺序很重要——反之深色光晕（宽出 4px）会盖住星形只有 3.2px 的凹口，
// 使实心星退化成菱形；后填充则得到「清晰轮廓 + 网点内芯」的印刷观感。
function screenedPath(context: CanvasRenderingContext2D, path: Path2D, color = symbolColor, width = 2.6) {
  strokePath(context, path, color, width);
  context.fillStyle = screenedFill;
  context.fill(path);
}

// 等待航线（Jeppesen SYMBOLS-8 "ROUTES & AIRWAYS — Holding Patterns"，
// Navigraph 图例："A race track denotes a holding pattern.
//  The inbound holding course is shown in the middle."）：
// 跑道形 = 两端半圆 + 上下两条直边；中央一条短线表示入航边。
const holdingHalfLength = 13;
const holdingRadius = 8;

function holdingPath() {
  const path = new Path2D();
  path.moveTo(center - holdingHalfLength, center - holdingRadius);
  path.arc(center - holdingHalfLength, center, holdingRadius, -Math.PI / 2, Math.PI / 2, true);
  path.lineTo(center + holdingHalfLength, center + holdingRadius);
  path.arc(center + holdingHalfLength, center, holdingRadius, Math.PI / 2, -Math.PI / 2, true);
  path.closePath();
  return path;
}

function inboundCoursePath() {
  const path = new Path2D();
  path.moveTo(center - holdingHalfLength + 3, center);
  path.lineTo(center + holdingHalfLength - 3, center);
  return path;
}

function drawCompassRose(context: CanvasRenderingContext2D) {
  strokePath(context, circlePath(20), symbolColor, 2.2);
  for (let index = 0; index < 12; index++) {
    const angle = -Math.PI / 2 + index * Math.PI / 6;
    const [startX, startY] = polar(index % 3 === 0 ? 16 : 17.5, angle);
    const [endX, endY] = polar(22, angle);
    const tick = new Path2D();
    tick.moveTo(startX, startY);
    tick.lineTo(endX, endY);
    strokePath(context, tick, symbolColor, 1.8);
  }
}

// 机场为「齿轮状」符号：蓝色 = 有仪表进近程序（IFR），绿色 = 仅目视（VFR）；
// 空心表示无航图覆盖，中心实心点表示有航图覆盖。当前数据源没有航图覆盖字段，
// 因此统一按「空心 = 无覆盖」绘制，chartCoverage 预留给后续数据接入。
function drawAirport(context: CanvasRenderingContext2D, color: string, chartCoverage: boolean) {
  fillPath(context, polygonPath(12, 20, 15, -Math.PI / 2), color);
  context.save();
  context.globalCompositeOperation = "destination-out";
  context.fill(circlePath(7));
  context.restore();
  strokePath(context, circlePath(7), color, 2.2);
  if (chartCoverage) {
    context.fillStyle = color;
    context.fill(circlePath(2.8));
  }
}

function drawSymbol(name: ChartSymbolName, context: CanvasRenderingContext2D) {
  switch (name) {
    case "airport-ifr":
      drawAirport(context, "#45b9f2", false);
      break;
    case "airport-vfr":
      drawAirport(context, "#43d18f", false);
      break;
    case "waypoint":
      strokePath(context, polygonPath(4, 17, 3.2), symbolColor, 2.5);
      break;
    case "waypoint-compulsory":
      // SYMBOLS-8 AIRSPACE FIXES "RNAV Compulsory"：四角星为实心/screened。
      screenedPath(context, polygonPath(4, 17, 3.2), symbolColor, 2.5);
      break;
    case "waypoint-flyover":
      strokePath(context, circlePath(flyOverRing), symbolColor, 2.2);
      strokePath(context, polygonPath(4, 14.4, 2.7), symbolColor, 2.3);
      break;
    case "intersection":
      strokePath(context, polygonPath(3, 15, 15), symbolColor, 2.8);
      break;
    case "intersection-compulsory":
      // 术语表："COMPULSORY REPORTING POINTS ... designated by solid triangles"。
      screenedPath(context, polygonPath(3, 15, 15), symbolColor, 2.8);
      break;
    case "intersection-flyover":
      strokePath(context, circlePath(flyOverRing), symbolColor, 2.2);
      strokePath(context, polygonPath(3, flyOverTriangleRadius, flyOverTriangleRadius), symbolColor, 2.4);
      break;
    case "holding":
      strokePath(context, holdingPath(), symbolColor, 2.6);
      strokePath(context, inboundCoursePath(), symbolColor, 2.2);
      break;
    case "ndb":
      // Jeppesen SYMBOLS-2：NDB/LOCATOR 为「双同心点状圆」，而非实线双圆。
      fillPath(context, dotsRingPath(15.5, 20, 1.5), symbolColor);
      fillPath(context, dotsRingPath(8.5, 12, 1.5), symbolColor);
      break;
    case "dme":
      drawCompassRose(context);
      strokePath(context, squarePath(9), symbolColor, 2.8);
      break;
    case "vor":
      drawCompassRose(context);
      strokePath(context, polygonPath(6, 10, 10), symbolColor, 2.8);
      break;
    case "vor-dme":
      drawCompassRose(context);
      strokePath(context, squarePath(11), symbolColor, 2.5);
      strokePath(context, polygonPath(6, 8, 8), symbolColor, 2.3);
      break;
    case "tacan":
      drawCompassRose(context);
      strokePath(context, threePointStarPath(), symbolColor, 2.6);
      break;
    case "vortac":
      drawCompassRose(context);
      strokePath(context, threePointStarPath(), symbolColor, 2.6);
      strokePath(context, bandMarksPath(8.4, 0.28), symbolColor, 1.6);
      break;
  }
}

function createSymbolImage(name: ChartSymbolName) {
  const canvas = document.createElement("canvas");
  canvas.width = canvasSize;
  canvas.height = canvasSize;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建航图符号画布");
  context.lineCap = "round";
  context.lineJoin = "round";
  drawSymbol(name, context);
  return context.getImageData(0, 0, canvasSize, canvasSize);
}

const symbolNames: ChartSymbolName[] = [
  "airport-ifr", "airport-vfr",
  "waypoint", "waypoint-compulsory", "waypoint-flyover",
  "intersection", "intersection-compulsory", "intersection-flyover",
  "ndb", "dme", "vor", "vor-dme", "tacan", "vortac",
  "holding",
];

export function registerChartSymbols(map: MapLibreMap) {
  for (const name of symbolNames) {
    if (!map.hasImage(name)) map.addImage(name, createSymbolImage(name), { pixelRatio: 2 });
  }
}

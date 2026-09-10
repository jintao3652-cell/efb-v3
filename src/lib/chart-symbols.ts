import type { Map as MapLibreMap } from "maplibre-gl";

export type ChartSymbolName = "airport-ifr" | "airport-vfr" | "waypoint" | "intersection" | "ndb" | "dme" | "vor" | "vor-dme" | "tacan" | "vortac";

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
    case "intersection":
      strokePath(context, polygonPath(3, 15, 15), symbolColor, 2.8);
      break;
    case "ndb":
      strokePath(context, circlePath(13), symbolColor, 2.4);
      strokePath(context, circlePath(5), symbolColor, 2.4);
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
      strokePath(context, polygonPath(3, 12, 4.5), symbolColor, 2.8);
      break;
    case "vortac":
      drawCompassRose(context);
      strokePath(context, polygonPath(3, 13, 6.5), symbolColor, 3.2);
      strokePath(context, polygonPath(6, 6, 6), symbolColor, 2.1);
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

const symbolNames: ChartSymbolName[] = ["airport-ifr", "airport-vfr", "waypoint", "intersection", "ndb", "dme", "vor", "vor-dme", "tacan", "vortac"];

export function registerChartSymbols(map: MapLibreMap) {
  for (const name of symbolNames) {
    if (!map.hasImage(name)) map.addImage(name, createSymbolImage(name), { pixelRatio: 2 });
  }
}

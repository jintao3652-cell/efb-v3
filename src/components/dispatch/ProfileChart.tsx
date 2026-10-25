import { useMemo } from "react";
import type { TerrainSample } from "../../lib/terrain";

interface ProfileChartProps {
  samples: TerrainSample[];
  cruiseAltFt: number;
  distanceNm: number;
  waypoints: Array<{ ident: string; distanceNm: number; altitudeFt?: number }>;
  theme: "light" | "dark";
}

const W = 680;
const H = 236;
const PAD = { top: 18, right: 44, bottom: 26, left: 8 };

export function ProfileChart({ samples, cruiseAltFt, distanceNm, waypoints, theme }: ProfileChartProps) {
  const dark = theme === "dark";
  const colors = {
    grid: dark ? "rgba(255,255,255,.09)" : "rgba(20,24,30,.08)",
    axis: dark ? "#6f7883" : "#9aa0a8",
    path: dark ? "#5aa9f0" : "#127dd1",
    terrain: dark ? "#6d5b45" : "#c9a888",
    terrainLine: dark ? "#a67c52" : "#a9805a",
    label: dark ? "#c8d1da" : "#5c626b",
    mark: dark ? "rgba(255,255,255,.25)" : "rgba(20,24,30,.18)",
  };

  const geometry = useMemo(() => {
    const usableW = W - PAD.left - PAD.right;
    const usableH = H - PAD.top - PAD.bottom;
    const x = (nm: number) => PAD.left + (distanceNm === 0 ? 0 : (nm / distanceNm) * usableW);
    const maxAlt = 40000;
    const y = (feet: number) => PAD.top + usableH - (Math.min(feet, maxAlt) / maxAlt) * usableH;
    const terrainMax = 14000;
    const ty = (feet: number) => PAD.top + usableH - (Math.min(feet, terrainMax) / terrainMax) * usableH * 0.42;

    const climbNm = Math.min(105, distanceNm * 0.18);
    const descentNm = Math.min(125, distanceNm * 0.2);
    const cruiseStart = climbNm;
    const cruiseEnd = Math.max(cruiseStart + 1, distanceNm - descentNm);
    const path: Array<[number, number]> = [
      [x(0), y(0)],
      [x(climbNm * 0.45), y(cruiseAltFt * 0.55)],
      [x(cruiseStart), y(cruiseAltFt)],
      [x(cruiseEnd), y(cruiseAltFt)],
      [x(cruiseEnd + descentNm * 0.5), y(cruiseAltFt * 0.42)],
      [x(distanceNm), y(0)],
    ];

    const terrainPoints = samples.map((sample) => [x(sample.distanceNm), ty(sample.elevationFt ?? 0)] as [number, number]);
    const terrainArea = terrainPoints.length
      ? `M ${x(0)} ${y(0)} L ${terrainPoints.map(([px, py]) => `${px.toFixed(1)} ${py.toFixed(1)}`).join(" L ")} L ${x(distanceNm)} ${y(0)} Z`
      : "";

    return { x, y, path, terrainPoints, terrainArea, cruiseStart, cruiseEnd, usableH };
  }, [samples, cruiseAltFt, distanceNm]);

  const pathD = geometry.path.map(([px, py], index) => `${index === 0 ? "M" : "L"} ${px.toFixed(1)} ${py.toFixed(1)}`).join(" ");
  const hasTerrain = samples.some((sample) => sample.elevationFt != null);

  return <div className="profile">
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="高度与地形剖面">
      {[0, 10000, 20000, 30000, 40000].map((feet) => <g key={feet}>
        <line x1={PAD.left} x2={W - PAD.right} y1={geometry.y(feet)} y2={geometry.y(feet)} stroke={colors.grid} strokeWidth={1} />
        {feet > 0 && <text x={W - PAD.right + 6} y={geometry.y(feet) + 3} fill={colors.axis} fontSize={8.5}>{feet.toLocaleString("en-US")}</text>}
      </g>)}

      {waypoints.slice(0, 8).map((waypoint) => <g key={waypoint.ident}>
        <line x1={geometry.x(waypoint.distanceNm)} x2={geometry.x(waypoint.distanceNm)} y1={PAD.top} y2={H - PAD.bottom} stroke={colors.mark} strokeWidth={1} strokeDasharray="3 3" />
        <text x={geometry.x(waypoint.distanceNm)} y={PAD.top - 5} fill={colors.axis} fontSize={8} textAnchor="middle">{waypoint.ident}</text>
      </g>)}

      {hasTerrain && <>
        <path d={geometry.terrainArea} fill={colors.terrain} fillOpacity={0.45} />
        <path d={geometry.terrainPoints.map(([px, py], index) => `${index === 0 ? "M" : "L"} ${px.toFixed(1)} ${py.toFixed(1)}`).join(" ")} fill="none" stroke={colors.terrainLine} strokeWidth={1.2} />
      </>}

      <path d={pathD} fill="none" stroke={colors.path} strokeWidth={2.2} strokeLinejoin="round" strokeLinecap="round" />

      <line x1={PAD.left} x2={W - PAD.right} y1={H - PAD.bottom} y2={H - PAD.bottom} stroke={colors.grid} />
      {[0, 0.25, 0.5, 0.75, 1].map((fraction) => <text key={fraction} x={geometry.x(distanceNm * fraction)} y={H - PAD.bottom + 14} fill={colors.axis} fontSize={8.5} textAnchor={fraction === 0 ? "start" : fraction === 1 ? "end" : "middle"}>
        {Math.round(distanceNm * fraction)}
      </text>)}
      <text x={W - PAD.right + 6} y={H - PAD.bottom + 14} fill={colors.axis} fontSize={8.5}>ft</text>
      <text x={PAD.left + 2} y={H - 4} fill={colors.axis} fontSize={8.5}>沿航路距离（NM）</text>
    </svg>
    <div className="profile-legend">
      <span><i style={{ background: colors.path }} />计划高度剖面</span>
      <span><i style={{ background: colors.terrainLine }} />地形剖面（纵向放大）</span>
      {!hasTerrain && <span className="muted">地形数据不可用</span>}
    </div>
  </div>;
}

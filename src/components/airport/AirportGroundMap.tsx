import type { Airport } from "../../types";

const stands = [
  { id: "G01", x: 170, y: 110 }, { id: "G02", x: 230, y: 110 }, { id: "G03", x: 290, y: 110 }, { id: "G04", x: 350, y: 110 },
  { id: "G05", x: 410, y: 110 }, { id: "G06", x: 470, y: 110 }, { id: "G07", x: 530, y: 110 }, { id: "G08", x: 590, y: 110 },
];

export function AirportGroundMap({ airport, selectedStand, onSelectStand }: { airport: Airport; selectedStand: string; onSelectStand: (stand: string) => void }) {
  return <div className="ground-map"><div className="ground-map-header"><div><strong>{airport.icao} 停机位图</strong><span>示意数据 · 非官方机场图</span></div><span>已选择：{selectedStand}</span></div><svg viewBox="0 0 760 420" role="img" aria-label={`${airport.icao} 停机位示意图`}>
    <rect className="ground-background" width="760" height="420" rx="12" />
    <rect className="runway-shape" x="55" y="306" width="650" height="46" rx="4" /><line className="runway-markings" x1="76" y1="329" x2="684" y2="329" />
    <path className="taxiway-shape" d="M104 278 H658 M156 278 V174 H604 V278" />
    <rect className="terminal-shape" x="134" y="52" width="492" height="72" rx="8" /><text className="terminal-label" x="380" y="93" textAnchor="middle">TERMINAL · {airport.icao}</text>
    {stands.map((stand) => <g className={`stand ${selectedStand === stand.id ? "selected" : ""}`} key={stand.id} onClick={() => onSelectStand(stand.id)} role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter") onSelectStand(stand.id); }}>
      <line x1={stand.x} y1="124" x2={stand.x} y2="165" /><circle cx={stand.x} cy="171" r="14" /><text x={stand.x} y="175" textAnchor="middle">{stand.id.slice(1)}</text>
    </g>)}
    <text className="runway-label" x="380" y="334" textAnchor="middle">RUNWAY / TAXIWAY SYSTEM</text>
  </svg><div className="ground-map-legend"><span><i className="stand-symbol" />可用停机位</span><span><i className="stand-symbol selected" />当前选择</span><span><i className="line-symbol" />滑行道</span></div></div>;
}

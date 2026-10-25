import { useEffect } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { BookOpenCheck, ChevronLeft, ChevronRight, CloudSun, Layers3, Plane, Route, Settings2 } from "lucide-react";
import { TopBar } from "./TopBar";
import { useAppStore } from "../../stores/app-store";

const navItems = [
  { path: "/charts", icon: BookOpenCheck, label: "航图库" },
  { path: "/weather", icon: CloudSun, label: "气象" },
  { path: "/", icon: Layers3, label: "矢量地图" },
  { path: "/dispatch", icon: Route, label: "航路规划" },
  { path: "/airports", icon: Plane, label: "机场资料" },
];

const titles: Record<string, string> = {
  "/": "矢量地图",
  "/charts": "航图",
  "/weather": "气象",
  "/dispatch": "飞行计划",
  "/airports": "机场资料",
  "/settings": "设置",
};

export function AppShell() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const theme = useAppStore((state) => state.theme);
  const railHidden = useAppStore((state) => state.railHidden);
  const toggleRail = useAppStore((state) => state.toggleRail);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  const title = titles[pathname] ?? "SkyBoard";

  return <div className="efb-shell">
    <TopBar title={title} />
    <div className="app-body">
      {!railHidden && <nav className="rail" aria-label="主导航">
        <div className="rail-top">
          <button className="rail-back" onClick={() => navigate(-1)} title="返回"><ChevronLeft size={16} /></button>
        </div>
        <div className="rail-nav">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = item.path === "/" ? pathname === "/" : pathname.startsWith(item.path);
            return <button
              key={item.path}
              className={`rail-btn ${active ? "active" : ""}`}
              onClick={() => navigate(item.path)}
              aria-label={item.label}
              aria-current={active ? "page" : undefined}
            >
              <Icon size={19} strokeWidth={1.85} />
              <span className="rail-tip">{item.label}</span>
            </button>;
          })}
        </div>
        <div className="rail-bottom">
          <button className={`rail-btn ${pathname === "/settings" ? "active" : ""}`} onClick={() => navigate("/settings")} aria-label="设置">
            <Settings2 size={19} strokeWidth={1.85} />
            <span className="rail-tip">设置</span>
          </button>
        </div>
      </nav>}
      <main className="main">
        {railHidden && <button className="rail-restore" onClick={toggleRail} title="显示图标栏"><ChevronRight size={15} /></button>}
        <Outlet />
      </main>
    </div>
  </div>;
}

export default AppShell;

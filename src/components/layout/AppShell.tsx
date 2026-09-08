import { useEffect } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import {
  Bell, BookOpen, ChevronLeft, ChevronRight, CloudSun, Compass, Gauge, Map, Menu, Moon, Plane, Settings, Sun, Wifi, WifiOff,
} from "lucide-react";
import { useAppStore } from "../../stores/app-store";

const navigation = [
  { to: "/", label: "概览", icon: Gauge },
  { to: "/map", label: "航图地图", icon: Map },
  { to: "/flight-plans", label: "飞行计划", icon: Plane },
  { to: "/airports", label: "机场信息", icon: Compass },
  { to: "/charts", label: "航图库", icon: BookOpen },
  { to: "/weather", label: "天气与通告", icon: CloudSun },
];

export function AppShell() {
  const { sidebarCollapsed, toggleSidebar, theme, online, setOnline, setTheme } = useAppStore();
  const location = useLocation();

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => { window.removeEventListener("online", update); window.removeEventListener("offline", update); };
  }, [setOnline]);

  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);

  const title = navigation.find((item) => item.to === location.pathname)?.label ?? "SkyBoard EFB";
  return <div className={`app-shell ${sidebarCollapsed ? "sidebar-is-collapsed" : ""}`}>
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><Plane size={21} /></div><span>SkyBoard</span></div>
      <nav aria-label="主导航">{navigation.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} end={to === "/"} className="nav-item">
        <Icon size={20} /><span>{label}</span>
      </NavLink>)}</nav>
      <div className="sidebar-bottom">
        <NavLink to="/settings" className="nav-item"><Settings size={20} /><span>设置</span></NavLink>
        <button className="collapse-button" onClick={toggleSidebar} aria-label="收起侧栏">
          {sidebarCollapsed ? <ChevronRight size={18} /> : <><ChevronLeft size={18} /><span>收起菜单</span></>}
        </button>
      </div>
    </aside>
    <main className="main-area">
      <header className="topbar">
        <button className="icon-button mobile-menu" onClick={toggleSidebar} aria-label="导航菜单"><Menu size={21} /></button>
        <div><p className="eyebrow">ELECTRONIC FLIGHT BAG</p><h1>{title}</h1></div>
        <div className="topbar-actions">
          <div className={`connection ${online ? "online" : "offline"}`}>{online ? <Wifi size={15} /> : <WifiOff size={15} />}<span>{online ? "在线" : "离线缓存"}</span></div>
          <button className="theme-toggle" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label={theme === "dark" ? "切换为白色页面" : "切换为深色页面"} title={theme === "dark" ? "切换为白色页面" : "切换为深色页面"}>
            {theme === "dark" ? <><Sun size={17} /><span>白色页面</span></> : <><Moon size={17} /><span>深色页面</span></>}
          </button>
          <button className="icon-button" aria-label="通知"><Bell size={19} /></button>
          <div className="avatar">EF</div>
        </div>
      </header>
      <section className="page-content"><Outlet /></section>
    </main>
  </div>;
}

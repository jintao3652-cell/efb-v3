import { useState } from "react";
import { Database, HardDrive, Moon, Sun, Trash2 } from "lucide-react";
import { clearCache } from "../lib/tauri";
import { useAppStore } from "../stores/app-store";

export function SettingsPage() {
  const { theme, setTheme, language, setLanguage } = useAppStore();
  const [message, setMessage] = useState("");
  const handleClear = async () => { await clearCache(); setMessage("已清除可再生航图缓存；飞行计划和设置已保留。"); };
  return <div className="settings-page page-stack"><div><h2>设置</h2><p>应用偏好、缓存与数据管理。</p></div><section className="panel setting-section"><div className="setting-title"><div><Moon className="accent-icon" size={22} /><div><h3>外观</h3><p>选择应用主题</p></div></div><div className="segmented"><button className={theme === "dark" ? "active" : ""} onClick={() => setTheme("dark")}><Moon size={16} />深色</button><button className={theme === "light" ? "active" : ""} onClick={() => setTheme("light")}><Sun size={16} />浅色</button></div></div><div className="setting-row"><div><strong>显示语言</strong><p>默认使用简体中文</p></div><select value={language} onChange={(event) => setLanguage(event.target.value as "zh-CN" | "en")}><option value="zh-CN">简体中文</option><option value="en">English</option></select></div></section><section className="panel setting-section"><div className="setting-title"><div><HardDrive className="accent-icon" size={22} /><div><h3>本地缓存</h3><p>航图 PDF、AIRAC 数据和天气缓存</p></div></div><strong>0 MB</strong></div><div className="setting-row"><div><strong>缓存位置</strong><p>Windows AppData · SkyBoard EFB</p></div><button className="button danger" onClick={handleClear}><Trash2 size={16} />清除缓存</button></div>{message && <p className="success-message">{message}</p>}</section><section className="panel setting-section"><div className="setting-title"><div><Database className="accent-icon" size={22} /><div><h3>航行数据</h3><p>AIRAC 数据与授权航图数据源</p></div></div><span className="data-cycle">AIRAC 2609</span></div><div className="setting-row"><div><strong>数据状态</strong><p>基础演示数据可离线使用。生产使用前需配置合法授权的数据源。</p></div><button className="button secondary" disabled>检查更新</button></div></section></div>;
}

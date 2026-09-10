import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { open } from "@tauri-apps/plugin-dialog";
import { Database, HardDrive, Moon, RefreshCw, Sun, Trash2, Upload } from "lucide-react";
import { clearCache, getCurrentAiracCycle, getNavigationDatabaseStatus, setNavigationDatabase } from "../lib/tauri";
import { useAppStore } from "../stores/app-store";

export function SettingsPage() {
  const { theme, setTheme, language, setLanguage } = useAppStore();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState("");
  const airac = useQuery({ queryKey: ["current-airac-cycle"], queryFn: getCurrentAiracCycle, retry: 1 });
  const navigation = useQuery({ queryKey: ["navigation-database"], queryFn: getNavigationDatabaseStatus, retry: 0 });
  const navigationMutation = useMutation({
    mutationFn: ({ source, databasePath }: { source: "lnm" | "fenix"; databasePath?: string }) => setNavigationDatabase(source, databasePath),
    onSuccess: (status) => { queryClient.setQueryData(["navigation-database"], status); setMessage(status.message); },
  });
  const cycle = airac.data?.cycleId ?? "2609";
  const navStatus = navigation.data;
  const navSourceName = navStatus?.source === "fenix" ? "Fenix" : "Little Navmap";

  const handleClear = async () => {
    await clearCache();
    setMessage("已清除可再生航图缓存；飞行计划、导航数据库和设置已保留。");
  };
  const chooseDatabase = async (source: "lnm" | "fenix") => {
    const path = await open({
      multiple: false,
      directory: false,
      filters: [{ name: source === "lnm" ? "Little Navmap SQLite" : "Fenix nd.db3", extensions: source === "lnm" ? ["sqlite", "db"] : ["db3", "sqlite", "db"] }],
    });
    if (path && !Array.isArray(path)) navigationMutation.mutate({ source, databasePath: path });
  };

  return <div className="settings-page page-stack">
    <div><h2>设置</h2><p>应用偏好、缓存与数据管理。</p></div>
    <section className="panel setting-section">
      <div className="setting-title"><div><Moon className="accent-icon" size={22} /><div><h3>外观</h3><p>选择应用主题</p></div></div><div className="segmented"><button className={theme === "dark" ? "active" : ""} onClick={() => setTheme("dark")}><Moon size={16} />深色</button><button className={theme === "light" ? "active" : ""} onClick={() => setTheme("light")}><Sun size={16} />浅色</button></div></div>
      <div className="setting-row"><div><strong>显示语言</strong><p>默认使用简体中文</p></div><select value={language} onChange={(event) => setLanguage(event.target.value as "zh-CN" | "en")}><option value="zh-CN">简体中文</option><option value="en">English</option></select></div>
    </section>
    <section className="panel setting-section">
      <div className="setting-title"><div><HardDrive className="accent-icon" size={22} /><div><h3>本地缓存</h3><p>航图 PDF、AIRAC 数据和天气缓存</p></div></div><strong>0 MB</strong></div>
      <div className="setting-row"><div><strong>缓存位置</strong><p>Windows AppData · SkyBoard EFB</p></div><button className="button danger" onClick={handleClear}><Trash2 size={16} />清除缓存</button></div>
      {message && <p className="success-message">{message}</p>}
    </section>
    <section className="panel setting-section">
      <div className="setting-title"><div><Database className="accent-icon" size={22} /><div><h3>导航数据库</h3><p>两种数据库互斥；选择新文件会立即替换当前数据源。</p></div></div><span className={`data-cycle ${navStatus?.ready ? "" : "pending"}`}>{navStatus?.source?.toUpperCase() ?? "LNM"}</span></div>
      <div className="database-source-choice">
        <button className={navStatus?.source !== "fenix" ? "active" : ""} onClick={() => chooseDatabase("lnm")} disabled={navigationMutation.isPending}><strong>Little Navmap</strong><span>机场、航路点、跑道、通信和 AIRAC</span><Upload size={16} /></button>
        <button className={navStatus?.source === "fenix" ? "active" : ""} onClick={() => chooseDatabase("fenix")} disabled={navigationMutation.isPending}><strong>Fenix</strong><span>nd.db3：Airports、Waypoints、Runways 和 AIRAC</span><Upload size={16} /></button>
      </div>
      <div className="setting-row"><div><strong>{navStatus?.ready ? `已加载 ${navSourceName} · AIRAC ${navStatus.airacCycle ?? "未知"}` : "数据库状态"}</strong><p>{navigationMutation.isError ? navigationMutation.error.message : navigation.isError ? navigation.error.message : navStatus?.message ?? "正在检查导航数据库"}</p></div>{navStatus?.databasePath && <span className="database-path">{navStatus.databasePath.split(/[\\/]/).pop()}</span>}</div>
    </section>
    <section className="panel setting-section">
      <div className="setting-title"><div><Database className="accent-icon" size={22} /><div><h3>航行数据</h3><p>{airac.data ? `${airac.data.provider} · 周期开始于 ${new Date(airac.data.cycleStartDate).toLocaleDateString("zh-CN")}` : "正在检查 Navigraph FMS Data 周期"}</p></div></div><span className="data-cycle">AIRAC {cycle}</span></div>
      <div className="setting-row"><div><strong>AIRAC 当前周期</strong><p>{airac.isError ? "无法连接周期服务，显示最近已知周期。" : `周期 ${cycle} 可用于检测导航数据是否需要更新。`}</p></div><button className="button secondary" onClick={() => airac.refetch()} disabled={airac.isFetching}><RefreshCw className={airac.isFetching ? "spinning" : ""} size={16} />{airac.isFetching ? "正在检查" : "检查更新"}</button></div>
    </section>
  </div>;
}

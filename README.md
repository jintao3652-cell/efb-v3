# SkyBoard EFB

Windows 优先、离线优先的模拟飞行电子飞行包（EFB）。本项目包含可运行的 Tauri 2 + React 19 桌面应用基础：概览、航图地图、飞行计划本地 SQLite 存储、机场信息、航图库、天气缓存与设置。

## 已实现

- Windows 桌面壳与 MSI / NSIS 打包配置
- 中文深色 UI、路由、主题和在线/离线状态
- MapLibre 中国区域基础地图、航路和机场演示图层
- 飞行计划新增、编辑、SQLite 本地保存与浏览器开发模式回退
- 机场检索、频率、跑道信息和航图库缓存状态界面
- METAR 网络查询与离线缓存展示策略

## 开发环境

Windows 10/11，Node.js 20+ 与 Rust stable（MSVC 工具链）。先安装 Rust：

```powershell
winget install Rustlang.Rustup
rustup default stable-msvc
```

安装 Visual Studio Build Tools 时需要勾选“使用 C++ 的桌面开发”。重启终端后：

```powershell
npm install
npm run tauri dev
```

仅运行 Web UI（不包含 Tauri 本地数据库和天气命令）：

```powershell
npm run dev
```

## Windows 安装包

```powershell
npm run tauri build -- --target x86_64-pc-windows-msvc
```

构建产物位于 `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/`，包含 `.msi` 和 NSIS `.exe`。

## 数据与授权

应用演示数据不提供真实航图或商业 AIRAC 数据。接入 Navigraph、机场 AIP 或任何第三方数据前，必须使用具有相应分发和缓存许可的账户/API。飞行前请以官方 AIP、NOTAM 和气象信息为准。

### OpenWeather（可选）

天气页优先使用中国气象局航空气象的 `http://avimet.nmc.cn/hangkong/METAR/{ICAO}.json` 和 `http://avimet.nmc.cn/hangkong/TAF/{ICAO}.json`。服务不可用时，配置 `OPENWEATHER_API_KEY` 后会回退至 OpenWeather，否则使用 Aviation Weather Center 的 METAR 查询。所有数据只作补充态势参考，不能替代官方航空气象资料。地图底图数据来自 OpenStreetMap contributors。

### Navigraph AIRAC 周期

设置页通过 `https://fmsdata.api.navigraph.com/v3/cycles` 查询当前 AIRAC 周期，仅用于检测周期变化；下载、解析或分发 Navigraph 导航数据仍需有效的 Navigraph 授权。

### Mapbox 与 SimBrief

将公开 Mapbox 访问令牌写入 `.env` 中的 `VITE_MAPBOX_ACCESS_TOKEN` 后，MapLibre 将优先使用 Mapbox 栅格图源；未配置时自动使用 OpenStreetMap。飞行计划页支持输入 SimBrief 用户名，并通过 `https://www.simbrief.com/api/xml.fetcher.php?username={username}&json=1` 导入最近一次 OFP。请只使用你有权访问的 SimBrief 用户数据，并在导入后核对全部飞行信息。

## 后续开发

1. 添加受授权的 AIRAC 导入器及航图 PDF 下载缓存。
2. 接入 SimBrief OFP 文件/账户导入与 VATSIM 状态。
3. 实现航图 PDF.js 查看器、停机位图和地图离线瓦片包。
4. 配置代码签名、Tauri Updater 与 Windows 发布流水线。

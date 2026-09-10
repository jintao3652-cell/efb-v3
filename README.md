# SkyBoard EFB

Windows 优先、离线优先的模拟飞行电子飞行包（EFB）。本项目包含可运行的 Tauri 2 + React 19 桌面应用基础：概览、航图地图、飞行计划本地 SQLite 存储、机场信息、航图库、天气缓存与设置。

## 已实现

- Windows 桌面壳与 MSI / NSIS 打包配置
- 中文深色 UI、路由、主题和在线/离线状态
- MapLibre 地图、导航航路、机场、VATSIM 实时交通与空域图层
- 飞行计划新增、编辑、SID/STAR 与跑道选择、SQLite 本地保存与浏览器开发模式回退
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

机场页会读取项目根目录的 `AD_HP.csv`（GBK/GB18030），国内 `Z` 开头机场使用其中的 `TXT_NAME`、IATA、标高和坐标。机位、通信频率、跑道及在线航图来自 XFlySim EFB API；四个接口独立加载，单个接口失败不会丢失其他结果，并会按 ICAO 回退最近缓存或本地导航数据库。

地图空域图层使用 Volanta CDN 托管的 VAT-Spy FIR/UIR 边界，以及 SimAware TRACON Project 的 APP/DEP 边界。TRACON 每 15 秒读取 VATSIM 在线席位，以最长 `prefix` 和 `suffix` 匹配呼号，例如 `ZSSS_APP` 匹配 `ZSSS`、`ZSSS_E_APP` 优先匹配 `ZSSS_E`。终端航路点使用独立开关，默认关闭，并仅在地图放大到较高层级后显示；SimBrief 航路所需坐标点仍会保留。

VATGlasses 高精度扇区是独立图层，不控制 FIR 或 SimAware APP 边界。默认数据集代码为 `z`，可切换到 `vatglasses-data` 仓库中的其他数据集，并按当前飞行高度层筛选扇区。地图面板支持上传自定义 Ownership、恢复仓库预设和下载当前显示归属；不支持或加载失败的区域继续使用 VAT-Spy / SimAware 边界。

地图放大至 Zoom 12 后会按当前可视范围从 OpenStreetMap Overpass 服务加载公开机场地面数据，包括跑道、滑行道、滑行道编号、机坪、航站楼、机位和登机口。该功能无需登录，数据完整度取决于 OpenStreetMap 社区标注。

地图每 15 秒读取 VATSIM 在线航班位置。点击飞机标记会打开侧边航班详情，显示呼号、起降机场、机型、高度、地速、航向、应答机、QNH、飞行员和计划航路等公开信息。

使用 Fenix `nd.db3` 时，地图默认隐藏数据库中以经纬度格式命名的航点；当前飞行计划按标识或坐标实际经过这些点时会自动保留，并继续显示在 SimBrief 航路上。

飞行计划编辑器会从 Fenix `Terminals` / `TerminalLegs` 读取机场 SID、STAR、适用跑道和过渡点，并把可用坐标航段拼接到地图航迹，但不会重复写入航路文本。当前主导航源为 Little Navmap 时，如本机存在默认的 `C:\ProgramData\Fenix\Navdata\nd.db3`，会仅将其作为终端程序补充数据；未找到可用程序库时，编辑器会保留手工航路并给出提示。

### OpenWeather（可选）

天气页优先使用中国气象局航空气象的 `http://avimet.nmc.cn/hangkong/METAR/{ICAO}.json` 和 `http://avimet.nmc.cn/hangkong/TAF/{ICAO}.json`。服务不可用时会尝试 Aviation Weather Center；配置 `OPENWEATHER_API_KEY` 后还可回退至 OpenWeather。成功结果按 ICAO 持久缓存，离线时不会用其他机场的示例天气替代。所有数据只作补充态势参考，不能替代官方航空气象资料。地图底图数据来自 OpenStreetMap contributors。

如需在航图地图启用 OpenWeather 降水雷达，请在项目根目录 `.env` 中设置 `VITE_OPENWEATHER_API_KEY=你的_API_Key`。地图使用 `precipitation_new` 瓦片；未配置时，天气雷达开关会显示配置提示。

非 `Z` 开头的 ICAO 机场直接请求 Aviation Weather Center 的 METAR（`hours=0`）和 TAF，并在天气页提供 `metar-taf.com` 的机场预览入口。

### Navigraph AIRAC 周期

设置页通过 `https://fmsdata.api.navigraph.com/v3/cycles` 查询当前 AIRAC 周期，仅用于检测周期变化；下载、解析或分发 Navigraph 导航数据仍需有效的 Navigraph 授权。

### Mapbox 与 SimBrief

将公开 Mapbox 访问令牌写入 `.env` 中的 `VITE_MAPBOX_ACCESS_TOKEN` 后，MapLibre 将优先使用 Mapbox 栅格图源；未配置时自动使用 OpenStreetMap。飞行计划页支持输入 SimBrief 用户名，并通过 `https://www.simbrief.com/api/xml.fetcher.php?username={username}&json=1` 导入最近一次 OFP。请只使用你有权访问的 SimBrief 用户数据，并在导入后核对全部飞行信息。

## 后续开发

1. 添加受授权的 AIRAC 导入器与数据版本差异检查。
2. 接入可靠的 NOTAM 数据源与重要通告筛选。
3. 增加地图离线瓦片包和机场地面数据预下载。
4. 配置代码签名、Tauri Updater 与 Windows 发布流水线。

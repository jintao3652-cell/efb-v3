# Jeppesen / Navigraph 航图图例结构（修订版）

> 依据：
> - Jeppesen *Introduction to Jeppesen Navigation Charts*（Airway Manual, INTRODUCTION → CHART LEGEND 章节，SYMBOLS / ENROUTE / SID-STAR / AIRPORT / APPROACH 各分节）
> - Navigraph *Introduction to Navigraph Charts* v3.0（航路图符号速览、航图库分区）
> - Jeppesen *Navigational Aid Legend*（FliteStar 官方图例）
>
> 修订目标：修正原稿的分块顺序、符号形状、定义错误与缺失项；原文中表述正确但不够精确的地方一并补全。

---

## 0. 核心纠错清单

| # | 原稿表述 | 问题 | 修订后 |
| --- | --- | --- | --- |
| 1 | 图例分为 5 块，**Charting Symbols** 排在最后 | 顺序与完整性不符 | Airway Manual 的 **CHART LEGEND** 共 **7 节**，`Charting Symbols Legend` 排在**最前**（SYMBOLS-1），另补 **EASA AIR OPS AOM** 与 **Airline Format (CAO)** 两节 |
| 2 | 「六边形 + 外框 = VORDME / VORTAC」 | 把两种台混为一谈 | 方形外框只表示 **VOR/DME**；**VORTAC = 六边形与三尖星的组合符号** |
| 3 | 未列 DME 单独符号 | 遗漏 | **方框（正方形）= DME 台**，单独出现时即表示 DME |
| 4 | 「三尖星 = TACAN（军用测距导航台）」 | 定性偏差 | TACAN = 战术空中导航系统，**军民均可使用**，同时提供方位与测距 |
| 5 | 「带阴影的框 = 主用导航台」 | 语境混淆 | 航路图上阴影框 = **该台是航路/航线的组成部分**；进近图上阴影框 = **进近所依据的主用设施**。两个语境要分开说 |
| 6 | 机场只说颜色，未写**形状** | 关键要素缺失 | 机场符号是**齿轮状（cogwheel）**；蓝色 = IFR，绿色 = VFR；中心蓝点 = 有航图覆盖，空心 = 无 |
| 7 | 「机场名称用大写 = 有仪表程序」 | 对象不对 | 是 **Location name（地点名/城市名）**大写 = IFR（程序按该名归档）；大小写混合 = VFR。机场名本身另论 |
| 8 | 「MORA = 最低离场高度」 | **定义错误** | MORA = **Minimum Off-Route Altitude，最低偏航高度 / 航路外最低高度** |
| 9 | 「等磁差线 Isogonic Line」 | 不属于航路图常规要素 | 航路图在各导航台/机场旁以**磁差数值 + 罗盘玫瑰**表示；等磁差线主要见于计划图、区域图 |
| 10 | 未区分 MEA / MOCA / MRA / MCA / MAA | 高度体系缺失 | 见第 4 节 |
| 11 | 「Transition 用虚线或不同颜色表示」 | 不够准确 | **粗实线 = 多个过渡共用的公共航段；粗虚线 = 过渡航段** |
| 12 | 未提 Grid MORA 颜色规则 | 遗漏 | **＜10 000 ft 用绿色，≥10 000 ft 用绛红（maroon）**，数值以百英尺计 |
| 13 | 未提高度后缀 D / G | 遗漏 | 高度后 **D** = DME/DME/IRU 的 MEA；**G** = RNAV/GPS 的 MEA；**T** = MOCA |
| 14 | 报告点只分强制/非强制两类 | 不完整 | 应为**强制（实心）/ 非强制（空心）/ 飞越点（fly-over）**三类 |
| 15 | 特殊空域只用「紫色多边形」概括 | 信息不完整 | 紫色 + **区内的类型字母**：P / R / D / W / A / T / C，以及 TRA、TSA、MOA 等 |
| 16 | 缺失进近灯光框、复飞图标、地形与障碍物符号 | 遗漏 | 属 `Lighting Box & Missed Approach`、`Terrain` 两个子组 |

---

## 1. 图例分册结构（正确版）

### 1.1 Airway Manual → CHART LEGEND 的 7 节

按手册目录的实际顺序：

| 顺序 | 章节名 | 目录页码段 | 覆盖的图 |
| --- | --- | --- | --- |
| 1 | **Charting Symbols Legend** | SYMBOLS-1 … | 通用符号总汇（所有图都用） |
| 2 | **Enroute Chart Legend** | ENROUTE-1 … | 高空 / 低空 / 高-低空航路图、区域图 |
| 3 | **SID/DP and STAR Chart Legend** | SID/STAR-1 … | 离场程序（SID / DP）、进场程序（STAR） |
| 4 | **Airport Chart Legend** | AIRPORT-1 … | 10-9 机场平面图（含滑行图） |
| 5 | **Approach Chart Legend** | APPROACH-1 … | ILS / VOR / NDB / TACAN / RNAV(GPS) 等进近图 |
| 6 | Chart Legend — **EASA AIR OPS AOM** | — | 按 EASA AIR OPS 体系表示的机场运行最低标准 |
| 7 | **Approach Chart Legend — Airline Format (CAO)** | AIRLINE FORMAT-1 … | 航司版式，主要面向 **C / D 类**航空器 |

> 原稿的 5 块内容本身没问题，问题在于**顺序**（Charting Symbols 应排第一）和**缺 2 节**。

### 1.2 Charting Symbols Legend 的 8 个子组

这是原稿完全没展开、但最该记住的骨架：

| 子组 | 内容 |
| --- | --- |
| **Navaids** | 导航设施符号（VOR / VORTAC / VOR-DME / TACAN / DME / NDB / LOC 等） |
| **Airspace & Boundaries** | 空域分类与边界（A/B/C/D/G 类、FIR/UIR、ADIZ、国境线等） |
| **Airport** | 机场、水上飞机基地、直升机场；民/军 × IFR/VFR |
| **Routes & Airways** | 航路/航线中心线、代号、各类报告点 |
| **Airspace Fixes** | 定位点、数据库标识、MCA/MRA 注记 |
| **Lighting Box & Missed Approach** | 进近灯光系统、PAPI/VASI、复飞图标 |
| **Terrain** | 地形与障碍物 |
| **Miscellaneous** | 其他（如工厂、铁路、输电线路、时区等） |

### 1.3 各 Legend 的内部小节（官方目录）

| 图例 | 内部小节 |
| --- | --- |
| **Enroute** | Format → Heading → Coverage Diagram → Changes → Airspace Limits & Classification → Communications → Special Use Airspace → Reference Notes → Cruising Levels → Range Scale → End Panel → Chart Graphic → 10-1B Chart Legend |
| **SID/DP & STAR** | Format → Heading → Briefing Information → MSA → Climb & Routing Instructions Tabulated Text Box → Graphic: Information Boxes / Lost Communications Procedure / Speed Restrictions / Start & End Points → Graphic |
| **Airport** | Format → Heading → Communications → Airport Planview → Additional Runway Information Band → Take-off Minimums → Alternate Minimums → Chart Boundary Line Information |
| **Approach** | Format → Heading → Communications → Approach Briefing Information → MSA → Approach Planview（含 RNAV 差异、Not-To-Scale 插图）→ Non-Precision Recommended Altitude Descent Table → Approach Profile View → Descent/Timing Conversion Table + Lighting Box + Missed Approach Icons → Landing Minimums → Chart Boundary Line Information |

### 1.4 Navigraph 的对应关系

- Navigraph 的导航数据与图例**沿用 Jeppesen 标准**（其官方文档明示「大部分遵循 Jeppesen 标准」）。
- 航图库按 **5 个分区**组织：**STAR / APP / TAXI / SID / REF**。
  （若机场属于某条飞行计划：起飞机场无 STAR / APP，目的机场无 SID。）
- 航图按**用途**归类为「程序图 / 机场平面图 / 参考文本」三类，并用颜色区分。
- SID / STAR / APP 三个分区还提供按跑道过滤的 *visual overview*。

### 1.5 航图编号体系（速记）

| 编号 | 图种 |
| --- | --- |
| 10-1 / 10-1A | 区域图 / B 类空域图 |
| 10-2 | 进场图 STAR |
| 10-3 | 离场图 SID |
| 10-4、10-5、10-7 | 定制图 |
| 10-6 | 滑行路线图 |
| 10-8 | 机场施工信息 |
| **10-9** | **机场平面图** |

进近图编号形如 `AB-C`，其中 **B 位**表示进近类型：
`1` = ILS/MLS，`2` = GPS（独立），`3` = VOR，`4` = TACAN，`6` = NDB，`7` = DF，`8` = PAR/ASR，`9` = RNAV/目视，`0` = 其他航图。

---

## 2. 导航台（Navaids）

### 2.1 符号形状

| 符号 | 台站 | 说明 |
| --- | --- | --- |
| **六边形**（空心） | **VOR** | 单独 VOR |
| **六边形 + 方形外框** | **VOR/DME** | 外框表示测距能力 |
| **三尖星** | **TACAN** | 战术空中导航系统，军民均可使用 |
| **六边形 + 三尖星组合** | **VORTAC** | VOR 与 TACAN 同址，两者服务的组合 |
| **方框（正方形）** | **DME** | 单独的 DME 台 |
| **空心圆（环）** | **NDB** | 无方向信标 |
| **带点的圆 / 与指点标同址** | **NDB(LOM)** | 与指点标同址的定位信标，同时是强制报告点 |
| **圆角矩形框** | **LOC / SDF / LDA / MLS** | 航向台类设施（承担航路功能时） |
| **圆 + 刻度（罗盘玫瑰）** | — | 环绕 VHF 台，显示**该点磁差**，可直接读取磁方位/磁航迹 |

> 航路上的数字（如 `339°`）表示**相对该台的径向线**。

### 2.2 识别框（Facility Box）

| 规则 | 含义 |
| --- | --- |
| **阴影框（shadow box）** | 该台是**航路或航线的组成部分**，框内含频率、识别码、摩尔斯电码（高-低空图还含经纬度） |
| **离航路台不框** | 低空、高-低空图上，不承担航路功能的台不加框 |
| **频率前小 `D`** | 该台**具备 DME 能力**（频率配对的 DME/TACAN） |
| **`D` 带星号 `*`** | 分时段工作 |
| **`(T)` / `(L)` / `(H)`** | 导航台等级：终端 Terminal / 低空 Low / 高空 High（即服务范围） |
| **频率加圆括号「鬼影频率」** | 供民用设备调谐 TACAN-only 台的 DME |
| **`DME not Co-located`** | VOR 与 TAC/DME 天线**未同址**，注记在识别框下方 |
| **数值用 `[ ]` 括起** | **数据库标识符**，无 ATC 用途，不可用于飞行计划或通话 |

---

## 3. 机场符号（Airport Symbols）

| 颜色 / 样式 | 含义 |
| --- | --- |
| **齿轮状多边形** | 机场符号的**基本形状**（航路图、区域图通用） |
| **蓝色齿轮** | **IFR 机场**——有公布的仪表程序，程序按该地点名归档 |
| **绿色齿轮** | **VFR 机场**——Jeppesen 未为其公布程序 |
| **中心实心蓝点** | **有航图（进近图/机场图）覆盖** |
| **中心空心** | 无航图覆盖 |
| **`H`** | 直升机场 |
| **`W` 后缀** | 水上跑道 / 水上运行区 |

**图例派生的组合**：民用或军民合用、军用 × 航空港 / 水上飞机基地 / 直升机场 × IFR / VFR，共 **12 种基础组合**。

### 文字标注规则

- **Location name（地点名）大写** → 该地点有 IFR 已公布程序；**大小写混合** → VFR 机场，下方另附有**机场标高**与**最长跑道长度**。
- 跑道长度取整到**最近的 100 ft**，以 **70 ft 为进位分界**（≥70 进位加 100）。
- 跑道长度后缀 **`s`** = 软道面（soft surface）；无后缀 = 硬道面。

### 机场图（10-9）特有的机场要素

以下要素属于 `Charting Symbols Legend → Airport / Lighting Box`，**不属于航路图图例**，原稿把它们和航路图符号混在了一起：

跑道号（磁方位，真方位加 `T`）、跑道长度与入口标高、入口内移、LAHSO 短距着陆停止点、HOT SPOT、停止道/安全道、RVR 测量点、滑行道与停机坪代码、永久关闭的滑行道/跑道、**进近灯光构型**（ALSF-I/II、MALSR、SSALR、SALS、ODALS、HIALS 等）、EMAS 工程阻拦材料、风向袋、机场识别灯标、**直升机着陆区**、施工区（虚线）、高于最近跑道 50 ft 的障碍物、机场内外的道路与建筑、电线等。

---

## 4. 高度体系与高度标注（最易错）

### 4.1 航路图上的各类高度

| 缩写 | 全称 | 含义与要点 |
| --- | --- | --- |
| **MEA** | Minimum Enroute Altitude | 最低航路高度：**整段**都有可靠导航信号 + 超障 |
| **MOCA** | Minimum Obstruction Clearance Altitude | 最低超障高度：**Jeppesen 写作「高度 + T」**（如 `2900T`）；仅保证 **VOR 22 NM** 内信号。FAA 航图则用前缀 `*` |
| **MRA** | Minimum Reception Altitude | 最低接收高度：能同时收到前后两台的信号 |
| **MCA** | Minimum Crossing Altitude | 最低穿越高度，Jeppesen 在**定位点名下加注**（FAA 用小旗） |
| **MAA** | Maximum Authorized Altitude | 最高可用高度 |
| **MSA** | Minimum Safe / Sector Altitude | 最低扇区高度：以台/机场为中心分扇区，提供**1 000 ft** 超障余度（通常 25 NM 半径） |
| **Enroute MORA** | Enroute Minimum Off-Route Altitude | 航路最低偏航高度：航路中心线与定位点 **10 NM** 内；地形 ≤5 000 ft MSL 给 1 000 ft 余度，>5 000 ft MSL 给 2 000 ft |
| **Grid MORA** | Grid Minimum Off-Route Altitude | 网格最低偏航高度：网格内大数字 = **百英尺** + 下标 = 十英尺（`7₂` = 7 200 ft）；**<10 000 ft 绿色，≥10 000 ft 绛红** |
| **AMA** | Area Minimum Altitude | 区域最低高度，主要在加拿大使用，含义近似 Grid MORA |

**高度后缀**：`T` = MOCA；`D` = DME/DME/IRU 的 MEA；`G` = RNAV/GPS 的 MEA（不低于 MOCA）。方向性高度会在航段上标注小箭头。

### 4.2 高度限制的标注方式

| 标注 | 含义 |
| --- | --- |
| 数字**上方**有横线 | **At or Above**（不低于） |
| 数字**下方**有横线 | **At or Below**（不高于） |
| **上下都有**横线 | **At**（必须正好等于） |
| 上下**两个数字**（或两行） | **Between**（区间） |
| **无**横线 | 参考/建议高度，非硬性限制 |

### 4.3 进近图上的高度术语

| 术语 | 含义 |
| --- | --- |
| **DA / DH** | 决断高度（MSL）/ 决断层高（AGL）——精密进近，到达即决断，**不在此高度平飞** |
| **MDA / MDH** | 最低下降高度（MSL）/ 最低下降高（AGL）——非精密进近，**先下降到 MDA 再平飞**至 MAP |
| **HAT** | 高于接地区高（Height Above Touchdown） |
| **HAA** | 高于机场标高（Height Above Airport），多用于盘旋进近 |
| **TCH** | 穿越跑道入口高（Threshold Crossing Height），下滑道在跑道入口处的高度 |
| **TDZE** | 接地区标高 |

---

## 5. 进近图（Approach Chart）结构

### 官方小节（顺序即阅读顺序）

Format → Heading → Communications → **Approach Briefing Information** → **MSA** → **Approach Planview**（含 RNAV 程序差异、Not-To-Scale 插图）→ Non-Precision Recommended Altitude Descent Table → **Approach Profile View** → Descent/Timing Conversion Table + **Lighting Box** + **Missed Approach Icons** → **Landing Minimums** → Chart Boundary Line Information

### 驾驶舱视角的四区划分

| 区域 | 内容 |
| --- | --- |
| **Briefing Strip（顶部简报条）** | 导航台频率、进近航向、FAF 高度、DA/MDA、失压（复飞）程序、特殊笔记 |
| **Plan View（平面图）** | 俯视图：航迹、定位点、过渡、障碍物、MSA 扇区 |
| **Profile View（剖面图）** | 侧视图：下降剖面、各点穿越高度、下滑角、复飞航迹、复飞爬升梯度 |
| **Minimums（最低标准表）** | 按航空器类别（A/B/C/D）与进近类型列出 DA/MDA、能见度/RVR |

### Plan View 关键元素

- **IAF** 初始进近定位点 · **IF** 中间定位点 · **FAF / FAP** 最后进近定位点/点 · **MAP** 复飞点 · **MAHF** 复飞等待定位点
- **粗实线** = 必须遵循的主航迹；**细线/虚线** = 过渡或次要航迹
- **DME 弧**：标注距台距离、飞行方向、弧的起始与终止点
- **过渡（Transition）**：从航路台/定位点到 IAF 的航路
- ⚠️ **马耳他十字是 FAA/AeroNav 的 FAF 标志，Jeppesen 不使用**——原稿把它当作通用标志需要修正

---

## 6. SID / STAR（SID/DP & STAR Chart Legend）

### 官方小节

Format → Heading → **Briefing Information** → **MSA** → Climb & Routing Instructions **Tabulated Text Box** → Graphic: Information Boxes / **Lost Communications Procedure** / **Speed Restrictions** / **Start & End Points** → Graphic

### 线型与强调

| 元素 | 含义 |
| --- | --- |
| **粗实线** | **多个过渡共用的公共航段**（common course） |
| **粗虚线** | **过渡航段**（transition track） |
| 程序标题中的导航台/定位点 | 以阴影框或大字体突出显示 |
| **速度限制** | 写在程序标题下方，或沿航迹标注 |
| **失压/失联程序** | 图中给出明确航迹与高度（原稿遗漏） |
| **起始点 / 终点** | 程序与跑道、航路的衔接处有专门标注 |
| **RNAV 程序** | 标明导航规范（如 RNAV 1、RNP 1） |

---

## 7. 其他常用符号速查

### 7.1 报告点与定位点

| 符号 | 含义 |
| --- | --- |
| **实心**三角形 / 星形 | **强制报告点**（Compulsory Reporting Point） |
| **空心**三角形 / 星形 | **非强制报告点** |
| **飞越点（fly-over）** | 必须飞越后才可转弯（原稿遗漏的第三类） |
| **星形（四角星）** | RNAV 航路点 |
| **三角形** | RNAV 航路点与航路交叉点的组合 |
| 定位点下方加注 | 强制气象报告点（须报告温度、风、结冰、颠簸等） |
| 定位点名（括号内为国别识别码） | 官方定位点名 |
| `[ABROC]` 方括号 | 数据库标识符，仅供参考，不可用于 ATC |
| `D` + 数值 | DME 定位点及其距台距离 |
| MCA / MRA 注记 | 定位点名下方的穿越/接收高度限制 |

*径向线与方位线约定*：VHF 径向线**从**导航台量出（from）；LF 方位线**指向**导航台（to）。

### 7.2 等待航线

**跑道形（racetrack）** 椭圆，中间标注**入航航迹**；非标准等待还标注**分钟数**（出航边时长）与限制高度/速度。

### 7.3 特殊使用空域

**紫色**圆形或多边形；**区内的类型字母**决定性质：

| 字母 | 含义 | 字母 | 含义 |
| --- | --- | --- | --- |
| `P` | 禁区 Prohibited | `R` | 限制区 Restricted |
| `D` | 危险区 Danger | `W` | 警告区 Warning |
| `A` | 警戒区 Alert | `T` | 训练区 Training |
| `C` | 注意区 Caution | `TRA` | 临时保留空域 |
| `TSA` | 临时隔离区 | `MOA` | 军事行动区 |

加拿大附加后缀：`(A)` 特技、`(S)` 滑翔、`(H)` 悬挂滑翔、`(T)` 训练、`(P)` 跳伞。点标记表示在某些图系中为**永久启用**。区域重叠时，重叠部分的外缘会连成一条线。

### 7.4 航路 / 航线

| 项目 | 含义 |
| --- | --- |
| **白字黑底代号（negative designator）** | 为区分而采用的反白标注（如中国 `W117`） |
| `AWY` | Airway 航路 |
| `A` / `B` / `G` / `GR` / `BR` | Amber 琥珀 / Blue 蓝 / Green 绿 / Gulf / Bahama-Bravo 航线 |
| `J` | Jet 喷气航路 |
| `H` / `HL` | 高空航路 |
| `L-`（后缀） | L/MF 航路 |
| `NAT` | 北大西洋有组织航迹结构 |
| `DOM` | 国内航路 |
| `ATS` | 未公布代号的指定航路 |
| `RNAV` / 海洋过渡航路 / 越顶高空航路 / 分流航路 | 各自的线型区分 |
| 里程断点 / 转弯点 | 航段里程或方向改变处 |

### 7.5 精度与卡片元素

- **磁差**：航路图在导航台与机场旁直接标注磁差数值，并由**罗盘玫瑰**体现；等磁差线属计划图/区域图要素。
- **地形与障碍物**：地形等高线、最高障碍物标高；程序图 To-Scale 区还会给出**灰色网格 MORA**。
- **进近灯光框与复飞图标**：进近图右侧的 Lighting Box 给出灯光构型、PAPI/VASI、**PCL（飞行员可控灯光）激活频率**等；复飞图标说明复飞转弯方向与爬升要求。

---

## 8. 待补核实项

以下原稿内容在本次核对的两份 PDF 中**未找到直接依据**，建议保留时标注来源：

1. 「带 `L`（圆圈）= 有灯光，圆圈表示飞行员可控灯光（PCL）」——PCL 通常出现在**进近图 Lighting Box**，机场是否带灯一般以灯光框或灯光符号表示；`L` 的具体含义需在 Airway Manual 的 `Lighting Box` 分节中确认。
2. 「带阴影的框 = 主用导航台」在**进近图**语境下的原文出处有待补（目前仅确认航路图语境的「航路组成部分」含义）。
3. 「紫色」限制区的具体色值与「禁飞区」措辞：Jeppesen 原文以**区内的类型字母**区分性质，颜色在不同图系中可能不同。
4. 「数字后加 T = MOCA」已确认正确，但仅限 **Jeppesen** 图系；FAA 图系用前缀 `*`，需在图例中注明差异。

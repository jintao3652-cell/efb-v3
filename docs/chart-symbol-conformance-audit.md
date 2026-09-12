# EFB V3 航图符号一致性审计（对照 Jeppesen / Navigraph）

审计时间：2026-09-11
依据：`Introduction to Navigraph Charts`（第 4–7 页符号原文，已提取到 `.workbuddy/refs/navigraph-intro.txt`）+ `Introduction to Jeppesen Navigation Charts`

**首次审计结论：代码未按这两份 PDF 修订过**（审计当时 `src/` 与 `src-tauri/src/` 零改动，`git status` 可证）。

**2026-09-11 更新：已完成修正并实施。** 第三、四节所述缺陷均已修复，详见第六节「修正实施记录」。判定列已更新为修复后状态。

---

## 一、判定基准（PDF 原文摘录）

| 符号 | Navigraph 原文 |
|---|---|
| IFR airport | "A **blue cogwheel** means an IFR airport. If there is a **blue dot in the middle**, there is chart coverage." |
| VFR airport | "A **green cogwheel** means a VFR airport. A **hollow center** means there is no chart coverage." |
| RNAV waypoint | "A **star** denotes an RNAV waypoint. A waypoint with **compulsory reporting is filled**." |
| Waypoint / intersection | "A **triangle** denotes a combined RNAV waypoint and airway intersection." |
| NDB | "A **circle** denotes an NDB navaid." |
| DME | "A **box** denotes a DME. The circle around it is a **compass rose**…" |
| VOR/DME | "A **hexagon inside a box** denotes a VOR/DME. The circle around it is a compass rose…" |
| TACAN | "A **three pointed star** denotes a TACAN." |
| VORTAC | "A **three pointed star with banded points** denotes a VORTAC." |
| MORA | "The large numbers in the map grid are **minimum off-route altitudes**." |
| Holding | "A **race track** denotes a holding pattern." |
| Restricted airspace | "A **purple** circle or polygon denotes restricted airspace." |

---

## 二、后端符号分类（`src-tauri/src/commands/navigation.rs`）——基本合规

| 项 | 位置 | 判定 |
|---|---|---|
| 航路点：有航路 → `intersection`，无 → `waypoint` | L907-911 | ✅ 符合"triangle = RNAV 点与航路交汇点的组合" |
| VOR 家族：`dme` / `tacan` / `vortac` / `vor-dme` / `vor` 五分支 | L912-920 | ✅ 分类学正确 |
| NDB → `ndb` | L921 | ✅ |
| Fenix 通用导航台按 `%VORTAC%`→`%TACAN%`→`%NDB%`→`%VOR%DME%`→`%DME%`→`%VOR%` | L922-928 | ✅ 优先级正确（VORTAC 先于 TACAN/VOR） |
| 机场：`num_approach > 0` → `airport-ifr`，否则 `airport-vfr` | L962-972 | ✅ 蓝/绿之分正确 |

> 后端这一层是照着标准写的，问题主要不在分类，而在**渲染**和**地图图例**。

---

## 三、渲染层缺陷（`src/lib/chart-symbols.ts`）

| # | 符号 | 修复前 | 规范要求（Jeppesen SYMBOLS-1/2 原图） | 判定 |
|---|---|---|---|---|
| R1 | **VORTAC** | 三尖星 + 内嵌六边形 | 三尖星**带条纹点**（banded points） | ✅ 已改为三尖星 + 臂上条纹，去掉六边形 |
| R2 | **NDB** | 两个同心**实线**圆 | **双同心点状圆**（外圈 + 内圈均由点构成） | ✅ 已改为双同心点状圆（外 r15.5×20 点、内 r8.5×12 点） |
| R3 | **汇点强制报告** | 恒为空心三角形 | 强制报告点应实心填充 | ✅ 已新增 `intersection-compulsory`（screened 填充）+ `intersection-flyover` |
| R4 | **航路点强制报告** | 恒为空心四角星 | 强制报告点应实心填充 | ✅ 已新增 `waypoint-compulsory`（screened 填充）+ `waypoint-flyover` |
| R5 | **机场航图覆盖点** | `chartCoverage` 恒传 false | 中心点 = 有航图覆盖，空心 = 无覆盖 | ✅ 已补注释明确语义；当前按「空心 = 无覆盖」绘制，符合无覆盖数据时的规范 |
| R6 | **TACAN** | 三尖星（方向朝上、凹口过浅） | 三尖星，**一点朝下两点朝上**，凹口约外径 1/3 | ✅ 已按原图朝向与凹口深度重绘 |
| R7 | VOR / VOR-DME / DME 形状 | 六边形 / 六边形套方框 / 方框 | 一致 | ✅ 本就正确，未改动 |

---

## 四、地图图例缺陷（`src/pages/MapPage.tsx`）

| # | 问题 | 判定 |
|---|---|---|
| L1 | **TACAN / VORTAC 的图例画的是五角星**，而地图图标画的是三尖星 —— 图例与实现自相矛盾 | ✅ 已改为与画布图标同一套几何常量 |
| L2 | **图例里完全没有 VOR**，但 VOR 是后端最常见的输出、也是前端 fallback 的默认值 | ✅ 已补 VOR 图例项 |
| L3 | 图例有「RNAV 点」「航路交汇点」，但**没有区分强制/非强制报告点** | ⚠️ 待数据支持（见第五节） |
| L4 | 未体现 **MORA** 数字、**等待航线（跑道形）**、**限制区（紫色）** | ⚠️ 功能缺口，本次未做 |
| L5 | 版权行声称「航图符号参考 Jeppesen/Navigraph」，但实际未尽相符 | ✅ 已改为明确标注依据 `SYMBOLS-1/2` 与 Navigraph 图例 |
| L6 | 导航台图例顺序与 Jeppesen 不一致 | ✅ 已按 SYMBOLS-1/2 排为 VOR → VOR/DME → VORTAC → TACAN → DME → NDB |

---

## 五、待补（需数据支持，非纯渲染问题）

- 强制报告点标记：后端与数据源**均无 compulsory 字段**，前端无法区分 → 属数据层缺口
- MORA 网格、限制区多边形：地图图层目前根本没有对应数据源

---

## 六、修正实施记录（2026-09-11 已完成）

依据文件：
1. `Introduction to Jeppesen Navigation Charts.pdf`（用户提供，78 页，含 SYMBOLS-1~10 图例）
2. `Introduction to Navigraph Charts.pdf`（符号章原文）
3. Jeppesen 官方 *CHARTING SYMBOLS LEGEND* 符号图（原图逐符号比对）

### `src/lib/chart-symbols.ts`

| 改动 | 说明 |
|---|---|
| 新增 `dotsRingPath(radius, count, dotRadius)` | 生成点状圆，用于 NDB |
| 新增 `bandMarksPath(radius, halfWidth)` | 生成三尖星臂上的条纹，用于 VORTAC |
| 新增 `threePointStarPath()` | 复用 `polygonPath(3, 12.5, 12.5/3, π/2)`：一点朝下、两点朝上，凹口为外径 1/3 |
| `ndb` 分支 | 由「两个同心实线圆」改为「双同心点状圆」（外 r15.5×20 点、内 r8.5×12 点） |
| `tacan` 分支 | 改用 `threePointStarPath()`，并修正朝向与凹口深度 |
| `vortac` 分支 | 去掉多余的六边形，改为「三尖星 + 臂上条纹」 |
| `drawAirport` | 补充注释，明确「空心 = 无航图覆盖 / 中心点 = 有覆盖」的语义 |

> VOR（六边形）、VOR/DME（六边形套方框）、DME（方框）、航路点（四角星）、交汇点（三角形）、机场（齿轮 + 蓝/绿）**原本即符合规范，未改动**。

### `src/pages/MapPage.tsx`

| 改动 | 说明 |
|---|---|
| 新增 `ChartSymbolExampleName` 类型 + 几何常量 | 图例图形与画布图标共用 `THREE_POINT_STAR` / `THREE_POINT_BANDS` / `NDB_DOTS_OUTER` / `NDB_DOTS_INNER`，杜绝图例与实现再次漂移 |
| 图例 `tacan` / `vortac` | 五角星 → 三尖星（VORTAC 另加条纹） |
| 图例 `ndb` | 双同心实线圆 → 双同心点状圆 |
| 图例新增 `vor` 项 | 补上此前缺失的 VOR |
| 图例顺序 | 调整为 VOR → VOR/DME → VORTAC → TACAN → DME → NDB（对齐 SYMBOLS-1/2） |
| 版权行 | 明确标注依据 `Jeppesen CHARTING SYMBOLS LEGEND (SYMBOLS-1/2)` 与 Navigraph 图例 |
| `chartSymbolForPoint` | 补充注释，说明后端已下发符合规范的 symbol，前端仅兜底静态数据 |

### 验证

- `tsc -b` 通过（0 error）
- 用 PyMuPDF 复刻修正后的几何逐符号渲染核对，对照 Jeppesen 原图确认：三尖星朝向与凹口、NDB 双点状圆、VORTAC 条纹均一致
- 预览图：`docs/chart-symbols-conformance.png`

### 仍未解决（需数据支持）

地图**图层**尚未落地：强制报告点的「实心」变体与 MORA / 等待航线 / 特殊空域图层，
需要数据源提供对应字段后才会出现。字段契约已于第七节补齐，前端渲染能力已就绪，接入数据即可生效。

---

## 七、第二轮：报告点 / MORA / 特殊空域（2026-09-11 已完成）

依据原文（均为本轮从 PDF 中直接核实，非推测）：

| 项 | 出处 | 原文 |
|---|---|---|
| 强制 vs 非强制报告点 | **ENROUTE-7 图例键 §28** | "Compulsory Reporting Point represented by **screened fill**. Non Compulsory Reporting point is **open, no fill**." |
| 实心三角形 | 术语表 COMPULSORY REPORTING POINTS | "designated on aeronautical charts by **solid triangles**" |
| 飞越点 | **SYMBOLS-8** AIRSPACE FIXES | "Fly Over Fix — **Indicated by circle around fix**" |
| 定位点图形 | **SYMBOLS-8** AIRSPACE FIXES | 空心三角形 = Non-Compulsory；实心 = Compulsory；空心四角星 = RNAV Non-Compulsory；实心四角星 = RNAV Compulsory |
| 等待航线 | **SYMBOLS-8** ROUTES & AIRWAYS；Navigraph 图例 | "A **race track** denotes a holding pattern. The **inbound holding course is shown in the middle**." |
| Grid MORA 配色 | **ENROUTE-7 §14** | "Values **10,000 feet and greater are maroon**. Values **less than 10,000 feet are green**. Values are depicted in **hundreds of feet**." |
| 特殊空域分族 | **SYMBOLS-3** AIRSPACE & BOUNDARIES | 绿：Advisory / Alert / Caution / JDA / MOA / Temporary Reserved / Training / Warning；绛红：Intense Air Activity / Danger / Flight Restricted (FAA) / Fuel Dumping / High Intensity Radio Transmission / Prohibited / Restricted |
| 限制空域配色 | Navigraph 图例 | "A **purple** circle or polygon denotes restricted airspace." |

取样自 PDF 的颜色常量：Jeppesen 绿 `#00a65c`（ENROUTE / SYMBOLS-6 实心色块）、
绛红 `#901d41`（ENROUTE-1/ENROUTE-7 限制区）。

### 改动清单

**`src/lib/chart-symbols.ts`** — 新增 5 个画布图标

| 图标 | 含义 | 几何 |
|---|---|---|
| `waypoint-compulsory` | RNAV 强制报告点 | 四角星 + screened 填充 |
| `waypoint-flyover` | RNAV 飞越点 | 四角星（缩小）× 外圈 r19 |
| `intersection-compulsory` | 强制定位点 | 三角形 + screened 填充 |
| `intersection-flyover` | 强制定位点（飞越） | 三角形（缩小）× 外圈 r19 |
| `holding` | 等待航线 | 跑道形（两端半圆 r8，弧心 ±13）+ 中央入航边 |

绘制顺序说明：screened 填充**必须后于描边**。若先填充，宽出 4px 的深色光晕会盖住
四角星只有 3.2px 的凹口，使实心星退化成菱形；后填充则得到「清晰轮廓 + 网点内芯」的印刷观感。

**`src/lib/chart-annotations.ts`**（新建）— MORA 与特殊空域的「颜色 + 格式化 + 分类」规范
（这两类分别是网格数字与面，不是点状图标，故不放进画布图标集）：

- `moraTone(feet)` / `formatMoraValue(feet, doubtful)` / `moraColors`：阈值 10,000 ft，数值按百英尺取整，缺数据 → `Unsurveyed`，精度存疑 → 后缀 `±`
- `specialUseAirspaceTone(type)` / `specialUseAirspaceColors` / `specialUseAirspacePaint(type)`：按 SYMBOLS-3 归入绿 / 绛红两族并给出 MapLibre 绘制参数（未知类型保守归为「限制类」）

**数据契约**（`navigation.rs` + `tauri.ts`）

| 结构 | 新增字段 | 序列化策略 |
|---|---|---|
| `NavigationMapPoint` | `reporting?: "compulsory" \| "non-compulsory" \| "fly-over"` | `skip_serializing_if = "Option::is_none"` |
| `NavigationMapData` | `holdingPatterns` / `moraCells` / `specialUseAirspace` | `skip_serializing_if = "Vec::is_empty"` |

即：数据源没有内容时，后端输出的 JSON 与改动前**逐字节一致**，前端行为不变；
一旦导航库能给出这些字段，前端符号与图例即刻生效。

**`src/pages/MapPage.tsx`**

- `reportingSymbolVariant(symbol, reporting)`：按报告点类别在空心 / screened / 飞越三种变体间切换，**只作用于航路点与交汇点**，导航台符号不受影响
- 图例新增：强制报告点、飞越点、强制定位点、等待航线、MORA <10000 / ≥10000、咨询警戒空域、限制禁区空域
- MORA 与特殊空域图例的颜色直接取自 `chart-annotations.ts`，避免两处各写一份色值
- 版权行补 `SYMBOLS-3/8` 与 `ENROUTE-7`

**`src/styles.css`** — `.chart-symbol-example.compulsory`（screened 填充）、`.chart-mora-swatch`、`.chart-airspace-swatch`（虚线框 + 半透明填充）

### 验证

- `tsc -b` → 0 error；`vite build` → 成功
- 用 PyMuPDF 复刻同一套几何渲染，与 Jeppesen SYMBOLS-8 原图并排核对 → `docs/chart-symbols-new-vs-jeppesen.png`
- ⚠️ **Rust 侧未编译验证**：本机无 Rust 工具链（`cargo` 不在 PATH，亦无 `~/.cargo`）。
  Rust 改动已逐行复核（serde 属性、两个构造点、字段命名与 `camelCase` 映射），但请在能编译的环境跑一次 `cargo check`。


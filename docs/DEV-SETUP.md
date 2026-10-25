# SkyBoard EFB 开发环境搭建指南（迁移到新电脑）

> 技术栈：Tauri 2 + React 19 + TypeScript + Vite 6 + Rust + MapLibre GL，支持 Windows 桌面端与 Android/iOS 移动端。
> 仓库：https://github.com/jintao3652-cell/efb-v3 （branch: main）

---

## 一、必装组件

| 组件 | 版本要求 | 当前开发机版本 | 说明 |
|---|---|---|---|
| **Node.js** | ≥ 20 | 22.22.2 | 含 npm 10.x，前端构建 |
| **Rust (rustup)** | ≥ 1.80 | 1.98.1 | `winget install Rustlang.Rustup` 或 https://rustup.rs |
| **Rust targets** | — | 见下方 | 桌面 + Android 交叉编译目标 |
| **Android Studio** | 任意较新版本 | — | 提供 Android SDK 与 JBR（JDK 17+） |
| **Android SDK** | API 34+ | `L:\Android-Flutter\Android\Sdk` | 需 Platform-Tools、Build-Tools、NDK |
| **Git** | 任意 | — | 拉取仓库 |
| **Visual Studio**（仅 Windows） | Build Tools 即可 | — | 需勾选 "使用 C++ 的桌面开发"（MSVC 链接器）与 Windows SDK |
| **Xcode**（仅 macOS，做 iOS 时） | 最新版 | — | iOS 只能在 Mac 上构建 |

### 1. Rust target 安装

```bash
rustup target add x86_64-pc-windows-msvc        # Windows 桌面
rustup target add aarch64-linux-android         # Android 真机 (arm64)
rustup target add armv7-linux-androideabi       # Android 32位
rustup target add i686-linux-android            # Android x86 模拟器
rustup target add x86_64-linux-android          # Android x86_64 模拟器
```

> ⚠️ 若 `rustup target add` 反复失败/状态损坏：删除 `%USERPROFILE%\.rustup\toolchains\<toolchain>\lib\rustlib\<target>` 残留目录，并从 `%USERPROFILE%\.rustup\` 下的 components manifest 里去掉对应 android 行后重装。

### 2. 环境变量（Android）

参考当前开发机配置（路径按新机器实际安装位置调整）：

```bat
setx ANDROID_HOME "L:\Android-Flutter\Android\Sdk"
setx JAVA_HOME    "L:\Android-Flutter\Android\Studio\jbr"
setx NDK_HOME     "L:\Android-Flutter\Android\Sdk\ndk\<版本号>"
```

`JAVA_HOME` 用 Android Studio 自带的 JBR 即可（JDK 17+），无需单独装 Java。

### 3. Tauri CLI

不用全局安装，项目 devDependencies 已含 `@tauri-apps/cli`，直接 `npm run tauri ...` 调用。

---

## 二、拉取与安装

```bash
git clone https://github.com/jintao3652-cell/efb-v3.git
cd efb-v3
npm install          # 前端依赖
cargo fetch          # （可选，首次构建也会自动拉）Rust 依赖
```

### Gradle 说明（Android）

- `src-tauri/gen/android/gradle/wrapper/gradle-wrapper.properties` 已改用**腾讯镜像**：
  `distributionUrl=https\://mirrors.cloud.tencent.com/gradle/gradle-8.14.3-bin.zip`
- **不要**在 `gradle.properties` 里配置 http 代理（原机器上代理挂掉导致下载失败过）。
- 若 `src-tauri/gen/` 未被提交（.gitignore 忽略了它），首次跑 Android 前执行：
  `npm run tauri android init` 重新生成，然后把 gradle-wrapper.properties 的 distributionUrl 再改成上面的腾讯镜像。

---

## 三、数据文件迁移（重要！）

代码从 GitHub 克隆即可，但**导航/航图数据不在仓库里**，需手工拷贝：

| 数据 | 新机器放置位置（建议保持相同相对结构） | 用途 |
|---|---|---|
| **NAIP 数据包**（一批 CSV，如 AD_HP.csv、AIRSPACE.csv 等） | 原机在 `桌面\游戏\飞行\2607\` | 机场/航路/班机航路（FLIGHT_AIRLINE_POINT.csv）解析 |
| **导航库** `ng_jeppesen_fwdfd_2610.s3db` | 原机在 `Downloads\2610-r003\` | DFD v2 / LNM / Fenix 航路点、导航台坐标查询 |
| **navigation-source.json** | `%APPDATA%\SkyBoard EFB\` | 记录导航库与 NAIP 包路径的配置（指向上面两个位置） |

配置文件内容示例（新机器改成本机实际路径）：

```json
{
  "navigation_db": "D:/navdata/ng_jeppesen_fwdfd_2610.s3db",
  "naip_dir": "D:/navdata/2607"
}
```

> ⚠️ 已知待办：`chart.rs::app_directory`（LOCALAPPDATA）与 `navigation.rs::app_directory`（APPDATA）仍用 Windows 环境变量，移动端构建时这两处需迁移到 Tauri 路径 API。

**运行期缓存**（可不迁移，会自动重建）：`%LOCALAPPDATA%\com.skyboard.efb\` 下的 chart-cache / airac-cache / weather-cache 等均为缓存，删了也没关系。

---

## 四、验证安装

```bash
npm run check              # TypeScript 类型检查
cargo test                 # Rust 单元测试（src-tauri 下运行，应有 21 个通过）
npm run tauri dev          # 桌面端开发运行（Windows）
npm run android            # Android 真机/模拟器开发
npm run android:build      # Android APK 构建
```

## 五、常见坑

1. **代理**：若 shell 里残留 `HTTP_PROXY=http://127.0.0.1:11365`（已失效），vite/cargo 会连不上网。启动时用：
   `env -u HTTP_PROXY -u HTTPS_PROXY npm run tauri dev`（Git Bash）或在系统环境变量里清掉。
2. **Gradle 下载慢/失败**：确认用腾讯镜像 distributionUrl，且 gradle.properties 无代理配置。
3. **首次 cargo build 慢**：约 450+ crate，正常 3~10 分钟；可配 `CARGO_HOME` 内使用国内 registry（`rsproxy` 等）加速。
4. **NAIP CSV 编码**：部分 CSV 为 GBK，Rust 侧已用 `encoding_rs` 处理，无需转换。
5. **前端图表服务**：Jepp 航图服务的地址与令牌写死在 `src-tauri/src/commands/jepp.rs`，换服务需改该文件重新打包。

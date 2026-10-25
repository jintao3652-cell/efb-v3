@echo off
chcp 936 >nul
setlocal EnableExtensions
title SkyBoard EFB - 测试启动器
cd /d "%~dp0"

set "PORT_DEV=1420"
set "PORT_PREVIEW=4173"

rem 航图服务：地址与令牌与 src-tauri/src/commands/jepp.rs 保持一致，
rem 只用于启动前的健康检查；容器环境可用同名环境变量覆盖。
if not defined JEPP_BASE set "JEPP_BASE=http://jepp.cnrpg.top:8773"
if not defined JEPP_TOKEN set "JEPP_TOKEN=admin123456"

call :banner

rem ---------------------------------------------------------------- 环境自检
where node >nul 2>nul
if errorlevel 1 (
  echo [x] 未找到 Node.js，请先安装 18 或更高版本并加入 PATH。
  goto :fail
)
for /f "delims=" %%v in ('node -v') do set "NODE_VER=%%v"
echo [OK] Node.js %NODE_VER%

if not exist "node_modules\" (
  echo [.] 首次运行，正在安装前端依赖（npm install）...
  call npm install
  if errorlevel 1 goto :fail
)
echo [OK] 前端依赖就绪

set "HAS_RUST=0"
where cargo >nul 2>nul
if not errorlevel 1 (
  set "HAS_RUST=1"
  for /f "delims=" %%v in ('cargo --version') do echo [OK] %%v
) else (
  echo [注] 未找到 Rust 工具链，桌面端和打包不可用，只能用浏览器调试模式。
)

rem 航图在线状态：走 JeppQuery 的 /health，看 4 个必需依赖是否真的能出图
call :jepp_probe
call :jepp_report
echo.

rem ---------------------------------------------------------------- 端口 1420
rem 上次没关掉的 dev server 会让 --strictPort 直接失败，先问一句。
rem 这段不能放进 call 子过程，set /p 在子过程里读不到输入。
netstat -ano | findstr /c:":%PORT_DEV% " | findstr /i "LISTENING" >nul 2>nul
if errorlevel 1 goto :port_ok

echo [注] 端口 %PORT_DEV% 已被占用（可能是上次没关掉的 dev server）。
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /c:":%PORT_DEV% " ^| findstr /i "LISTENING"') do echo      占用进程 PID: %%p
set "ANS="
set /p "ANS=    结束占用进程并继续？[Y/N] "
if /i not "%ANS%"=="Y" goto :port_skip
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /c:":%PORT_DEV% " ^| findstr /i "LISTENING"') do taskkill /f /pid %%p >nul 2>nul
rem ping 代替 timeout：Git Bash 的 GNU timeout 会抢占同名命令
ping -n 2 127.0.0.1 >nul
echo     已释放端口 %PORT_DEV%。
goto :port_ok

:port_skip
echo     保留占用进程，此时前端开发模式会因端口被占而启动失败。
:port_ok
echo.

rem ---------------------------------------------------------------- 菜单
:menu
echo 请选择运行方式：
echo   1  桌面端应用    Tauri dev（前端 + Rust 后端，全功能，推荐）
echo   2  浏览器预览    构建 dist 后 vite preview，端口 %PORT_PREVIEW%
echo   3  前端开发      vite dev，端口 %PORT_DEV%，改代码热更新
echo   4  打包安装包    tauri build，产出 msi / nsis
echo   5  静态检查      tsc -b + cargo check，不启动服务
echo   6  航图服务状态  查 /health，看在线与依赖可用性
echo   0  退出
echo.
set "MODE="
set /p "MODE=输入序号回车 [1]: "
if not defined MODE set "MODE=1"
echo.

if "%MODE%"=="0" goto :done
if "%MODE%"=="1" goto :desktop
if "%MODE%"=="2" goto :preview
if "%MODE%"=="3" goto :frontend
if "%MODE%"=="4" goto :bundle
if "%MODE%"=="5" goto :check
if "%MODE%"=="6" goto :jepp_status
echo [x] 没有这个选项。
echo.
goto :menu

rem ---------------------------------------------------------------- 1 桌面端
:desktop
if "%HAS_RUST%"=="0" (
  echo [x] 桌面端需要 Rust 工具链：https://rustup.rs
  echo.
  goto :menu
)
echo [.] 启动 Tauri（首次编译 Rust 约 1-3 分钟，之后秒级启动）
echo     关掉应用窗口或 Ctrl+C 结束进程
echo.
call :desktop_kill_app
call npx tauri dev
set "RC=%errorlevel%"
if not "%RC%"=="0" (
  echo.
  echo [!] Tauri 以退出码 %RC% 结束。最常见的原因是 cargo 编译期间往
  echo     src-tauri\target 写文件，Vite 的 watcher 撞上被链接器独占的 dll，
  echo     dev server 被打崩，于是报 beforeDevCommand terminated 这个错。
  echo     其次是上一次的 vite 或 skyboard-efb.exe 没退干净。
  echo.
  echo [.] 清理残留进程后自动重试一次，依赖已编译，这次通常秒起……
  call :desktop_kill_stale
  ping -n 2 127.0.0.1 >nul
  call npx tauri dev
  set "RC=%errorlevel%"
)
echo.
if not "%RC%"=="0" (
  echo [x] 两次都没起来。先把上面的报错整段发出来，或单独跑 npm run dev
  echo     看前端能不能正常启动。
  goto :fail
)
echo [OK] 桌面端运行结束。
pause
goto :done

rem 上一次没关干净的应用窗口会让 cargo 链接 skyboard-efb.exe 时报「拒绝访问」，
rem 启动前先结束它。端口 1420 那边已经单独问过用户了，这里不越权动。
:desktop_kill_app
taskkill /f /im skyboard-efb.exe >nul 2>nul
exit /b 0

rem 重试前把两类残留一起清掉：占着 1420 的进程会让 vite 的 --strictPort 直接失败。
:desktop_kill_stale
taskkill /f /im skyboard-efb.exe >nul 2>nul
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /c:":%PORT_DEV% " ^| findstr /i "LISTENING"') do taskkill /f /pid %%p >nul 2>nul
exit /b 0

rem ---------------------------------------------------------------- 2 浏览器预览
:preview
echo [.] 构建前端（tsc -b + vite build）...
call npm run build
if errorlevel 1 goto :fail
echo.
echo [.] 启动 vite preview：http://127.0.0.1:%PORT_PREVIEW%/
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep 4; Start-Process 'http://127.0.0.1:%PORT_PREVIEW%/'"
call npm run preview -- --port %PORT_PREVIEW% --strictPort
echo.
echo [OK] 预览服务已退出。
pause
goto :done

rem ---------------------------------------------------------------- 3 前端开发
:frontend
echo [.] 启动 vite dev：http://127.0.0.1:%PORT_DEV%/
echo     注意：这个模式没有 Rust 后端，航图、机位依赖 /jepp、/xapi 反代
echo     本地航图库、机位数据库等桌面端能力在这里用不了。
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep 4; Start-Process 'http://127.0.0.1:%PORT_DEV%/'"
call npm run dev -- --port %PORT_DEV% --strictPort
echo.
echo [OK] 开发服务器已退出。
pause
goto :done

rem ---------------------------------------------------------------- 4 打包
:bundle
if "%HAS_RUST%"=="0" (
  echo [x] 打包需要 Rust 工具链：https://rustup.rs
  echo.
  goto :menu
)
echo [.] 开始打包安装包（release 编译，大约 5-15 分钟）。
call npx tauri build
if errorlevel 1 goto :fail
echo.
echo [OK] 打包完成，输出目录：
echo      src-tauri\target\release\bundle\msi
echo      src-tauri\target\release\bundle\nsis
start "" explorer "src-tauri\target\release\bundle"
pause
goto :done

rem ---------------------------------------------------------------- 5 静态检查
:check
echo [.] TypeScript 类型检查...
call npm run check
if errorlevel 1 (
  echo [x] 类型检查未通过。
  goto :fail
)
echo [OK] 类型检查通过
echo.
if "%HAS_RUST%"=="0" (
  echo [注] 跳过 cargo check：没有 Rust 工具链。
  goto :done
)
echo [.] cargo check...
pushd src-tauri
cargo check
popd
if errorlevel 1 (
  echo [x] cargo check 未通过。
  goto :fail
)
echo [OK] cargo check 通过
echo.
pause
goto :menu

rem ---------------------------------------------------------------- 6 航图服务状态
:jepp_status
echo [.] 查询 %JEPP_BASE%/health ...
call :jepp_probe
call :jepp_report
echo.
pause
goto :menu

rem ================================================================ 子过程
rem 航图健康检查：解析 /health 的 status / ready / essential / checks。
rem 结果放进 JEPP_STATE，附带的两个数字/文本放进 JEPP_N1、JEPP_N2。
rem   OK|航图数|机场数             服务就绪
rem   DEGRADED|缺失的依赖          服务在线但必需依赖不可用
rem   AUTH|状态码                  令牌被拒
rem   HTTP|状态码                  其他非 200
rem   DOWN|                       连不上
rem 只让 PowerShell 输出 ASCII，中文提示都留在 bat 里，避免代码页乱码。
:jepp_probe
set "JEPP_STATE="
set "JEPP_N1="
set "JEPP_N2="
where powershell >nul 2>nul
if errorlevel 1 (
  echo [注] 没有 PowerShell，跳过航图健康检查。
  goto :eof
)
for /f "usebackq tokens=1,2,3 delims=|" %%a in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; try { $h = Invoke-RestMethod -Uri '%JEPP_BASE%/health?token=%JEPP_TOKEN%' -TimeoutSec 8; $bad = @(); foreach ($k in $h.essential) { if (-not $h.checks.$k.ok) { $bad += $k } }; $charts = 0; $airports = 0; if ($h.checks.catalog) { $charts = $h.checks.catalog.charts; $airports = $h.checks.catalog.airports }; if ($bad.Count -eq 0 -and $h.status -eq 'ok') { 'OK|' + $charts + '|' + $airports } elseif ($bad.Count -gt 0) { 'DEGRADED|' + ($bad -join ',') } else { 'DEGRADED|' + $h.status } } catch { $code = 0; if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }; if ($code -eq 401 -or $code -eq 403) { 'AUTH|' + $code } elseif ($code -ne 0) { 'HTTP|' + $code } else { 'DOWN|' } }"`) do (
  set "JEPP_STATE=%%a"
  set "JEPP_N1=%%b"
  set "JEPP_N2=%%c"
)
goto :eof

:jepp_report
if "%JEPP_STATE%"=="OK" (
  echo [OK] 航图服务在线 %JEPP_N1% 份航图 / %JEPP_N2% 座机场
  goto :eof
)
if "%JEPP_STATE%"=="DEGRADED" (
  echo [!] 航图服务降级：必需依赖不可用 ^(%JEPP_N1%^)
  echo     服务进程在跑，但航图可能渲染失败，去 JeppQuery 目录查 TCLs / tcl2emf.exe / 字体。
  goto :eof
)
if "%JEPP_STATE%"=="AUTH" (
  echo [!] 航图服务在线，但令牌被拒（HTTP %JEPP_N1%）
  echo     对照 nginx 的 token 与 src-tauri/src/commands/jepp.rs，或用 JEPP_TOKEN 覆盖。
  goto :eof
)
if "%JEPP_STATE%"=="HTTP" (
  echo [!] 航图服务返回 HTTP %JEPP_N1%，服务异常。
  goto :eof
)
echo [!] 航图服务不可达：%JEPP_BASE%
echo     航图页会提示加载失败，其余页面不受影响。
goto :eof

:banner
echo ============================================================
echo   SkyBoard EFB - 测试启动器
echo   目录: %CD%
echo   ----------------------------------------------
echo   1 桌面端应用   2 浏览器预览   3 前端开发
echo   4 打包安装包   5 静态检查     6 航图服务状态   0 退出
echo ============================================================
echo.
goto :eof

:fail
echo.
echo [x] 出错了，原因见上面的提示。
echo.
pause
goto :done

:done
echo.
echo 已结束。
endlocal

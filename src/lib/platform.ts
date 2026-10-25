/**
 * 运行平台判定。
 *
 * 桌面端（Windows）与移动端（Android / iOS App）都是 Tauri 壳，`__TAURI_INTERNALS__`
 * 都存在；区别在 WebView 的 User-Agent：
 *   - Android System WebView 带 "Android"
 *   - iOS WKWebView 带 "iPhone" / "iPad" / "iPod"
 * 浏览器预览（npm run dev 直接开网页）没有 `__TAURI_INTERNALS__`。
 */

const MOBILE_UA = /Android|iPhone|iPad|iPod|Mobile/i;

/** WebView / 浏览器的 User-Agent 是否为移动设备。 */
export function isMobileUA(): boolean {
  return MOBILE_UA.test(navigator.userAgent);
}

/** 是否跑在 Tauri 壳里（桌面 + 移动端都算）。 */
export function isTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

/** 桌面 Tauri 壳（Windows 包）。 */
export function isDesktopApp(): boolean {
  return isTauriRuntime() && !isMobileUA();
}

/** 移动端 Tauri 壳（安卓 APK / iOS App）。 */
export function isMobileApp(): boolean {
  return isTauriRuntime() && isMobileUA();
}

/**
 * 能否弹系统目录选择框。桌面端走系统文件对话框；移动端插件只支持选文件，
 * 不支持选目录（Android SAF / iOS 文件 App 都没有"选目录给 App 常驻读"的形态）。
 */
export function supportsFolderPicker(): boolean {
  return !isMobileApp();
}

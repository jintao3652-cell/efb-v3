//! JeppQuery 航图服务代理。
//!
//! 服务地址与访问令牌是**内置配置**，只存在于这一层：前端只传相对路径
//! （`/api/v1/charts/ZBAA`、`/health`），Rust 侧再拼上域名与 `?token=`。
//! 因此 JS 产物里既没有地址也没有令牌，浏览器网络面板也看不到请求地址——
//! 要换服务或轮换令牌，只能重新发包。
//!
//! 两个入口：
//!   `jepp_get`       JSON / 文本接口（机场总览、航图目录、健康检查……）
//!   `jepp_chart_pdf` 单张航图 PDF，落盘缓存后返回本地路径（前端走 asset: 协议）

use serde::Serialize;
use std::{
    collections::hash_map::DefaultHasher,
    fs,
    hash::{Hash, Hasher},
    path::PathBuf,
    sync::OnceLock,
    time::Duration,
};
use tauri::{AppHandle, Manager};

/// 内置服务地址：nginx 反代，强制校验 `?token=`。
const JEPP_BASE: &str = "http://jepp.cnrpg.top:8773";
/// 内置访问令牌：与 nginx 侧一起轮换，改完重新打包。
const JEPP_TOKEN: &str = "admin123456";

/// 航图渲染是同步任务，PDF 端点上偶尔要等 10s 以上，超时给宽一点。
const JSON_TIMEOUT_SECS: u64 = 45;
const PDF_TIMEOUT_SECS: u64 = 90;

const BROWSER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JeppResponse {
    status: u16,
    content_type: String,
    body: String,
}

/// 共享 HTTP 客户端：连接池跨请求复用（TLS 会话、TCP 连接不重建），
/// 连续翻航图时省掉每次几十到上百毫秒的建连开销。
/// 超时不用 Client 默认值，改在单个请求上用 `.timeout()` 设置（JSON 与 PDF 不同）。
static HTTP: OnceLock<reqwest::Client> = OnceLock::new();

fn http() -> reqwest::Client {
    HTTP.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(BROWSER_AGENT)
            .pool_idle_timeout(Duration::from_secs(90))
            .pool_max_idle_per_host(4)
            .tcp_nodelay(true)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
    .clone()
}

fn base_url() -> Result<reqwest::Url, String> {
    reqwest::Url::parse(JEPP_BASE).map_err(|_| "内置航图服务地址无效".to_string())
}

/// 拼出带令牌的完整地址。只接受站内相对路径，`path` 可以自带查询串。
fn endpoint(path: &str) -> Result<reqwest::Url, String> {
    let relative = path.trim();
    if !relative.starts_with('/') || relative.contains("://") {
        return Err("航图接口路径无效".to_string());
    }
    let mut url = reqwest::Url::parse(&format!("{}{relative}", JEPP_BASE.trim_end_matches('/')))
        .map_err(|_| "航图接口路径无效".to_string())?;
    if !JEPP_TOKEN.is_empty() {
        url.query_pairs_mut().append_pair("token", JEPP_TOKEN);
    }
    Ok(url)
}

/// 用 path segment 逐段拼地址，让 `Url` 负责百分号编码（DBF 文件名可能带空格/符号）。
fn endpoint_segments(segments: &[&str]) -> Result<reqwest::Url, String> {
    let mut url = base_url()?;
    {
        let mut path = url
            .path_segments_mut()
            .map_err(|_| "内置航图服务地址无效".to_string())?;
        path.clear();
        for segment in segments {
            path.push(segment);
        }
    }
    if !JEPP_TOKEN.is_empty() {
        url.query_pairs_mut().append_pair("token", JEPP_TOKEN);
    }
    Ok(url)
}

/// 把服务端状态码翻成人话，前端直接展示。
fn status_message(status: u16) -> String {
    match status {
        401 | 403 => "航图服务令牌校验失败".to_string(),
        404 => "服务上没有该资源".to_string(),
        502 => "航图渲染失败：缺少 tcl2emf.exe 或 Jeppesen 字体".to_string(),
        503 => "渲染队列已满，稍后重试".to_string(),
        other => format!("航图服务返回 {other}"),
    }
}

fn send_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "航图服务响应超时".to_string()
    } else {
        "无法连接航图服务，请检查网络".to_string()
    }
}

/// JSON / 文本接口。非 2xx 也原样返回状态码，让前端区分 404 / 令牌失效。
#[tauri::command]
pub async fn jepp_get(path: String) -> Result<JeppResponse, String> {
    let target = endpoint(&path)?;
    let response = http()
        .get(target)
        .timeout(Duration::from_secs(JSON_TIMEOUT_SECS))
        .header(
            reqwest::header::ACCEPT,
            "application/json, text/plain, */*",
        )
        .send()
        .await
        .map_err(send_error)?;

    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/json")
        .to_string();
    let body = response.text().await.map_err(|_| "读取接口响应失败".to_string())?;

    Ok(JeppResponse {
        status,
        content_type,
        body,
    })
}

fn pdf_cache_directory(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?
        .join("jepp-chart-cache");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory)
}

/// 文件名是 DBF 里的不透明哈希，但依然要挡住路径穿越。
fn safe_filename(filename: &str) -> Result<String, String> {
    let name = filename.trim();
    if name.is_empty()
        || name.len() > 200
        || name.contains('/')
        || name.contains('\\')
        || name.contains("..")
        || name.chars().any(|character| character.is_control())
    {
        return Err("航图文件名无效".to_string());
    }
    Ok(name.to_string())
}

fn normalized_icao(icao: &str) -> Result<String, String> {
    let code = icao.trim().to_uppercase();
    let valid = code.len() == 4 && code.chars().all(|character| character.is_ascii_alphabetic());
    valid
        .then_some(code)
        .ok_or_else(|| "机场四字码无效".to_string())
}

fn cache_name(icao: &str, filename: &str) -> String {
    let mut hasher = DefaultHasher::new();
    icao.hash(&mut hasher);
    filename.hash(&mut hasher);
    format!("{:x}.pdf", hasher.finish())
}

/// 下载 PDF 字节。抽出来是为了能在测试里单独跑一遍（不依赖 AppHandle）。
async fn download_pdf(url: reqwest::Url) -> Result<Vec<u8>, String> {
    let response = http()
        .get(url)
        .timeout(Duration::from_secs(PDF_TIMEOUT_SECS))
        .header(reqwest::header::ACCEPT, "application/pdf, */*")
        .send()
        .await
        .map_err(send_error)?;

    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        // 401/403/404 的响应体是 HTML/纯文本，读出来也没用，直接给状态说明。
        return Err(status_message(status));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|_| "读取航图文件失败".to_string())?;
    if bytes.len() < 1024 {
        return Err("航图内容为空，渲染可能失败".to_string());
    }
    Ok(bytes.to_vec())
}

/// 取单张航图 PDF：命中缓存直接给路径，否则下载后落盘再返回。
///
/// 返回的是本地绝对路径，前端用 `convertFileSrc` 转成 `asset:` 地址交给
/// PDF 查看器，整条链路都不经过 WebView 的网络栈。
#[tauri::command]
pub async fn jepp_chart_pdf(
    app: AppHandle,
    icao: String,
    filename: String,
) -> Result<String, String> {
    let code = normalized_icao(&icao)?;
    let file = safe_filename(&filename)?;
    let target = pdf_cache_directory(&app)?.join(cache_name(&code, &file));

    if let Ok(meta) = fs::metadata(&target) {
        // 上次下载被中断会留下 0 字节文件，当作未缓存重下。
        if meta.len() > 1024 {
            return Ok(target.to_string_lossy().to_string());
        }
        let _ = fs::remove_file(&target);
    }

    let url = endpoint_segments(&["api", "v1", "charts", &code, "export", &file])?;
    let bytes = download_pdf(url).await?;

    // 先写临时文件再改名：中途断开不会留下半截 PDF 被当成缓存。
    let staging = target.with_extension("part");
    fs::write(&staging, &bytes).map_err(|error| error.to_string())?;
    if fs::rename(&staging, &target).is_err() {
        // Windows 上目标已存在时 rename 会失败（并发下载同一张图），
        // 此时缓存已经是完好的，丢掉临时文件即可。
        let _ = fs::remove_file(&staging);
        if !target.is_file() {
            return Err("保存航图缓存失败".to_string());
        }
    }

    Ok(target.to_string_lossy().to_string())
}

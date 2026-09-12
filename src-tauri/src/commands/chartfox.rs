use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    fs,
    sync::{Mutex, OnceLock},
    time::Duration,
};
use tauri::{AppHandle, Manager};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartFoxChart {
    pub id: String,
    pub title: String,
    pub chart_type: String,
    pub url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartFoxAsset {
    pub path: String,
    pub media_type: String,
}

static CHART_URLS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

fn safe_chart_id(value: &str) -> Option<String> {
    let normalized = value.trim().to_uppercase();
    if normalized.is_empty()
        || !normalized.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '-' || character == '_'
        })
    {
        return None;
    }
    Some(normalized)
}

fn chartfox_asset_kind(bytes: &[u8]) -> Option<(&'static str, &'static str)> {
    if bytes.starts_with(b"%PDF-") {
        return Some(("pdf", "application/pdf"));
    }
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some(("png", "image"));
    }
    if bytes.starts_with(b"\xff\xd8\xff") {
        return Some(("jpg", "image"));
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some(("gif", "image"));
    }
    if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        return Some(("webp", "image"));
    }
    None
}

fn string_value(item: &Value, keys: &[&str]) -> String {
    keys.iter()
        .find_map(|key| item.get(*key).and_then(Value::as_str))
        .unwrap_or_default()
        .to_string()
}

fn normalize_chartfox_url(value: String) -> String {
    if value.starts_with('/') {
        format!("https://chartfox.org{value}")
    } else {
        value
    }
}

#[tauri::command]
pub async fn list_chartfox_charts(icao: String) -> Result<Vec<ChartFoxChart>, String> {
    let icao = icao.trim().to_uppercase();
    if icao.len() != 4
        || !icao
            .chars()
            .all(|character| character.is_ascii_alphabetic())
    {
        return Err("请输入四位 ICAO 机场代码".to_string());
    }
    let url = format!("https://chartfox.org/api/charts/{icao}");
    let response = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent("SkyBoard-EFB/1.0")
        .build()
        .map_err(|_| "无法创建 ChartFox 请求".to_string())?
        .get(url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                "ChartFox 请求超时".to_string()
            } else {
                "无法连接 ChartFox 服务".to_string()
            }
        })?;
    if !response.status().is_success() {
        return Err(format!("ChartFox 服务返回 HTTP {}", response.status()));
    }
    let payload: Value = response
        .json()
        .await
        .map_err(|_| "ChartFox 返回的数据不是有效 JSON".to_string())?;
    let charts = payload
        .get("charts")
        .and_then(Value::as_array)
        .or_else(|| payload.as_array())
        .ok_or_else(|| "ChartFox 数据格式无效".to_string())?;
    let charts = charts
        .iter()
        .enumerate()
        .map(|(index, item)| ChartFoxChart {
            id: string_value(item, &["id", "chart_id", "uuid"])
                .if_empty_then(format!("{icao}-{index}")),
            title: string_value(item, &["name", "title", "chart_name"])
                .if_empty_then("未命名航图".to_string()),
            chart_type: string_value(item, &["type", "chart_type", "category"]),
            url: normalize_chartfox_url(string_value(
                item,
                &["url", "pdf_url", "image_url", "chart_url"],
            )),
        })
        .collect::<Vec<_>>();
    if let Ok(mut urls) = CHART_URLS.get_or_init(|| Mutex::new(HashMap::new())).lock() {
        for chart in &charts {
            if let Some(chart_id) = safe_chart_id(&chart.id).filter(|_| !chart.url.is_empty()) {
                urls.insert(format!("{icao}:{chart_id}"), chart.url.clone());
            }
        }
    }
    Ok(charts)
}

#[tauri::command]
pub async fn open_chartfox_chart(
    app: AppHandle,
    icao: String,
    chart_id: String,
) -> Result<ChartFoxAsset, String> {
    let icao = icao.trim().to_uppercase();
    if icao.len() != 4
        || !icao
            .chars()
            .all(|character| character.is_ascii_alphabetic())
    {
        return Err("ChartFox 机场代码无效".to_string());
    }
    let chart_id = safe_chart_id(&chart_id).ok_or_else(|| "ChartFox 航图 ID 无效".to_string())?;
    let source_url = CHART_URLS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .ok()
        .and_then(|urls| urls.get(&format!("{icao}:{chart_id}")).cloned())
        .ok_or_else(|| "ChartFox 航图链接已失效，请刷新列表".to_string())?;
    let url = reqwest::Url::parse(&source_url).map_err(|_| "ChartFox 航图链接无效".to_string())?;
    if url.scheme() != "https" || url.host_str().is_none() {
        return Err("ChartFox 航图链接不受支持".to_string());
    }
    let directory = app
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?
        .join("chartfox-chart-cache");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    for (extension, media_type) in [
        ("pdf", "application/pdf"),
        ("png", "image"),
        ("jpg", "image"),
        ("gif", "image"),
        ("webp", "image"),
    ] {
        let path = directory.join(format!("{chart_id}.{extension}"));
        if path.exists() {
            return Ok(ChartFoxAsset {
                path: path.to_string_lossy().to_string(),
                media_type: media_type.to_string(),
            });
        }
    }
    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(25))
        .user_agent("SkyBoard-EFB/1.0")
        .build()
        .map_err(|_| "无法创建 ChartFox 航图请求".to_string())?
        .get(url)
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                "ChartFox 航图下载超时".to_string()
            } else {
                "无法下载 ChartFox 航图".to_string()
            }
        })?
        .error_for_status()
        .map_err(|error| {
            format!(
                "ChartFox 航图返回 HTTP {}",
                error.status().map_or(0, |status| status.as_u16())
            )
        })?;
    let bytes = response
        .bytes()
        .await
        .map_err(|_| "无法读取 ChartFox 航图".to_string())?;
    let (extension, media_type) = chartfox_asset_kind(&bytes)
        .ok_or_else(|| "ChartFox 当前仅提供网页链接，请使用外部查看".to_string())?;
    let path = directory.join(format!("{chart_id}.{extension}"));
    fs::write(&path, bytes).map_err(|error| error.to_string())?;
    Ok(ChartFoxAsset {
        path: path.to_string_lossy().to_string(),
        media_type: media_type.to_string(),
    })
}

trait EmptyThen {
    fn if_empty_then(self, fallback: String) -> String;
}

impl EmptyThen for String {
    fn if_empty_then(self, fallback: String) -> String {
        if self.is_empty() {
            fallback
        } else {
            self
        }
    }
}

use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf, time::Duration};
use tauri::{AppHandle, Manager};

const NOTAM_LIMIT: usize = 10;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotamItem {
    id: i64,
    #[serde(default)]
    number: String,
    #[serde(default)]
    source: String,
    q_code: Option<String>,
    #[serde(default)]
    valid_from_utc: String,
    valid_until_utc: Option<String>,
    schedule: Option<String>,
    #[serde(default)]
    validity_state: String,
    #[serde(default)]
    is_effective_now: bool,
    #[serde(default)]
    display_text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotamReport {
    station: String,
    notams: Vec<NotamItem>,
    policy: String,
    cached: bool,
}

#[derive(Debug, Deserialize)]
struct AtisViewMeta {
    #[serde(default)]
    policy: String,
}

#[derive(Debug, Deserialize)]
struct AtisViewResponse {
    success: bool,
    #[serde(default)]
    meta: Option<AtisViewMeta>,
    #[serde(default)]
    notams: Vec<NotamItem>,
}

fn notam_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36 SkyBoard-EFB/1.0")
        .build()
        .map_err(|_| "无法创建 NOTAM 请求".to_string())
}

fn cache_path(app: &AppHandle, station: &str) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?
        .join("notam-cache");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join(format!("{station}.json")))
}

fn read_cached_notams(app: &AppHandle, station: &str) -> Option<NotamReport> {
    let path = cache_path(app, station).ok()?;
    let mut report = serde_json::from_slice::<NotamReport>(&fs::read(path).ok()?).ok()?;
    report.cached = true;
    Some(report)
}

fn write_cached_notams(app: &AppHandle, report: &NotamReport) -> Result<(), String> {
    let path = cache_path(app, &report.station)?;
    let temporary = path.with_extension("json.tmp");
    fs::write(
        &temporary,
        serde_json::to_vec(report).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    if path.exists() {
        fs::remove_file(&path).map_err(|error| error.to_string())?;
    }
    fs::rename(temporary, path).map_err(|error| error.to_string())
}

async fn live_notams(station: &str) -> Result<NotamReport, String> {
    let client = notam_client()?;
    let url = reqwest::Url::parse_with_params(
        "https://atisview.com/api/v1/notams",
        [("icao", station), ("limit", &NOTAM_LIMIT.to_string())],
    )
    .map_err(|_| "无法创建 ATISView NOTAM 请求".to_string())?;
    let response = client
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::REFERER, "https://atisview.com/")
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                "ATISView NOTAM 请求超时".to_string()
            } else {
                "无法连接 ATISView NOTAM 服务".to_string()
            }
        })?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("ATISView NOTAM 返回错误：{}", status.as_u16()));
    }
    let payload = response
        .json::<AtisViewResponse>()
        .await
        .map_err(|_| "ATISView NOTAM 数据格式无效".to_string())?;
    if !payload.success {
        return Err("ATISView NOTAM 服务未返回有效数据".to_string());
    }
    let mut notams = payload.notams;
    notams.sort_by_key(|notam| !notam.is_effective_now);
    Ok(NotamReport {
        station: station.to_string(),
        notams,
        policy: payload.meta.map(|meta| meta.policy).unwrap_or_default(),
        cached: false,
    })
}

#[tauri::command]
pub async fn get_notams(app: AppHandle, station: String) -> Result<NotamReport, String> {
    let station = station.trim().to_uppercase();
    if station.len() != 4
        || !station
            .chars()
            .all(|character| character.is_ascii_alphabetic())
    {
        return Err("请输入四位 ICAO 机场代码".to_string());
    }
    match live_notams(&station).await {
        Ok(report) => {
            let _ = write_cached_notams(&app, &report);
            Ok(report)
        }
        Err(error) => read_cached_notams(&app, &station).ok_or(error),
    }
}

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{
    fs,
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

const API_ROOT: &str = "https://api.xflysim.com/pilot/api/efb";

#[derive(Debug, Deserialize)]
struct ApiResponse<T> {
    data: T,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AirportGate {
    pub id: i64,
    pub gate_ref: String,
    pub gate_type: String,
    pub latitude: f64,
    pub longitude: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AirportFrequency {
    pub id: String,
    pub airport_ident: String,
    pub description: String,
    #[serde(rename = "frequencyType", alias = "type")]
    pub frequency_type: String,
    pub frequency_mhz: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AirportRunway {
    pub id: String,
    pub airport_ident: String,
    pub le_ident: String,
    pub he_ident: String,
    pub length_ft: String,
    pub width_ft: String,
    pub surface: String,
    pub le_latitude_deg: String,
    pub le_longitude_deg: String,
    pub he_latitude_deg: String,
    pub he_longitude_deg: String,
    pub closed: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AirportChart {
    pub id: String,
    pub index_number: String,
    pub name: String,
    pub category: String,
    pub revision_date: String,
    pub image_day_url: String,
    pub image_night_url: String,
    pub thumb_day_url: String,
    pub thumb_night_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XflyAirportData {
    pub gates: Vec<AirportGate>,
    pub frequencies: Vec<AirportFrequency>,
    pub runways: Vec<AirportRunway>,
    pub charts: Vec<AirportChart>,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub unavailable: Vec<String>,
    #[serde(default)]
    pub cached: bool,
}

fn cache_path(app: &AppHandle, icao: &str) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?
        .join("airport-cache");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join(format!("{icao}.json")))
}

fn thumbnail_cache_path(
    app: &AppHandle,
    chart_id: &str,
    revision_date: &str,
) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?
        .join("chart-thumbnails");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let revision = revision_date
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect::<String>();
    Ok(directory.join(format!("{chart_id}-{revision}.png")))
}

fn supported_chart_image(bytes: &[u8]) -> bool {
    bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        || bytes.starts_with(b"\xff\xd8\xff")
        || bytes.starts_with(b"GIF87a")
        || bytes.starts_with(b"GIF89a")
        || bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP")
}

fn read_cache(app: &AppHandle, icao: &str) -> Option<XflyAirportData> {
    serde_json::from_slice(&fs::read(cache_path(app, icao).ok()?).ok()?).ok()
}

fn write_cache(app: &AppHandle, icao: &str, data: &XflyAirportData) -> Result<(), String> {
    let path = cache_path(app, icao)?;
    let temporary = path.with_extension("json.tmp");
    fs::write(
        &temporary,
        serde_json::to_vec(data).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    if path.exists() {
        fs::remove_file(&path).map_err(|error| error.to_string())?;
    }
    fs::rename(temporary, path).map_err(|error| error.to_string())
}

async fn fetch_endpoint<T: DeserializeOwned>(
    client: &reqwest::Client,
    endpoint: &str,
    icao: &str,
) -> Result<T, String> {
    let url = format!("{API_ROOT}/{endpoint}/{icao}");
    let mut last_error = format!("{endpoint} 请求失败");
    for _ in 0..2 {
        match client.get(&url).send().await {
            Ok(response) => match response.error_for_status() {
                Ok(response) => {
                    return response
                        .json::<ApiResponse<T>>()
                        .await
                        .map(|response| response.data)
                        .map_err(|_| format!("{endpoint} 数据格式无效"))
                }
                Err(error) => {
                    last_error = format!(
                        "{endpoint} 返回 {}",
                        error
                            .status()
                            .map(|status| status.as_u16().to_string())
                            .unwrap_or_else(|| "错误".to_string())
                    )
                }
            },
            Err(error) => {
                last_error = if error.is_timeout() {
                    format!("{endpoint} 请求超时")
                } else {
                    format!("{endpoint} 无法连接")
                }
            }
        }
    }
    Err(last_error)
}

#[tauri::command]
pub async fn get_xfly_chart_thumbnail(
    app: AppHandle,
    chart_id: String,
    revision_date: String,
    source_urls: Vec<String>,
) -> Result<String, String> {
    let chart_id = chart_id.trim().to_uppercase();
    if chart_id.is_empty()
        || !chart_id.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '-' || character == '_'
        })
    {
        return Err("航图 ID 无效".to_string());
    }

    let target = thumbnail_cache_path(&app, &chart_id, &revision_date)?;
    if target.exists() {
        return Ok(target.to_string_lossy().to_string());
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent("SkyBoard-EFB/1.0")
        .build()
        .map_err(|_| "无法创建航图图片请求".to_string())?;

    for source_url in source_urls {
        let Ok(url) = reqwest::Url::parse(&source_url) else {
            continue;
        };
        if url.scheme() != "https" {
            continue;
        }
        let Some(host) = url.host_str() else {
            continue;
        };
        if host != "vip.123pan.cn" && !host.ends_with(".123clouddisk.com") {
            continue;
        }

        let Ok(response) = client.get(url).send().await else {
            continue;
        };
        let Ok(response) = response.error_for_status() else {
            continue;
        };
        let Ok(bytes) = response.bytes().await else {
            continue;
        };
        if !supported_chart_image(&bytes) {
            continue;
        }

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let temporary = target.with_extension(format!("png.{nonce}.tmp"));
        fs::write(&temporary, &bytes).map_err(|error| error.to_string())?;
        match fs::rename(&temporary, &target) {
            Ok(()) => return Ok(target.to_string_lossy().to_string()),
            Err(_) if target.exists() => {
                let _ = fs::remove_file(&temporary);
                return Ok(target.to_string_lossy().to_string());
            }
            Err(error) => {
                let _ = fs::remove_file(&temporary);
                return Err(error.to_string());
            }
        }
    }

    Err("航图缩略图与完整图均不可用".to_string())
}

#[tauri::command]
pub async fn get_xfly_airport_data(
    app: AppHandle,
    icao: String,
    prefer_cache: Option<bool>,
) -> Result<XflyAirportData, String> {
    let icao = icao.trim().to_uppercase();
    if icao.len() != 4
        || !icao
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
    {
        return Err("ICAO 机场代码无效".to_string());
    }
    if prefer_cache.unwrap_or(false) {
        if let Some(mut data) = read_cache(&app, &icao) {
            data.source = "XFlySim 本地缓存".to_string();
            data.cached = true;
            return Ok(data);
        }
        return Ok(XflyAirportData {
            gates: Vec::new(),
            frequencies: Vec::new(),
            runways: Vec::new(),
            charts: Vec::new(),
            source: "离线且没有 XFlySim 缓存".to_string(),
            unavailable: vec![
                "机位".to_string(),
                "频率".to_string(),
                "跑道".to_string(),
                "航图".to_string(),
            ],
            cached: false,
        });
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .user_agent("SkyBoard-EFB/1.0")
        .build()
        .map_err(|_| "无法创建 XFlySim 请求".to_string())?;
    let cached_data = read_cache(&app, &icao);
    let (gates_result, frequencies_result, runways_result, charts_result) = tokio::join!(
        fetch_endpoint(&client, "gates", &icao),
        fetch_endpoint(&client, "frequency", &icao),
        fetch_endpoint(&client, "runway", &icao),
        fetch_endpoint(&client, "charts", &icao),
    );
    let successful_requests = [
        gates_result.is_ok(),
        frequencies_result.is_ok(),
        runways_result.is_ok(),
        charts_result.is_ok(),
    ]
    .into_iter()
    .filter(|success| *success)
    .count();
    let mut unavailable = Vec::new();
    let mut used_cache = false;
    let gates = match gates_result {
        Ok(value) => value,
        Err(_) => {
            unavailable.push("机位".to_string());
            used_cache = cached_data.is_some();
            cached_data
                .as_ref()
                .map(|data| data.gates.clone())
                .unwrap_or_default()
        }
    };
    let frequencies = match frequencies_result {
        Ok(value) => value,
        Err(_) => {
            unavailable.push("频率".to_string());
            used_cache |= cached_data.is_some();
            cached_data
                .as_ref()
                .map(|data| data.frequencies.clone())
                .unwrap_or_default()
        }
    };
    let runways = match runways_result {
        Ok(value) => value,
        Err(_) => {
            unavailable.push("跑道".to_string());
            used_cache |= cached_data.is_some();
            cached_data
                .as_ref()
                .map(|data| data.runways.clone())
                .unwrap_or_default()
        }
    };
    let charts = match charts_result {
        Ok(value) => value,
        Err(_) => {
            unavailable.push("航图".to_string());
            used_cache |= cached_data.is_some();
            cached_data
                .as_ref()
                .map(|data| data.charts.clone())
                .unwrap_or_default()
        }
    };
    let source = if unavailable.is_empty() {
        "XFlySim 在线"
    } else if successful_requests == 0 && used_cache {
        "XFlySim 本地缓存"
    } else if used_cache {
        "XFlySim 在线 + 本地缓存"
    } else {
        "XFlySim 部分在线数据"
    };
    let result = XflyAirportData {
        gates,
        frequencies,
        runways,
        charts,
        source: source.to_string(),
        unavailable,
        cached: used_cache,
    };
    if successful_requests > 0 {
        let _ = write_cache(&app, &icao, &result);
    }
    Ok(result)
}

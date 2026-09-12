use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use std::{fs, path::PathBuf, time::Duration};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WeatherReport {
    station: String,
    raw: String,
    wind: String,
    visibility: String,
    temperature: String,
    qnh: String,
    observed_at: String,
    source: String,
    taf: String,
    preview_url: Option<String>,
}

fn weather_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .user_agent("SkyBoard-EFB/1.0")
        .build()
        .map_err(|_| "无法创建航空气象请求".to_string())
}

async fn fetch_json<T: DeserializeOwned>(
    client: &reqwest::Client,
    url: reqwest::Url,
    service: &str,
) -> Result<T, String> {
    let mut last_error = format!("无法连接 {service}");
    for _ in 0..2 {
        match client.get(url.clone()).send().await {
            Ok(response) => match response.error_for_status() {
                Ok(response) => {
                    return response
                        .json::<T>()
                        .await
                        .map_err(|_| format!("{service} 数据格式无效"))
                }
                Err(error) => {
                    last_error = format!(
                        "{service} 返回错误：{}",
                        error
                            .status()
                            .map(|status| status.as_u16().to_string())
                            .unwrap_or_else(|| "未知状态".to_string())
                    )
                }
            },
            Err(error) => {
                last_error = if error.is_timeout() {
                    format!("{service} 请求超时")
                } else {
                    format!("无法连接 {service}")
                }
            }
        }
    }
    Err(last_error)
}

fn cache_path(app: &AppHandle, station: &str) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?
        .join("weather-cache");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join(format!("{station}.json")))
}

fn read_cached_weather(app: &AppHandle, station: &str) -> Option<WeatherReport> {
    let path = cache_path(app, station).ok()?;
    let mut report = serde_json::from_slice::<WeatherReport>(&fs::read(&path).ok()?).ok()?;
    if !matches!(report.source.as_str(), "实时" | "OpenWeather") {
        let _ = fs::remove_file(path);
        return None;
    }
    report.source = "缓存".to_string();
    Some(report)
}

fn write_cached_weather(app: &AppHandle, report: &WeatherReport) -> Result<(), String> {
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

fn json_text(value: Option<&Value>) -> String {
    value
        .and_then(|item| {
            item.as_str()
                .map(ToOwned::to_owned)
                .or_else(|| item.as_i64().map(|number| number.to_string()))
                .or_else(|| item.as_f64().map(|number| number.round().to_string()))
        })
        .unwrap_or_default()
}

fn available(value: Option<&Value>) -> String {
    let result = json_text(value);
    if result.is_empty() || matches!(result.as_str(), "999998" | "999999") {
        "--".to_string()
    } else {
        result
    }
}

fn station_coordinates(station: &str) -> Option<(f64, f64)> {
    match station {
        "ZBAA" => Some((40.0801, 116.5846)),
        "ZSPD" => Some((31.1434, 121.8052)),
        "ZGGG" => Some((23.3924, 113.2990)),
        "ZSHC" => Some((30.2295, 120.4345)),
        _ => None,
    }
}

async fn openweather_report(
    client: &reqwest::Client,
    station: &str,
    api_key: &str,
) -> Result<WeatherReport, String> {
    let (latitude, longitude) = station_coordinates(station)
        .ok_or_else(|| "该机场尚未配置 OpenWeather 坐标".to_string())?;
    let url = reqwest::Url::parse(&format!("https://api.openweathermap.org/data/2.5/weather?lat={latitude}&lon={longitude}&units=metric&appid={api_key}")).map_err(|_| "无法创建 OpenWeather 请求".to_string())?;
    let payload: Value = fetch_json(client, url, "OpenWeather 服务").await?;
    let description = payload
        .get("weather")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .and_then(|item| item.get("description"))
        .and_then(Value::as_str)
        .unwrap_or("天气状况不可用");
    let wind_speed = payload
        .get("wind")
        .and_then(|item| item.get("speed"))
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let wind_direction = payload
        .get("wind")
        .and_then(|item| item.get("deg"))
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let visibility = payload
        .get("visibility")
        .and_then(Value::as_f64)
        .map(|value| format!("{:.1} km", value / 1000.0))
        .unwrap_or_else(|| "--".to_string());
    let temperature = payload
        .get("main")
        .and_then(|item| item.get("temp"))
        .and_then(Value::as_f64)
        .map(|value| format!("{value:.0}°C"))
        .unwrap_or_else(|| "--".to_string());
    let pressure = payload
        .get("main")
        .and_then(|item| item.get("pressure"))
        .and_then(Value::as_i64)
        .map(|value| format!("{value} hPa"))
        .unwrap_or_else(|| "--".to_string());
    Ok(WeatherReport {
        station: station.to_string(),
        raw: format!("OpenWeather · {description}"),
        wind: format!("{wind_direction:.0}° / {wind_speed:.1} m/s"),
        visibility,
        temperature,
        qnh: pressure,
        observed_at: "实时".to_string(),
        source: "OpenWeather".to_string(),
        taf: "OpenWeather 不提供航空例行天气预报。".to_string(),
        preview_url: None,
    })
}

async fn awc_weather_report(
    client: &reqwest::Client,
    station: &str,
) -> Result<WeatherReport, String> {
    let metar_url = reqwest::Url::parse_with_params(
        "https://aviationweather.gov/api/data/metar",
        [("ids", station), ("hours", "0"), ("format", "json")],
    )
    .map_err(|_| "无法创建 METAR 请求".to_string())?;
    let taf_url = reqwest::Url::parse_with_params(
        "https://aviationweather.gov/api/data/taf",
        [("ids", station), ("format", "json")],
    )
    .map_err(|_| "无法创建 TAF 请求".to_string())?;
    let metar_payload: Value = fetch_json(client, metar_url, "Aviation Weather METAR 服务").await?;
    let metar = metar_payload
        .as_array()
        .and_then(|items| items.first())
        .ok_or_else(|| "未找到该机场的 METAR".to_string())?;
    let taf = fetch_json::<Value>(client, taf_url, "Aviation Weather TAF 服务")
        .await
        .ok()
        .and_then(|payload| {
            payload
                .as_array()
                .and_then(|items| items.first())
                .and_then(|item| item.get("rawTAF"))
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .unwrap_or_else(|| "Aviation Weather 未返回 TAF。".to_string());
    let wind_direction = match json_text(metar.get("wdir")).as_str() {
        "" | "VRB" => "VRB".to_string(),
        value => format!("{value}°"),
    };
    let wind_speed = json_text(metar.get("wspd")).parse::<i64>().unwrap_or(0);
    let temperature = json_text(metar.get("temp"));
    let dewpoint = json_text(metar.get("dewp"));
    Ok(WeatherReport {
        station: station.to_string(),
        raw: metar
            .get("rawOb")
            .and_then(Value::as_str)
            .unwrap_or("原始 METAR 不可用")
            .to_string(),
        wind: format!("{wind_direction} / {wind_speed} kt"),
        visibility: available(metar.get("visib")),
        temperature: if temperature.is_empty() {
            "--".to_string()
        } else {
            format!(
                "{temperature}°C / {}°C",
                if dewpoint.is_empty() { "--" } else { &dewpoint }
            )
        },
        qnh: metar
            .get("altim")
            .and_then(Value::as_f64)
            .map(|value| format!("{value:.0} hPa"))
            .unwrap_or_else(|| "--".to_string()),
        observed_at: metar
            .get("reportTime")
            .and_then(Value::as_str)
            .unwrap_or("实时")
            .to_string(),
        source: "实时".to_string(),
        taf,
        preview_url: Some(format!(
            "https://metar-taf.com/site/preview-airport?id={station}&nightmode=false"
        )),
    })
}

async fn live_weather(station: &str) -> Result<WeatherReport, String> {
    let client = weather_client()?;
    let mut errors = Vec::new();
    match awc_weather_report(&client, station).await {
        Ok(report) => return Ok(report),
        Err(error) => errors.push(error),
    }
    if let Ok(api_key) = std::env::var("OPENWEATHER_API_KEY") {
        match openweather_report(&client, station, &api_key).await {
            Ok(report) => return Ok(report),
            Err(error) => errors.push(error),
        }
    }
    Err(format!("天气获取失败：{}", errors.join("；")))
}

#[tauri::command]
pub async fn get_weather(
    app: AppHandle,
    station: String,
    prefer_cache: Option<bool>,
) -> Result<WeatherReport, String> {
    let station = station.trim().to_uppercase();
    if station.len() != 4
        || !station
            .chars()
            .all(|character| character.is_ascii_alphabetic())
    {
        return Err("请输入四位 ICAO 机场代码".to_string());
    }
    if prefer_cache.unwrap_or(false) {
        return read_cached_weather(&app, &station)
            .ok_or_else(|| format!("当前离线，且没有 {station} 的天气缓存"));
    }
    match live_weather(&station).await {
        Ok(report) => {
            let _ = write_cached_weather(&app, &report);
            Ok(report)
        }
        Err(error) => read_cached_weather(&app, &station).ok_or(error),
    }
}

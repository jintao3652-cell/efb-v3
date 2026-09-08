use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Serialize)]
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

fn available(value: Option<&Value>) -> String {
    let result = value.and_then(|item| item.as_str().map(ToOwned::to_owned).or_else(|| item.as_i64().map(|number| number.to_string())).or_else(|| item.as_f64().map(|number| number.to_string()))).unwrap_or_else(|| "--".to_string());
    if result == "999998" || result == "999999" { "--".to_string() } else { result }
}

async fn nmc_weather_report(station: &str) -> Result<WeatherReport, String> {
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(12)).build().map_err(|_| "无法创建气象请求".to_string())?;
    let metar_url = format!("http://avimet.nmc.cn/hangkong/METAR/{station}.json");
    let taf_url = format!("http://avimet.nmc.cn/hangkong/TAF/{station}.json");
    let metar: Value = client.get(metar_url).send().await.map_err(|_| "无法连接中国气象局航空气象服务".to_string())?.error_for_status().map_err(|_| "中国气象局 METAR 服务返回错误".to_string())?.json().await.map_err(|_| "中国气象局 METAR 数据格式无效".to_string())?;
    let taf: Value = client.get(taf_url).send().await.map_err(|_| "无法连接中国气象局 TAF 服务".to_string())?.error_for_status().map_err(|_| "中国气象局 TAF 服务返回错误".to_string())?.json().await.map_err(|_| "中国气象局 TAF 数据格式无效".to_string())?;
    let wind_direction = available(metar.get("WIN_D"));
    let wind_speed = available(metar.get("WIN_S"));
    let visibility = available(metar.get("Vis_Hor"));
    let temperature = available(metar.get("TEM"));
    let qnh = available(metar.get("PRS_Sea"));
    let taf_summary = format!("TAF {station} 有效期 {} 至 {} · 风 {}°/{} m/s · 能见度 {} m · 云况 {}", available(taf.get("VALID_START_TIME")), available(taf.get("VALID_END_TIME")), available(taf.get("MEAN_WIND_DIRECTION")), available(taf.get("MEAN_WIND_SPEED")), available(taf.get("PREVAG_VISIBILITY")), available(taf.get("CLOUD_INFO")));
    Ok(WeatherReport { station: station.to_string(), raw: format!("METAR {station} {} {}° {} m/s VIS {} m T {}°C Q{} hPa", available(metar.get("time")), wind_direction, wind_speed, visibility, temperature, qnh), wind: format!("{wind_direction}° / {wind_speed} m/s"), visibility: if visibility == "--" { "--".to_string() } else { format!("{visibility} m") }, temperature: if temperature == "--" { "--".to_string() } else { format!("{temperature}°C") }, qnh: if qnh == "--" { "--".to_string() } else { format!("{qnh} hPa") }, observed_at: available(metar.get("time")), source: "中国气象局航空气象".to_string(), taf: taf_summary, preview_url: None })
}

fn station_coordinates(station: &str) -> Option<(f64, f64)> {
    match station { "ZBAA" => Some((40.0801, 116.5846)), "ZSPD" => Some((31.1434, 121.8052)), "ZGGG" => Some((23.3924, 113.2990)), "ZSHC" => Some((30.2295, 120.4345)), _ => None }
}

async fn openweather_report(station: &str, api_key: &str) -> Result<WeatherReport, String> {
    let (latitude, longitude) = station_coordinates(station).ok_or_else(|| "该机场尚未配置 OpenWeather 坐标".to_string())?;
    let url = format!("https://api.openweathermap.org/data/2.5/weather?lat={latitude}&lon={longitude}&units=metric&appid={api_key}");
    let payload: Value = reqwest::Client::new().get(url).send().await.map_err(|_| "OpenWeather 服务暂不可用".to_string())?.error_for_status().map_err(|_| "OpenWeather API Key 无效或服务暂不可用".to_string())?.json().await.map_err(|_| "OpenWeather 数据格式无效".to_string())?;
    let description = payload.get("weather").and_then(Value::as_array).and_then(|items| items.first()).and_then(|item| item.get("description")).and_then(Value::as_str).unwrap_or("天气状况不可用");
    let wind_speed = payload.get("wind").and_then(|item| item.get("speed")).and_then(Value::as_f64).unwrap_or(0.0);
    let wind_direction = payload.get("wind").and_then(|item| item.get("deg")).and_then(Value::as_f64).unwrap_or(0.0);
    let visibility = payload.get("visibility").and_then(Value::as_f64).map(|value| format!("{:.1} km", value / 1000.0)).unwrap_or_else(|| "--".to_string());
    let temperature = payload.get("main").and_then(|item| item.get("temp")).and_then(Value::as_f64).map(|value| format!("{value:.0}°C")).unwrap_or_else(|| "--".to_string());
    let pressure = payload.get("main").and_then(|item| item.get("pressure")).and_then(Value::as_i64).map(|value| format!("{value} hPa")).unwrap_or_else(|| "--".to_string());
    Ok(WeatherReport { station: station.to_string(), raw: format!("OpenWeather · {description}"), wind: format!("{wind_direction:.0}° / {wind_speed:.1} m/s"), visibility, temperature, qnh: pressure, observed_at: "实时".to_string(), source: "OpenWeather".to_string(), taf: "OpenWeather 不提供航空例行天气预报。".to_string(), preview_url: None })
}

async fn awc_weather_report(station: &str) -> Result<WeatherReport, String> {
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(12)).build().map_err(|_| "无法创建 Aviation Weather 请求".to_string())?;
    let metar_url = reqwest::Url::parse_with_params("https://aviationweather.gov/api/data/metar", [("ids", station), ("hours", "0"), ("format", "json")]).map_err(|_| "无法创建 METAR 请求".to_string())?;
    let taf_url = reqwest::Url::parse_with_params("https://aviationweather.gov/api/data/taf", [("ids", station), ("format", "json")]).map_err(|_| "无法创建 TAF 请求".to_string())?;
    let metar_payload: Value = client.get(metar_url).send().await.map_err(|_| "无法连接 Aviation Weather METAR 服务".to_string())?.error_for_status().map_err(|_| "Aviation Weather METAR 服务返回错误".to_string())?.json().await.map_err(|_| "Aviation Weather METAR 数据格式无效".to_string())?;
    let metar = metar_payload.as_array().and_then(|items| items.first()).ok_or_else(|| "未找到该机场的 METAR".to_string())?;
    let taf = match client.get(taf_url).send().await {
        Ok(response) => match response.error_for_status() {
            Ok(response) => match response.json::<Value>().await {
                Ok(payload) => payload.as_array().and_then(|items| items.first()).and_then(|item| item.get("rawTAF")).and_then(Value::as_str).unwrap_or("Aviation Weather 未返回 TAF。").to_string(),
                Err(_) => "Aviation Weather 未返回 TAF。".to_string(),
            },
            Err(_) => "Aviation Weather 未返回 TAF。".to_string(),
        },
        Err(_) => "Aviation Weather 未返回 TAF。".to_string(),
    };
    let raw = metar.get("rawOb").and_then(Value::as_str).unwrap_or("原始 METAR 不可用").to_string();
    Ok(WeatherReport { station: station.to_string(), raw, wind: format!("{}° / {} kt", metar.get("wdir").and_then(Value::as_i64).map(|value| value.to_string()).unwrap_or_else(|| "VRB".to_string()), metar.get("wspd").and_then(Value::as_i64).unwrap_or(0)), visibility: available(metar.get("visib")), temperature: format!("{}°C / {}°C", metar.get("temp").and_then(Value::as_f64).map(|value| value.round().to_string()).unwrap_or_else(|| "--".to_string()), metar.get("dewp").and_then(Value::as_f64).map(|value| value.round().to_string()).unwrap_or_else(|| "--".to_string())), qnh: metar.get("altim").and_then(Value::as_f64).map(|value| format!("{value:.0} hPa")).unwrap_or_else(|| "--".to_string()), observed_at: metar.get("reportTime").and_then(Value::as_str).unwrap_or("实时").to_string(), source: "实时".to_string(), taf, preview_url: Some(format!("https://metar-taf.com/site/preview-airport?id={station}&nightmode=false")) })
}

#[tauri::command]
pub async fn get_weather(station: String) -> Result<WeatherReport, String> {
    let station = station.trim().to_uppercase();
    if station.len() != 4 || !station.chars().all(|character| character.is_ascii_alphabetic()) { return Err("请输入四位 ICAO 机场代码".to_string()); }
    if station.starts_with('Z') {
        if let Ok(report) = nmc_weather_report(&station).await { return Ok(report); }
        if let Ok(api_key) = std::env::var("OPENWEATHER_API_KEY") { if let Ok(report) = openweather_report(&station, &api_key).await { return Ok(report); } }
    }
    awc_weather_report(&station).await
}

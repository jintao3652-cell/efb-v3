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
}

fn display_value(value: Option<&Value>) -> String {
    value.and_then(|item| item.as_str().map(ToOwned::to_owned).or_else(|| item.as_f64().map(|number| number.to_string()))).unwrap_or_else(|| "--".to_string())
}

#[tauri::command]
pub async fn get_weather(station: String) -> Result<WeatherReport, String> {
    let station = station.trim().to_uppercase();
    if station.len() != 4 || !station.chars().all(|character| character.is_ascii_alphabetic()) {
        return Err("请输入四位 ICAO 机场代码".to_string());
    }
    let url = format!("https://aviationweather.gov/api/data/metar?ids={station}&format=json&taf=false");
    let response = reqwest::Client::new().get(url).send().await.map_err(|_| "天气服务暂不可用".to_string())?;
    let payload: Value = response.json().await.map_err(|_| "天气数据格式无效".to_string())?;
    let item = payload.as_array().and_then(|items| items.first()).ok_or_else(|| "未找到该机场的 METAR".to_string())?;
    let raw = item.get("rawOb").and_then(Value::as_str).unwrap_or("原始 METAR 不可用").to_string();
    Ok(WeatherReport {
        station,
        raw,
        wind: format!("{}° / {} kt", item.get("wdir").and_then(Value::as_i64).map(|value| value.to_string()).unwrap_or_else(|| "VRB".to_string()), item.get("wspd").and_then(Value::as_i64).unwrap_or(0)),
        visibility: display_value(item.get("visib")),
        temperature: format!("{}°C / {}°C", item.get("temp").and_then(Value::as_f64).map(|value| value.round().to_string()).unwrap_or_else(|| "--".to_string()), item.get("dewp").and_then(Value::as_f64).map(|value| value.round().to_string()).unwrap_or_else(|| "--".to_string())),
        qnh: item.get("altim").and_then(Value::as_f64).map(|value| format!("{:.0} hPa", value * 33.8639)).unwrap_or_else(|| "--".to_string()),
        observed_at: item.get("obsTime").and_then(Value::as_i64).map(|timestamp| format!("Unix {timestamp}")).unwrap_or_else(|| "刚刚".to_string()),
        source: "实时".to_string(),
    })
}

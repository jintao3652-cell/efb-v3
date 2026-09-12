use serde_json::Value;
use std::time::Duration;

const OVERPASS_ENDPOINTS: [&str; 3] = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
];

fn validate_bounds(west: f64, south: f64, east: f64, north: f64) -> Result<(), String> {
    if !west.is_finite() || !south.is_finite() || !east.is_finite() || !north.is_finite() {
        return Err("OSM 查询范围无效".to_string());
    }
    if west < -180.0
        || east > 180.0
        || south < -85.0
        || north > 85.0
        || west >= east
        || south >= north
        || east - west > 0.17
        || north - south > 0.17
    {
        return Err("OSM 查询范围超出机场地面数据限制".to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn get_osm_airport_ground(
    west: f64,
    south: f64,
    east: f64,
    north: f64,
) -> Result<Value, String> {
    validate_bounds(west, south, east, north)?;
    let bbox = format!("{south:.3},{west:.3},{north:.3},{east:.3}");
    let query = format!(
        "[out:json][timeout:18];(way[\"aeroway\"=\"runway\"]({bbox});way[\"aeroway\"=\"taxiway\"]({bbox});way[\"aeroway\"=\"taxilane\"]({bbox});way[\"aeroway\"=\"apron\"]({bbox});way[\"aeroway\"=\"terminal\"]({bbox});way[\"building\"=\"terminal\"]({bbox});node[\"aeroway\"=\"parking_position\"]({bbox});node[\"aeroway\"=\"gate\"]({bbox}););out tags geom;"
    );
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(24))
        .user_agent("SkyBoard-EFB/1.0 (OpenStreetMap airport ground viewer)")
        .build()
        .map_err(|_| "无法创建 OSM 请求".to_string())?;
    let mut last_error = "OSM 机场地面数据加载失败".to_string();

    for endpoint in OVERPASS_ENDPOINTS {
        let response = match client
            .post(endpoint)
            .header(reqwest::header::ACCEPT, "application/json")
            .form(&[("data", query.as_str())])
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) => {
                last_error = if error.is_timeout() {
                    "OSM 服务请求超时".to_string()
                } else {
                    "无法连接 OSM 服务".to_string()
                };
                continue;
            }
        };
        if !response.status().is_success() {
            last_error = format!("OSM 服务返回错误：{}", response.status().as_u16());
            continue;
        }
        match response.json::<Value>().await {
            Ok(payload) if payload.get("elements").and_then(Value::as_array).is_some() => {
                return Ok(payload);
            }
            _ => last_error = "OSM 服务返回了无效数据".to_string(),
        }
    }

    Err(last_error)
}

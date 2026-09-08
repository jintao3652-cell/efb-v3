use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartFoxChart {
    pub id: String,
    pub title: String,
    pub chart_type: String,
    pub url: String,
}

fn string_value(item: &Value, keys: &[&str]) -> String {
    keys.iter().find_map(|key| item.get(*key).and_then(Value::as_str)).unwrap_or_default().to_string()
}

#[tauri::command]
pub async fn list_chartfox_charts(icao: String) -> Result<Vec<ChartFoxChart>, String> {
    let icao = icao.trim().to_uppercase();
    if icao.len() != 4 || !icao.chars().all(|character| character.is_ascii_alphabetic()) {
        return Err("请输入四位 ICAO 机场代码".to_string());
    }
    let url = format!("https://chartfox.org/api/charts/{icao}");
    let response = reqwest::Client::builder().timeout(std::time::Duration::from_secs(15)).build().map_err(|_| "无法创建 ChartFox 请求".to_string())?.get(url).header("Accept", "application/json").send().await.map_err(|_| "无法连接 ChartFox 服务".to_string())?;
    if !response.status().is_success() {
        return Err(format!("ChartFox 服务返回 HTTP {}", response.status()));
    }
    let payload: Value = response.json().await.map_err(|_| "ChartFox 返回的数据不是有效 JSON".to_string())?;
    let charts = payload.get("charts").and_then(Value::as_array).or_else(|| payload.as_array()).ok_or_else(|| "ChartFox 数据格式无效".to_string())?;
    Ok(charts.iter().enumerate().map(|(index, item)| ChartFoxChart {
        id: string_value(item, &["id", "chart_id", "uuid"]).if_empty_then(format!("{icao}-{index}")),
        title: string_value(item, &["name", "title", "chart_name"]).if_empty_then("未命名航图".to_string()),
        chart_type: string_value(item, &["type", "chart_type", "category"]),
        url: string_value(item, &["url", "pdf_url", "image_url", "chart_url"]),
    }).collect())
}

trait EmptyThen {
    fn if_empty_then(self, fallback: String) -> String;
}

impl EmptyThen for String {
    fn if_empty_then(self, fallback: String) -> String {
        if self.is_empty() { fallback } else { self }
    }
}

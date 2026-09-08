use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
struct NavigraphCycle {
    cycle_id: String,
    cycle_status: String,
    cycle_start_date: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiracCycle {
    pub cycle_id: String,
    pub cycle_start_date: String,
    pub provider: String,
}

#[tauri::command]
pub async fn get_current_airac_cycle() -> Result<AiracCycle, String> {
    let cycles: Vec<NavigraphCycle> = reqwest::Client::new()
        .get("https://fmsdata.api.navigraph.com/v3/cycles")
        .send()
        .await
        .map_err(|_| "无法连接 Navigraph AIRAC 服务".to_string())?
        .error_for_status()
        .map_err(|_| "Navigraph AIRAC 服务返回错误".to_string())?
        .json()
        .await
        .map_err(|_| "Navigraph AIRAC 数据格式无效".to_string())?;
    let cycle = cycles.into_iter().find(|item| item.cycle_status == "current").ok_or_else(|| "Navigraph 未返回当前 AIRAC 周期".to_string())?;
    Ok(AiracCycle { cycle_id: cycle.cycle_id, cycle_start_date: cycle.cycle_start_date, provider: "Navigraph FMS Data".to_string() })
}

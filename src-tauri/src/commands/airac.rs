use serde::{Deserialize, Serialize};
use std::{fs, time::Duration};
use tauri::{AppHandle, Manager};

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
struct NavigraphCycle {
    cycle_id: String,
    cycle_status: String,
    cycle_start_date: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiracCycle {
    pub cycle_id: String,
    pub cycle_start_date: String,
    pub provider: String,
}

fn read_cached_cycle(app: &AppHandle) -> Option<AiracCycle> {
    let path = app
        .path()
        .app_local_data_dir()
        .ok()?
        .join("airac-cache/current.json");
    let mut cycle = serde_json::from_slice::<AiracCycle>(&fs::read(path).ok()?).ok()?;
    cycle.provider = format!("{}（缓存）", cycle.provider.trim_end_matches("（缓存）"));
    Some(cycle)
}

fn write_cached_cycle(app: &AppHandle, cycle: &AiracCycle) -> Result<(), String> {
    let directory = app
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?
        .join("airac-cache");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    fs::write(
        directory.join("current.json"),
        serde_json::to_vec(cycle).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

async fn fetch_current_cycle() -> Result<AiracCycle, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .user_agent("SkyBoard-EFB/1.0")
        .build()
        .map_err(|_| "无法创建 Navigraph AIRAC 请求".to_string())?;
    let cycles: Vec<NavigraphCycle> = client
        .get("https://fmsdata.api.navigraph.com/v3/cycles")
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                "Navigraph AIRAC 请求超时".to_string()
            } else {
                "无法连接 Navigraph AIRAC 服务".to_string()
            }
        })?
        .error_for_status()
        .map_err(|_| "Navigraph AIRAC 服务返回错误".to_string())?
        .json()
        .await
        .map_err(|_| "Navigraph AIRAC 数据格式无效".to_string())?;
    let cycle = cycles
        .into_iter()
        .find(|item| item.cycle_status == "current")
        .ok_or_else(|| "Navigraph 未返回当前 AIRAC 周期".to_string())?;
    Ok(AiracCycle {
        cycle_id: cycle.cycle_id,
        cycle_start_date: cycle.cycle_start_date,
        provider: "Navigraph FMS Data".to_string(),
    })
}

#[tauri::command]
pub async fn get_current_airac_cycle(app: AppHandle) -> Result<AiracCycle, String> {
    match fetch_current_cycle().await {
        Ok(cycle) => {
            let _ = write_cached_cycle(&app, &cycle);
            Ok(cycle)
        }
        Err(error) => read_cached_cycle(&app).ok_or(error),
    }
}

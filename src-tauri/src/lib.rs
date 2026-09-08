mod commands;

use commands::{cache_chart_pdf, clear_chart_cache, get_current_airac_cycle, get_weather, import_simbrief_flight, list_chartfox_charts, list_flight_plans, save_flight_plan};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![list_flight_plans, save_flight_plan, get_weather, clear_chart_cache, cache_chart_pdf, get_current_airac_cycle, import_simbrief_flight, list_chartfox_charts])
        .run(tauri::generate_context!())
        .expect("failed to run SkyBoard EFB");
}

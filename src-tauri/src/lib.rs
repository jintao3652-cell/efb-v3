mod commands;

use commands::{
    cache_chart_pdf, clear_chart_cache, get_current_airac_cycle, get_local_chart_library_status,
    get_navigation_airport_details, get_navigation_airport_procedures,
    get_navigation_database_status, get_navigation_map_data, get_navigation_procedure_points,
    get_navigation_runway_threshold, get_weather, get_xfly_airport_data, get_xfly_chart_thumbnail,
    get_notams, import_simbrief_flight, list_chartfox_charts, list_flight_plans, list_local_charts,
    open_local_chart, save_flight_plan, search_navigation_airports, set_local_chart_library,
    set_navigation_database,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            list_flight_plans,
            save_flight_plan,
            get_weather,
            get_notams,
            clear_chart_cache,
            cache_chart_pdf,
            get_current_airac_cycle,
            import_simbrief_flight,
            list_chartfox_charts,
            get_navigation_database_status,
            set_navigation_database,
            search_navigation_airports,
            get_navigation_airport_details,
            get_navigation_airport_procedures,
            get_navigation_procedure_points,
            get_navigation_runway_threshold,
            get_navigation_map_data,
            get_local_chart_library_status,
            set_local_chart_library,
            list_local_charts,
            open_local_chart,
            get_xfly_airport_data,
            get_xfly_chart_thumbnail
        ])
        .run(tauri::generate_context!())
        .expect("failed to run SkyBoard EFB");
}

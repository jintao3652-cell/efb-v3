mod commands;

use commands::{
    api_proxy, cache_chart_pdf, clear_chart_cache, get_current_airac_cycle, get_local_chart_library_status,
    get_navigation_airport_details, get_navigation_airport_procedures,
    get_navigation_database_status, get_navigation_map_data, get_navigation_procedure_points,
    get_navigation_runway_threshold, get_navigation_runway_ends, get_notams, get_osm_airport_ground, get_weather, get_xfly_airport_data,
    get_xfly_chart_image, get_xfly_chart_thumbnail, import_simbrief_flight, jepp_chart_pdf, jepp_get,
    get_local_airports, get_naip_route_points, get_naip_status,
    list_chartfox_charts,
    list_flight_plans, list_local_charts, list_navigraph_charts, open_chartfox_chart,
    open_local_chart, save_flight_plan, search_flight_routes, search_navigation_airports,
    set_local_chart_library,
    set_navigation_database,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            api_proxy,
            jepp_get,
            jepp_chart_pdf,
            list_flight_plans,
            save_flight_plan,
            get_weather,
            get_notams,
            get_osm_airport_ground,
            clear_chart_cache,
            cache_chart_pdf,
            get_current_airac_cycle,
            import_simbrief_flight,
            list_chartfox_charts,
            open_chartfox_chart,
            get_navigation_database_status,
            set_navigation_database,
            search_navigation_airports,
            get_navigation_airport_details,
            get_navigation_airport_procedures,
            get_navigation_procedure_points,
            get_navigation_runway_threshold,
            get_navigation_runway_ends,
            get_navigation_map_data,
            get_local_chart_library_status,
            set_local_chart_library,
            list_local_charts,
            open_local_chart,
            get_xfly_airport_data,
            get_xfly_chart_thumbnail,
            get_xfly_chart_image,
            list_navigraph_charts,
            get_local_airports,
            search_flight_routes,
            get_naip_status,
            get_naip_route_points
        ])
        .run(tauri::generate_context!())
        .expect("failed to run SkyBoard EFB");
}

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlightPlan {
    pub id: String,
    pub callsign: String,
    pub departure: String,
    pub arrival: String,
    pub alternate: Option<String>,
    pub route: String,
    pub aircraft: String,
    pub cruise_altitude: String,
    pub etd: String,
    pub status: String,
    pub updated_at: String,
    pub imported_at: String,
}

fn data_directory() -> Result<PathBuf, String> {
    let directory = std::env::var("APPDATA").map(PathBuf::from).map_err(|_| "无法找到 Windows AppData 目录".to_string())?.join("SkyBoard EFB");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory)
}

fn connection() -> Result<Connection, String> {
    let database = data_directory()?.join("skyboard.db");
    let connection = Connection::open(database).map_err(|error| error.to_string())?;
    connection.execute_batch("CREATE TABLE IF NOT EXISTS flight_plans (id TEXT PRIMARY KEY, callsign TEXT NOT NULL, departure TEXT NOT NULL, arrival TEXT NOT NULL, alternate TEXT, route TEXT NOT NULL, aircraft TEXT NOT NULL, cruise_altitude TEXT NOT NULL, etd TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL, imported_at TEXT NOT NULL DEFAULT '');").map_err(|error| error.to_string())?;
    let has_imported_at = {
        let mut columns = connection.prepare("PRAGMA table_info(flight_plans)").map_err(|error| error.to_string())?;
        let has_column = columns.query_map([], |row| row.get::<_, String>(1)).map_err(|error| error.to_string())?.filter_map(Result::ok).any(|column| column == "imported_at");
        has_column
    };
    if !has_imported_at {
        connection.execute("ALTER TABLE flight_plans ADD COLUMN imported_at TEXT NOT NULL DEFAULT ''", []).map_err(|error| error.to_string())?;
        connection.execute("UPDATE flight_plans SET imported_at = updated_at WHERE imported_at = ''", []).map_err(|error| error.to_string())?;
    }
    Ok(connection)
}

#[tauri::command]
pub fn list_flight_plans() -> Result<Vec<FlightPlan>, String> {
    let connection = connection()?;
    let mut statement = connection.prepare("SELECT id, callsign, departure, arrival, alternate, route, aircraft, cruise_altitude, etd, status, updated_at, imported_at FROM flight_plans ORDER BY imported_at DESC, updated_at DESC").map_err(|error| error.to_string())?;
    let plans = statement.query_map([], |row| Ok(FlightPlan { id: row.get(0)?, callsign: row.get(1)?, departure: row.get(2)?, arrival: row.get(3)?, alternate: row.get(4)?, route: row.get(5)?, aircraft: row.get(6)?, cruise_altitude: row.get(7)?, etd: row.get(8)?, status: row.get(9)?, updated_at: row.get(10)?, imported_at: row.get(11)? })).map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
    Ok(plans)
}

#[tauri::command]
pub fn save_flight_plan(plan: FlightPlan) -> Result<FlightPlan, String> {
    let connection = connection()?;
    connection.execute("INSERT INTO flight_plans (id, callsign, departure, arrival, alternate, route, aircraft, cruise_altitude, etd, status, updated_at, imported_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12) ON CONFLICT(id) DO UPDATE SET callsign = excluded.callsign, departure = excluded.departure, arrival = excluded.arrival, alternate = excluded.alternate, route = excluded.route, aircraft = excluded.aircraft, cruise_altitude = excluded.cruise_altitude, etd = excluded.etd, status = excluded.status, updated_at = excluded.updated_at", params![plan.id, plan.callsign, plan.departure, plan.arrival, plan.alternate, plan.route, plan.aircraft, plan.cruise_altitude, plan.etd, plan.status, plan.updated_at, plan.imported_at]).map_err(|error| error.to_string())?;
    Ok(plan)
}

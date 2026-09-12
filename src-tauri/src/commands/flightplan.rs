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
    pub updated_at: String,
    pub imported_at: String,
    pub route_points: Vec<FlightRoutePoint>,
    pub departure_runway: Option<String>,
    pub arrival_runway: Option<String>,
    pub sid: Option<FlightProcedureSelection>,
    pub star: Option<FlightProcedureSelection>,
    pub approach: Option<FlightProcedureSelection>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlightRoutePoint {
    pub ident: String,
    pub name: String,
    pub latitude: f64,
    pub longitude: f64,
    /// ARINC 424 航段类型（Fenix TerminalLegs.TrackCode）：TF/CF/DF/RF/CA/CR…
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub leg_type: Option<String>,
    /// RF（Radius to Fix）圆弧的圆心 (lat, lon)；前端据此把 prev→该点画成圆弧。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arc_center: Option<(f64, f64)>,
    /// 纯航向腿（CA/CD/CR/VA/VI 等无终点坐标）的磁航向；展示点按航向外推 6 NM。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub course: Option<f64>,
    /// true = 该点是按航向外推的展示点（并非真实航路点），前端画虚线且不画标记。
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub course_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlightProcedureSelection {
    pub name: String,
    pub transition: String,
    pub points: Vec<FlightRoutePoint>,
}

fn data_directory() -> Result<PathBuf, String> {
    let directory = std::env::var("APPDATA")
        .map(PathBuf::from)
        .map_err(|_| "无法找到 Windows AppData 目录".to_string())?
        .join("SkyBoard EFB");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory)
}

fn connection() -> Result<Connection, String> {
    let database = data_directory()?.join("skyboard.db");
    let connection = Connection::open(database).map_err(|error| error.to_string())?;
    connection.execute_batch("CREATE TABLE IF NOT EXISTS flight_plans (id TEXT PRIMARY KEY, callsign TEXT NOT NULL, departure TEXT NOT NULL, arrival TEXT NOT NULL, alternate TEXT, route TEXT NOT NULL, aircraft TEXT NOT NULL, cruise_altitude TEXT NOT NULL, etd TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL, imported_at TEXT NOT NULL DEFAULT '', route_points TEXT NOT NULL DEFAULT '[]', departure_runway TEXT, arrival_runway TEXT, sid TEXT, star TEXT);").map_err(|error| error.to_string())?;
    let has_imported_at = {
        let mut columns = connection
            .prepare("PRAGMA table_info(flight_plans)")
            .map_err(|error| error.to_string())?;
        let has_column = columns
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|error| error.to_string())?
            .filter_map(Result::ok)
            .any(|column| column == "imported_at");
        has_column
    };
    if !has_imported_at {
        connection
            .execute(
                "ALTER TABLE flight_plans ADD COLUMN imported_at TEXT NOT NULL DEFAULT ''",
                [],
            )
            .map_err(|error| error.to_string())?;
        connection
            .execute(
                "UPDATE flight_plans SET imported_at = updated_at WHERE imported_at = ''",
                [],
            )
            .map_err(|error| error.to_string())?;
    }
    let has_route_points = {
        let mut columns = connection
            .prepare("PRAGMA table_info(flight_plans)")
            .map_err(|error| error.to_string())?;
        let rows = columns
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|error| error.to_string())?;
        let has_column = rows
            .filter_map(Result::ok)
            .any(|column| column == "route_points");
        has_column
    };
    if !has_route_points {
        connection
            .execute(
                "ALTER TABLE flight_plans ADD COLUMN route_points TEXT NOT NULL DEFAULT '[]'",
                [],
            )
            .map_err(|error| error.to_string())?;
    }
    let columns = {
        let mut statement = connection
            .prepare("PRAGMA table_info(flight_plans)")
            .map_err(|error| error.to_string())?;
        let values = statement
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|error| error.to_string())?
            .filter_map(Result::ok)
            .collect::<Vec<_>>();
        values
    };
    for (column, definition) in [
        ("departure_runway", "TEXT"),
        ("arrival_runway", "TEXT"),
        ("sid", "TEXT"),
        ("star", "TEXT"),
        ("approach", "TEXT"),
    ] {
        if !columns.iter().any(|existing| existing == column) {
            connection
                .execute(
                    &format!("ALTER TABLE flight_plans ADD COLUMN {column} {definition}"),
                    [],
                )
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(connection)
}

#[tauri::command]
pub fn list_flight_plans() -> Result<Vec<FlightPlan>, String> {
    let connection = connection()?;
    let mut statement = connection.prepare("SELECT id, callsign, departure, arrival, alternate, route, aircraft, cruise_altitude, etd, updated_at, imported_at, route_points, departure_runway, arrival_runway, sid, star, approach FROM flight_plans ORDER BY imported_at DESC, updated_at DESC").map_err(|error| error.to_string())?;
    let plans = statement
        .query_map([], |row| {
            let route_points = row
                .get::<_, String>(11)
                .ok()
                .and_then(|value| serde_json::from_str(&value).ok())
                .unwrap_or_default();
            let sid = row
                .get::<_, Option<String>>(14)?
                .and_then(|value| serde_json::from_str(&value).ok());
            let star = row
                .get::<_, Option<String>>(15)?
                .and_then(|value| serde_json::from_str(&value).ok());
            let approach = row
                .get::<_, Option<String>>(16)?
                .and_then(|value| serde_json::from_str(&value).ok());
            Ok(FlightPlan {
                id: row.get(0)?,
                callsign: row.get(1)?,
                departure: row.get(2)?,
                arrival: row.get(3)?,
                alternate: row.get(4)?,
                route: row.get(5)?,
                aircraft: row.get(6)?,
                cruise_altitude: row.get(7)?,
                etd: row.get(8)?,
                updated_at: row.get(9)?,
                imported_at: row.get(10)?,
                route_points,
                departure_runway: row.get(12)?,
                arrival_runway: row.get(13)?,
                sid,
                star,
                approach,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(plans)
}

#[tauri::command]
pub fn save_flight_plan(plan: FlightPlan) -> Result<FlightPlan, String> {
    let connection = connection()?;
    let route_points =
        serde_json::to_string(&plan.route_points).map_err(|error| error.to_string())?;
    let sid = plan
        .sid
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|error| error.to_string())?;
    let star = plan
        .star
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|error| error.to_string())?;
    let approach = plan
        .approach
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|error| error.to_string())?;
    connection.execute("INSERT INTO flight_plans (id, callsign, departure, arrival, alternate, route, aircraft, cruise_altitude, etd, status, updated_at, imported_at, route_points, departure_runway, arrival_runway, sid, star, approach) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, '', ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17) ON CONFLICT(id) DO UPDATE SET callsign = excluded.callsign, departure = excluded.departure, arrival = excluded.arrival, alternate = excluded.alternate, route = excluded.route, aircraft = excluded.aircraft, cruise_altitude = excluded.cruise_altitude, etd = excluded.etd, status = '', updated_at = excluded.updated_at, imported_at = excluded.imported_at, route_points = excluded.route_points, departure_runway = excluded.departure_runway, arrival_runway = excluded.arrival_runway, sid = excluded.sid, star = excluded.star, approach = excluded.approach", params![plan.id, plan.callsign, plan.departure, plan.arrival, plan.alternate, plan.route, plan.aircraft, plan.cruise_altitude, plan.etd, plan.updated_at, plan.imported_at, route_points, plan.departure_runway, plan.arrival_runway, sid, star, approach]).map_err(|error| error.to_string())?;
    Ok(plan)
}

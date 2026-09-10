use super::flightplan::FlightRoutePoint;
use rusqlite::{params, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::PathBuf,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum NavigationSource {
    Lnm,
    Fenix,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NavigationConfig {
    source: NavigationSource,
    database_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NavigationDatabaseStatus {
    pub source: String,
    pub database_path: Option<String>,
    pub ready: bool,
    pub airac_cycle: Option<String>,
    pub message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NavigationAirport {
    pub icao: String,
    pub iata: String,
    pub name: String,
    pub city: String,
    pub elevation: String,
    pub latitude: f64,
    pub longitude: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NavigationFrequency {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NavigationAirportDetails {
    pub runways: Vec<String>,
    pub frequencies: Vec<NavigationFrequency>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NavigationProcedureSummary {
    pub id: i64,
    pub name: String,
    pub runways: Vec<String>,
    pub transitions: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NavigationAirportProcedures {
    pub source: String,
    pub ready: bool,
    pub message: String,
    pub sids: Vec<NavigationProcedureSummary>,
    pub stars: Vec<NavigationProcedureSummary>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NavigationMapPoint {
    pub ident: String,
    pub name: String,
    pub icao: String,
    pub iata: String,
    pub kind: String,
    pub symbol: String,
    pub latitude: f64,
    pub longitude: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NavigationAirwayLeg {
    pub coordinates: [[f64; 2]; 2],
    pub direction: String,
    pub minimum_altitude: Option<i64>,
    pub maximum_altitude: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NavigationAirway {
    pub name: String,
    pub airway_type: String,
    pub route_type: String,
    pub direction: String,
    pub coordinates: Vec<[f64; 2]>,
    pub legs: Vec<NavigationAirwayLeg>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NavigationMapData {
    pub airports: Vec<NavigationMapPoint>,
    pub navaids: Vec<NavigationMapPoint>,
    pub airways: Vec<NavigationAirway>,
}

fn app_directory() -> Result<PathBuf, String> {
    let directory = std::env::var("APPDATA")
        .map(PathBuf::from)
        .map_err(|_| "无法找到 Windows AppData 目录".to_string())?
        .join("SkyBoard EFB");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory)
}

fn config_path() -> Result<PathBuf, String> {
    Ok(app_directory()?.join("navigation-source.json"))
}

fn read_config() -> Result<NavigationConfig, String> {
    let path = config_path()?;
    if !path.exists() {
        return Ok(NavigationConfig {
            source: NavigationSource::Lnm,
            database_path: None,
        });
    }
    serde_json::from_str(&fs::read_to_string(path).map_err(|error| error.to_string())?)
        .map_err(|_| "导航数据库配置无效".to_string())
}

fn save_config(config: &NavigationConfig) -> Result<(), String> {
    fs::write(
        config_path()?,
        serde_json::to_string(config).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

fn quote_identifier(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

fn table_exists(connection: &Connection, table: &str) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND lower(name) = lower(?1))",
            [table],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())
}

fn table_columns(connection: &Connection, table: &str) -> Result<HashMap<String, String>, String> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({})", quote_identifier(table)))
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(1)?.to_lowercase(),
                row.get::<_, String>(1)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<HashMap<_, _>, _>>()
        .map_err(|error| error.to_string())
}

fn find_column(columns: &HashMap<String, String>, candidates: &[&str]) -> Option<String> {
    candidates
        .iter()
        .find_map(|candidate| columns.get(&candidate.to_lowercase()).cloned())
}

fn text_expression(column: Option<String>) -> String {
    column
        .map(|name| format!("COALESCE(CAST({} AS TEXT), '')", quote_identifier(&name)))
        .unwrap_or_else(|| "''".to_string())
}

fn number_expression(column: Option<String>) -> String {
    column
        .map(|name| format!("COALESCE(CAST({} AS REAL), 0)", quote_identifier(&name)))
        .unwrap_or_else(|| "0".to_string())
}

fn airport_table(source: &NavigationSource) -> &'static str {
    match source {
        NavigationSource::Lnm => "airport",
        NavigationSource::Fenix => "Airports",
    }
}

type AirportColumnCandidates = (
    &'static [&'static str],
    &'static [&'static str],
    &'static [&'static str],
    &'static [&'static str],
    &'static [&'static str],
    &'static [&'static str],
    &'static [&'static str],
);

fn airport_columns(source: &NavigationSource) -> AirportColumnCandidates {
    match source {
        NavigationSource::Lnm => (
            &["ident", "icao", "icao_code"],
            &["iata", "iata_code"],
            &["name", "airport_name"],
            &["city", "town", "municipality"],
            &["altitude", "elevation", "elevation_feet"],
            &["laty", "latitude", "lat"],
            &["lonx", "longitude", "lon"],
        ),
        NavigationSource::Fenix => (
            &["icao", "icao_code", "ident", "identifier", "code"],
            &["iata", "iata_code"],
            &["name", "airport_name"],
            &["city", "town", "municipality"],
            &["elevation", "altitude", "elevation_feet"],
            &["latitude", "lat", "laty", "latitude_degrees"],
            &[
                "longtitude",
                "longitude",
                "lon",
                "lonx",
                "longitude_degrees",
            ],
        ),
    }
}

fn airport_id_column(columns: &HashMap<String, String>) -> Option<String> {
    find_column(columns, &["airport_id", "airportid", "id", "airport_key"])
}

fn airac_cycle(connection: &Connection, table: &str) -> Option<String> {
    let columns = table_columns(connection, table).ok()?;
    if let Some(column) = find_column(&columns, &["airac_cycle", "airac", "cycle", "cycle_id"]) {
        return connection
            .query_row(
                &format!(
                    "SELECT CAST({} AS TEXT) FROM {} LIMIT 1",
                    quote_identifier(&column),
                    quote_identifier(table)
                ),
                [],
                |row| row.get(0),
            )
            .ok();
    }
    let key = find_column(&columns, &["key", "name", "setting", "parameter"])?;
    let value = find_column(&columns, &["value", "val", "data"])?;
    connection.query_row(
        &format!("SELECT CAST({} AS TEXT) FROM {} WHERE lower(CAST({} AS TEXT)) IN ('airac_cycle', 'airac', 'cycle', 'cycle_id') LIMIT 1", quote_identifier(&value), quote_identifier(table), quote_identifier(&key)),
        [], |row| row.get(0),
    ).ok()
}

fn database_status(
    source: NavigationSource,
    path: &str,
) -> Result<NavigationDatabaseStatus, String> {
    let connection =
        Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|_| {
            format!(
                "无法打开 {} SQLite 数据库",
                if matches!(source, NavigationSource::Lnm) {
                    "Little Navmap"
                } else {
                    "Fenix"
                }
            )
        })?;
    let valid = match source {
        NavigationSource::Lnm => {
            table_exists(&connection, "airport")?
                && table_exists(&connection, "waypoint")?
                && table_exists(&connection, "metadata")?
        }
        NavigationSource::Fenix => {
            table_exists(&connection, "Airports")?
                && table_exists(&connection, "Waypoints")?
                && table_exists(&connection, "config")?
        }
    };
    let label = if matches!(source, NavigationSource::Lnm) {
        "Little Navmap"
    } else {
        "Fenix"
    };
    let metadata_table = if matches!(source, NavigationSource::Lnm) {
        "metadata"
    } else {
        "config"
    };
    Ok(NavigationDatabaseStatus {
        source: if matches!(source, NavigationSource::Lnm) {
            "lnm"
        } else {
            "fenix"
        }
        .to_string(),
        database_path: Some(path.to_string()),
        ready: valid,
        airac_cycle: valid
            .then(|| airac_cycle(&connection, metadata_table))
            .flatten(),
        message: if valid {
            format!("{} 导航数据库已加载", label)
        } else {
            format!("所选文件缺少 {} 核心数据表", label)
        },
    })
}

fn selected_connection() -> Result<(NavigationSource, Connection), String> {
    let config = read_config()?;
    let path = config
        .database_path
        .ok_or_else(|| "尚未选择导航数据库".to_string())?;
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| "无法打开已选择的导航数据库".to_string())?;
    Ok((config.source, connection))
}

fn has_fenix_procedures(connection: &Connection) -> Result<bool, String> {
    Ok(table_exists(connection, "Terminals")?
        && table_exists(connection, "TerminalLegs")?
        && table_exists(connection, "Waypoints")?)
}

fn open_read_only(path: &str) -> Result<Connection, String> {
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| error.to_string())
}

fn procedure_connection() -> Result<Option<(Connection, String)>, String> {
    let config = read_config()?;
    if matches!(config.source, NavigationSource::Fenix) {
        if let Some(path) = config.database_path.as_deref() {
            if let Ok(connection) = open_read_only(path) {
                if has_fenix_procedures(&connection)? {
                    return Ok(Some((connection, "Fenix nd.db3".to_string())));
                }
            }
        }
    }
    if let Ok(program_data) = std::env::var("PROGRAMDATA") {
        let path = PathBuf::from(program_data)
            .join("Fenix")
            .join("Navdata")
            .join("nd.db3");
        if path.exists() {
            if let Ok(connection) = open_read_only(&path.to_string_lossy()) {
                if has_fenix_procedures(&connection)? {
                    return Ok(Some((
                        connection,
                        "Fenix nd.db3（程序补充数据）".to_string(),
                    )));
                }
            }
        }
    }
    Ok(None)
}

fn normalize_runway(value: &str) -> String {
    value
        .trim()
        .to_uppercase()
        .strip_prefix("RW")
        .unwrap_or(value.trim())
        .to_uppercase()
}

fn push_unique(values: &mut Vec<String>, value: String) {
    if !value.is_empty() && !values.iter().any(|existing| existing == &value) {
        values.push(value);
    }
}

fn airport_procedures(
    connection: &Connection,
    icao: &str,
) -> Result<
    (
        Vec<NavigationProcedureSummary>,
        Vec<NavigationProcedureSummary>,
    ),
    String,
> {
    let mut statement = connection.prepare("SELECT terminal.ID, terminal.Proc, terminal.Name, COALESCE(terminal.Rwy, ''), COALESCE(leg.Transition, '') FROM Terminals AS terminal LEFT JOIN TerminalLegs AS leg ON leg.TerminalID = terminal.ID WHERE UPPER(terminal.ICAO) = ?1 AND terminal.Proc IN (1, 2) ORDER BY terminal.Proc, terminal.Name, terminal.ID, leg.ID").map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![icao.trim().to_uppercase()], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut procedures = Vec::<(i64, NavigationProcedureSummary)>::new();
    let mut indexes = HashMap::<i64, usize>::new();
    for row in rows {
        let (id, procedure_type, name, runway, transition) =
            row.map_err(|error| error.to_string())?;
        let index = if let Some(index) = indexes.get(&id) {
            *index
        } else {
            let index = procedures.len();
            procedures.push((
                procedure_type,
                NavigationProcedureSummary {
                    id,
                    name,
                    runways: Vec::new(),
                    transitions: Vec::new(),
                },
            ));
            indexes.insert(id, index);
            index
        };
        let summary = &mut procedures[index].1;
        push_unique(&mut summary.runways, normalize_runway(&runway));
        let normalized_transition = transition.trim().to_uppercase();
        if normalized_transition.starts_with("RW") {
            push_unique(
                &mut summary.runways,
                normalize_runway(&normalized_transition),
            );
        } else if !normalized_transition.is_empty() && normalized_transition != "ALL" {
            push_unique(&mut summary.transitions, normalized_transition);
        }
    }
    for (_, summary) in &mut procedures {
        summary.runways.sort();
        summary.transitions.sort();
    }
    let sids = procedures
        .iter()
        .filter(|(procedure_type, _)| *procedure_type == 2)
        .map(|(_, summary)| summary.clone())
        .collect();
    let stars = procedures
        .into_iter()
        .filter(|(procedure_type, _)| *procedure_type == 1)
        .map(|(_, summary)| summary)
        .collect();
    Ok((sids, stars))
}

fn same_route_position(first: &FlightRoutePoint, second: &FlightRoutePoint) -> bool {
    (first.latitude - second.latitude).abs() < 0.00001
        && (first.longitude - second.longitude).abs() < 0.00001
}

fn procedure_points(
    connection: &Connection,
    procedure_id: i64,
    runway: &str,
    transition: &str,
) -> Result<Vec<FlightRoutePoint>, String> {
    let procedure_type = connection
        .query_row(
            "SELECT Proc FROM Terminals WHERE ID = ?1",
            params![procedure_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|_| "找不到所选 SID/STAR".to_string())?;
    if procedure_type != 1 && procedure_type != 2 {
        return Err("所选数据不是 SID/STAR".to_string());
    }
    let selected_runway = normalize_runway(runway);
    let selected_transition = transition.trim().to_uppercase();
    let mut statement = connection.prepare("SELECT COALESCE(waypoint.Ident, ''), COALESCE(waypoint.Name, ''), leg.WptLat, leg.WptLon, COALESCE(leg.Transition, ''), COALESCE(leg.TrackCode, '') FROM TerminalLegs AS leg LEFT JOIN Waypoints AS waypoint ON waypoint.ID = leg.WptID WHERE leg.TerminalID = ?1 ORDER BY leg.ID").map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![procedure_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<f64>>(2)?.unwrap_or_default(),
                row.get::<_, Option<f64>>(3)?.unwrap_or_default(),
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut points = Vec::new();
    for (index, row) in rows.enumerate() {
        let (ident, name, latitude, longitude, leg_transition, track_code) =
            row.map_err(|error| error.to_string())?;
        let normalized_transition = leg_transition.trim().to_uppercase();
        let runway_leg = normalized_transition.starts_with("RW")
            && normalize_runway(&normalized_transition) == selected_runway;
        let named_transition =
            !selected_transition.is_empty() && normalized_transition == selected_transition;
        if !normalized_transition.is_empty()
            && normalized_transition != "ALL"
            && !runway_leg
            && !named_transition
        {
            continue;
        }
        if !latitude.is_finite()
            || !longitude.is_finite()
            || latitude.abs() > 90.0
            || longitude.abs() > 180.0
            || (latitude == 0.0 && longitude == 0.0)
        {
            continue;
        }
        let ident = if ident.trim().is_empty() {
            format!("{}{}", track_code.trim(), index + 1)
        } else {
            ident.trim().to_string()
        };
        let point = FlightRoutePoint {
            name: if name.trim().is_empty() {
                ident.clone()
            } else {
                name.trim().to_string()
            },
            ident,
            latitude,
            longitude,
        };
        if points
            .last()
            .is_some_and(|previous| same_route_position(previous, &point))
        {
            continue;
        }
        points.push(point);
    }
    Ok(points)
}

fn search_airports(
    connection: &Connection,
    source: &NavigationSource,
    query: &str,
) -> Result<Vec<NavigationAirport>, String> {
    let table = airport_table(source);
    let columns = table_columns(connection, table)?;
    let (
        icao_candidates,
        iata_candidates,
        name_candidates,
        city_candidates,
        elevation_candidates,
        latitude_candidates,
        longitude_candidates,
    ) = airport_columns(source);
    let icao_column = find_column(&columns, icao_candidates).ok_or_else(|| {
        format!(
            "{} 机场表缺少 ICAO 字段",
            if matches!(source, NavigationSource::Lnm) {
                "Little Navmap"
            } else {
                "Fenix"
            }
        )
    })?;
    let icao = text_expression(Some(icao_column));
    let iata = text_expression(find_column(&columns, iata_candidates));
    let name = text_expression(find_column(&columns, name_candidates));
    let city = text_expression(find_column(&columns, city_candidates));
    let elevation = number_expression(find_column(&columns, elevation_candidates));
    let latitude = number_expression(find_column(&columns, latitude_candidates));
    let longitude = number_expression(find_column(&columns, longitude_candidates));
    let filter = format!("%{}%", query.trim().to_uppercase());
    let sql = format!("SELECT {icao}, {iata}, {name}, {city}, {elevation}, {latitude}, {longitude} FROM {} WHERE UPPER({icao}) LIKE ?1 OR UPPER({iata}) LIKE ?1 OR UPPER({name}) LIKE ?1 OR UPPER({city}) LIKE ?1 ORDER BY {icao} LIMIT 100", quote_identifier(table));
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![filter], |row| {
            Ok(NavigationAirport {
                icao: row.get(0)?,
                iata: row.get(1)?,
                name: row.get(2)?,
                city: row.get(3)?,
                elevation: format!("{:.0} ft", row.get::<_, f64>(4)?),
                latitude: row.get(5)?,
                longitude: row.get(6)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

fn related_values(
    connection: &Connection,
    source: &NavigationSource,
    detail_table: &str,
    value_candidates: &[&str],
    icao: &str,
) -> Result<Vec<String>, String> {
    if !table_exists(connection, detail_table)? {
        return Ok(Vec::new());
    }
    let detail_columns = table_columns(connection, detail_table)?;
    let value = match find_column(&detail_columns, value_candidates) {
        Some(value) => text_expression(Some(value)),
        None => return Ok(Vec::new()),
    };
    let direct_icao = find_column(
        &detail_columns,
        &[
            "airport_icao",
            "airporticao",
            "icao",
            "airport_ident",
            "airportident",
        ],
    );
    let sql = if let Some(column) = direct_icao {
        format!(
            "SELECT {value} FROM {} WHERE UPPER(CAST({} AS TEXT)) = ?1",
            quote_identifier(detail_table),
            quote_identifier(&column)
        )
    } else {
        let airport_table = airport_table(source);
        let airport_columns_map = table_columns(connection, airport_table)?;
        let (icao_candidates, _, _, _, _, _, _) = airport_columns(source);
        let airport_icao = find_column(&airport_columns_map, icao_candidates)
            .ok_or_else(|| "机场表缺少 ICAO 字段".to_string())?;
        let airport_id = match airport_id_column(&airport_columns_map) {
            Some(column) => column,
            None => return Ok(Vec::new()),
        };
        let detail_airport_id =
            match find_column(&detail_columns, &["airport_id", "airportid", "airport_key"]) {
                Some(column) => column,
                None => return Ok(Vec::new()),
            };
        format!("SELECT {value} FROM {} AS detail JOIN {} AS airport ON detail.{} = airport.{} WHERE UPPER(CAST(airport.{} AS TEXT)) = ?1", quote_identifier(detail_table), quote_identifier(airport_table), quote_identifier(&detail_airport_id), quote_identifier(&airport_id), quote_identifier(&airport_icao))
    };
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![icao.to_uppercase()], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    let values = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(values
        .into_iter()
        .filter(|value| !value.trim().is_empty())
        .collect())
}

fn format_frequency(value: &str) -> String {
    match value.trim().parse::<f64>().ok() {
        Some(value) if value >= 10_000.0 => format!("{:.3}", value / 1_000.0),
        Some(value) if value > 0.0 => format!("{:.3}", value),
        _ => value.to_string(),
    }
}

fn airport_details(
    connection: &Connection,
    source: &NavigationSource,
    icao: &str,
) -> Result<NavigationAirportDetails, String> {
    let runway_table = if matches!(source, NavigationSource::Lnm) {
        "runway"
    } else {
        "Runways"
    };
    let communication_table = if matches!(source, NavigationSource::Lnm) {
        "com"
    } else {
        "AirportCommunication"
    };
    let runways = related_values(
        connection,
        source,
        runway_table,
        &["name", "ident", "identifier", "runway", "designation"],
        icao,
    )?;
    let communication_names = related_values(
        connection,
        source,
        communication_table,
        &["name", "type_name", "description", "type", "service"],
        icao,
    )?;
    let communication_values = related_values(
        connection,
        source,
        communication_table,
        &["frequency", "freq", "frequency_mhz", "value"],
        icao,
    )?;
    let frequencies = communication_values
        .into_iter()
        .enumerate()
        .map(|(index, value)| NavigationFrequency {
            name: communication_names
                .get(index)
                .cloned()
                .unwrap_or_else(|| "通信".to_string()),
            value: format_frequency(&value),
        })
        .collect();
    Ok(NavigationAirportDetails {
        runways,
        frequencies,
    })
}

#[tauri::command]
pub fn set_navigation_database(
    source: String,
    database_path: Option<String>,
) -> Result<NavigationDatabaseStatus, String> {
    let source = match source.as_str() {
        "lnm" => NavigationSource::Lnm,
        "fenix" => NavigationSource::Fenix,
        _ => return Err("不支持的导航数据库源".to_string()),
    };
    let path = database_path
        .as_deref()
        .ok_or_else(|| "请选择导航数据库文件".to_string())?;
    let status = database_status(source.clone(), path)?;
    if !status.ready {
        return Err(status.message);
    }
    save_config(&NavigationConfig {
        source,
        database_path,
    })?;
    Ok(status)
}

#[tauri::command]
pub fn get_navigation_database_status() -> Result<NavigationDatabaseStatus, String> {
    let config = read_config()?;
    match config.database_path {
        Some(path) => database_status(config.source, &path),
        None => Ok(NavigationDatabaseStatus {
            source: if matches!(config.source, NavigationSource::Lnm) {
                "lnm"
            } else {
                "fenix"
            }
            .to_string(),
            database_path: None,
            ready: false,
            airac_cycle: None,
            message: "尚未选择导航数据库".to_string(),
        }),
    }
}

#[tauri::command]
pub fn search_navigation_airports(query: String) -> Result<Vec<NavigationAirport>, String> {
    let (source, connection) = selected_connection()?;
    search_airports(&connection, &source, &query)
}

#[tauri::command]
pub fn get_navigation_airport_details(icao: String) -> Result<NavigationAirportDetails, String> {
    let (source, connection) = selected_connection()?;
    airport_details(&connection, &source, &icao)
}

#[tauri::command]
pub fn get_navigation_airport_procedures(
    icao: String,
) -> Result<NavigationAirportProcedures, String> {
    let normalized = icao.trim().to_uppercase();
    if normalized.len() != 4
        || !normalized
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
    {
        return Err("请输入有效的四字机场 ICAO".to_string());
    }
    let Some((connection, source)) = procedure_connection()? else {
        return Ok(NavigationAirportProcedures {
            source: "lnm".to_string(),
            ready: false,
            message: "当前导航库不含 SID/STAR 航段；可在设置中选择 Fenix nd.db3。".to_string(),
            sids: Vec::new(),
            stars: Vec::new(),
        });
    };
    let (sids, stars) = airport_procedures(&connection, &normalized)?;
    let message = if sids.is_empty() && stars.is_empty() {
        format!("{source} 中没有 {normalized} 的 SID/STAR")
    } else {
        format!("{source} · {} 条 SID · {} 条 STAR", sids.len(), stars.len())
    };
    Ok(NavigationAirportProcedures {
        source: "fenix".to_string(),
        ready: true,
        message,
        sids,
        stars,
    })
}

#[tauri::command]
pub fn get_navigation_procedure_points(
    procedure_id: i64,
    runway: Option<String>,
    transition: Option<String>,
) -> Result<Vec<FlightRoutePoint>, String> {
    let Some((connection, _)) = procedure_connection()? else {
        return Err("没有可用的 SID/STAR 数据库".to_string());
    };
    procedure_points(
        &connection,
        procedure_id,
        runway.as_deref().unwrap_or_default(),
        transition.as_deref().unwrap_or_default(),
    )
}

fn map_points_from_table(
    connection: &Connection,
    table: &str,
    ident_candidates: &[&str],
    name_candidates: &[&str],
    latitude_candidates: &[&str],
    longitude_candidates: &[&str],
    kind: &str,
    symbol_kind: NavigationSymbolKind,
    west: f64,
    south: f64,
    east: f64,
    north: f64,
) -> Result<Vec<NavigationMapPoint>, String> {
    if !table_exists(connection, table)? {
        return Ok(Vec::new());
    }
    let columns = table_columns(connection, table)?;
    let latitude = match find_column(&columns, latitude_candidates) {
        Some(column) => number_expression(Some(column)),
        None => return Ok(Vec::new()),
    };
    let longitude = match find_column(&columns, longitude_candidates) {
        Some(column) => number_expression(Some(column)),
        None => return Ok(Vec::new()),
    };
    let ident = text_expression(find_column(&columns, ident_candidates));
    let name = text_expression(find_column(&columns, name_candidates));
    let symbol = navigation_symbol_expression(&columns, symbol_kind);
    let sql = format!("SELECT {ident}, {name}, {latitude}, {longitude}, {symbol} FROM {} WHERE {latitude} BETWEEN ?1 AND ?2 AND {longitude} BETWEEN ?3 AND ?4 LIMIT 1500", quote_identifier(table));
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![south, north, west, east], |row| {
            Ok(NavigationMapPoint {
                ident: row.get(0)?,
                name: row.get(1)?,
                icao: String::new(),
                iata: String::new(),
                kind: kind.to_string(),
                symbol: row.get(4)?,
                latitude: row.get(2)?,
                longitude: row.get(3)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[derive(Clone, Copy)]
enum NavigationSymbolKind {
    Waypoint,
    Vor,
    Ndb,
    GenericNavaid,
}

fn navigation_symbol_expression(
    columns: &HashMap<String, String>,
    kind: NavigationSymbolKind,
) -> String {
    match kind {
        NavigationSymbolKind::Waypoint => {
            let victor = number_expression(find_column(columns, &["num_victor_airway"]));
            let jet = number_expression(find_column(columns, &["num_jet_airway"]));
            format!("CASE WHEN ({victor} + {jet}) > 0 THEN 'intersection' ELSE 'waypoint' END")
        }
        NavigationSymbolKind::Vor => {
            let nav_type =
                text_expression(find_column(columns, &["type", "nav_type", "navaid_type"]));
            let dme_only = number_expression(find_column(columns, &["dme_only", "is_dme_only"]));
            let has_dme = find_column(columns, &["dme_lonx", "dme_longitude", "dme_lon"])
                .map(|column| format!("{} IS NOT NULL", quote_identifier(&column)))
                .unwrap_or_else(|| "0".to_string());
            format!("CASE WHEN {dme_only} <> 0 THEN 'dme' WHEN UPPER({nav_type}) = 'TC' OR UPPER({nav_type}) LIKE '%TACAN%' THEN 'tacan' WHEN UPPER({nav_type}) LIKE 'VT%' OR UPPER({nav_type}) LIKE '%VORTAC%' THEN 'vortac' WHEN {has_dme} THEN 'vor-dme' ELSE 'vor' END")
        }
        NavigationSymbolKind::Ndb => "'ndb'".to_string(),
        NavigationSymbolKind::GenericNavaid => {
            let nav_type = text_expression(find_column(
                columns,
                &["type", "nav_type", "navaid_type", "class"],
            ));
            format!("CASE WHEN UPPER({nav_type}) LIKE '%VORTAC%' OR UPPER({nav_type}) LIKE 'VT%' THEN 'vortac' WHEN UPPER({nav_type}) LIKE '%TACAN%' OR UPPER({nav_type}) = 'TC' THEN 'tacan' WHEN UPPER({nav_type}) LIKE '%NDB%' THEN 'ndb' WHEN UPPER({nav_type}) LIKE '%VOR%DME%' THEN 'vor-dme' WHEN UPPER({nav_type}) LIKE '%DME%' THEN 'dme' WHEN UPPER({nav_type}) LIKE '%VOR%' THEN 'vor' ELSE 'vor' END")
        }
    }
}

fn map_airports(
    connection: &Connection,
    source: &NavigationSource,
    west: f64,
    south: f64,
    east: f64,
    north: f64,
) -> Result<Vec<NavigationMapPoint>, String> {
    let table = airport_table(source);
    let columns = table_columns(connection, table)?;
    let (
        icao_candidates,
        iata_candidates,
        name_candidates,
        _,
        _,
        latitude_candidates,
        longitude_candidates,
    ) = airport_columns(source);
    let latitude = match find_column(&columns, latitude_candidates) {
        Some(column) => number_expression(Some(column)),
        None => return Ok(Vec::new()),
    };
    let longitude = match find_column(&columns, longitude_candidates) {
        Some(column) => number_expression(Some(column)),
        None => return Ok(Vec::new()),
    };
    let icao = text_expression(find_column(&columns, icao_candidates));
    let iata = text_expression(find_column(&columns, iata_candidates));
    let name = text_expression(find_column(&columns, name_candidates));
    let symbol = find_column(
        &columns,
        &["num_approach", "number_of_approaches", "approach_count"],
    )
    .map(|column| {
        format!(
            "CASE WHEN {} > 0 THEN 'airport-ifr' ELSE 'airport-vfr' END",
            number_expression(Some(column))
        )
    })
    .unwrap_or_else(|| "'airport-ifr'".to_string());
    let sql = format!("SELECT {icao}, {iata}, {name}, {latitude}, {longitude}, {symbol} FROM {} WHERE {latitude} BETWEEN ?1 AND ?2 AND {longitude} BETWEEN ?3 AND ?4 LIMIT 1200", quote_identifier(table));
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![south, north, west, east], |row| {
            Ok(NavigationMapPoint {
                ident: row.get(0)?,
                icao: row.get(0)?,
                iata: row.get(1)?,
                name: row.get(2)?,
                kind: "机场".to_string(),
                symbol: row.get(5)?,
                latitude: row.get(3)?,
                longitude: row.get(4)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

fn map_navaids(
    connection: &Connection,
    source: &NavigationSource,
    west: f64,
    south: f64,
    east: f64,
    north: f64,
) -> Result<Vec<NavigationMapPoint>, String> {
    let (tables, latitude_candidates, longitude_candidates): (
        &[(&str, &str, NavigationSymbolKind)],
        &[&str],
        &[&str],
    ) = match source {
        NavigationSource::Lnm => (
            &[
                ("waypoint", "航路点", NavigationSymbolKind::Waypoint),
                ("vor", "VOR", NavigationSymbolKind::Vor),
                ("ndb", "NDB", NavigationSymbolKind::Ndb),
            ],
            &["laty", "latitude", "lat"],
            &["lonx", "longitude", "lon"],
        ),
        NavigationSource::Fenix => (
            &[
                ("Waypoints", "航路点", NavigationSymbolKind::Waypoint),
                ("Navaids", "导航台", NavigationSymbolKind::GenericNavaid),
            ],
            &["latitude", "lat", "laty", "latitude_degrees"],
            &[
                "longtitude",
                "longitude",
                "lon",
                "lonx",
                "longitude_degrees",
            ],
        ),
    };
    let mut points = Vec::new();
    for (table, kind, symbol_kind) in tables {
        points.extend(map_points_from_table(
            connection,
            table,
            &["ident", "identifier", "code", "name"],
            &["name", "description", "ident", "identifier"],
            latitude_candidates,
            longitude_candidates,
            kind,
            *symbol_kind,
            west,
            south,
            east,
            north,
        )?);
    }
    let mut seen = HashSet::new();
    points.retain(|point| {
        seen.insert(format!(
            "{}:{}:{:.4}:{:.4}",
            point.kind, point.ident, point.latitude, point.longitude
        ))
    });
    Ok(points)
}

#[derive(Debug, Clone)]
struct AirwaySegment {
    group: String,
    name: String,
    airway_type: String,
    route_type: String,
    direction: String,
    minimum_altitude: Option<i64>,
    maximum_altitude: Option<i64>,
    sequence: i64,
    is_start: bool,
    from_id: i64,
    to_id: i64,
    from: [f64; 2],
    to: [f64; 2],
}

fn navigation_airway(segments: &[AirwaySegment]) -> NavigationAirway {
    let mut coordinates = vec![segments[0].from];
    for segment in segments {
        coordinates.push(segment.to);
    }
    let legs = segments
        .iter()
        .map(|segment| NavigationAirwayLeg {
            coordinates: [segment.from, segment.to],
            direction: segment.direction.clone(),
            minimum_altitude: segment.minimum_altitude,
            maximum_altitude: segment.maximum_altitude,
        })
        .collect();
    NavigationAirway {
        name: segments[0].name.clone(),
        airway_type: segments[0].airway_type.clone(),
        route_type: segments[0].route_type.clone(),
        direction: segments[0].direction.clone(),
        coordinates,
        legs,
    }
}

fn merge_lnm_airways(mut segments: Vec<AirwaySegment>) -> Vec<NavigationAirway> {
    segments.sort_by(|first, second| {
        first
            .group
            .cmp(&second.group)
            .then(first.sequence.cmp(&second.sequence))
    });
    let mut airways = Vec::new();
    let mut chain: Vec<AirwaySegment> = Vec::new();
    for segment in segments {
        let continues = chain.last().is_some_and(|previous| {
            previous.group == segment.group && previous.to_id == segment.from_id
        });
        if !chain.is_empty() && !continues {
            airways.push(navigation_airway(&chain));
            chain.clear();
        }
        chain.push(segment);
    }
    if !chain.is_empty() {
        airways.push(navigation_airway(&chain));
    }
    airways
}

fn merge_fenix_airways(segments: Vec<AirwaySegment>) -> Vec<NavigationAirway> {
    let mut groups: HashMap<String, Vec<AirwaySegment>> = HashMap::new();
    for segment in segments {
        groups
            .entry(segment.group.clone())
            .or_default()
            .push(segment);
    }
    let mut airways = Vec::new();
    for (_, mut remaining) in groups {
        while !remaining.is_empty() {
            let start = remaining
                .iter()
                .position(|segment| segment.is_start)
                .unwrap_or(0);
            let mut chain = vec![remaining.remove(start)];
            while let Some(index) = remaining.iter().position(|segment| {
                segment.from_id == chain.last().expect("chain has a segment").to_id
            }) {
                chain.push(remaining.remove(index));
            }
            while let Some(index) = remaining.iter().position(|segment| {
                segment.to_id == chain.first().expect("chain has a segment").from_id
            }) {
                let mut segment = remaining.remove(index);
                std::mem::swap(&mut segment.from_id, &mut segment.to_id);
                std::mem::swap(&mut segment.from, &mut segment.to);
                chain.insert(0, segment);
            }
            airways.push(navigation_airway(&chain));
        }
    }
    airways
}

fn map_lnm_airways(
    connection: &Connection,
    west: f64,
    south: f64,
    east: f64,
    north: f64,
    limit: usize,
) -> Result<Vec<NavigationAirway>, String> {
    let sql = format!("SELECT airway_name, airway_type, route_type, direction, minimum_altitude, maximum_altitude, airway_fragment_no, sequence_no, from_waypoint_id, to_waypoint_id, from_lonx, from_laty, to_lonx, to_laty FROM airway WHERE right_lonx >= ?1 AND left_lonx <= ?2 AND top_laty >= ?3 AND bottom_laty <= ?4 ORDER BY airway_name, airway_type, route_type, direction, airway_fragment_no, sequence_no LIMIT {limit}");
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![west, east, south, north], |row| {
            Ok(AirwaySegment {
                name: row.get(0)?,
                airway_type: row.get(1)?,
                route_type: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                direction: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                minimum_altitude: row.get(4)?,
                maximum_altitude: row.get(5)?,
                group: format!(
                    "{}:{}:{}:{}:{}",
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                    row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                    row.get::<_, i64>(6)?
                ),
                sequence: row.get(7)?,
                from_id: row.get(8)?,
                to_id: row.get(9)?,
                from: [row.get(10)?, row.get(11)?],
                to: [row.get(12)?, row.get(13)?],
                is_start: false,
            })
        })
        .map_err(|error| error.to_string())?;
    let segments = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(merge_lnm_airways(segments))
}

fn map_fenix_airways(
    connection: &Connection,
    west: f64,
    south: f64,
    east: f64,
    north: f64,
    limit: usize,
) -> Result<Vec<NavigationAirway>, String> {
    let sql = format!("SELECT airway.Ident, leg.AirwayID, leg.ID, leg.Waypoint1ID, leg.Waypoint2ID, leg.IsStart, waypoint1.Longtitude, waypoint1.Latitude, waypoint2.Longtitude, waypoint2.Latitude FROM AirwayLegs AS leg JOIN Airways AS airway ON airway.ID = leg.AirwayID JOIN Waypoints AS waypoint1 ON waypoint1.ID = leg.Waypoint1ID JOIN Waypoints AS waypoint2 ON waypoint2.ID = leg.Waypoint2ID WHERE MAX(waypoint1.Latitude, waypoint2.Latitude) >= ?1 AND MIN(waypoint1.Latitude, waypoint2.Latitude) <= ?2 AND MAX(waypoint1.Longtitude, waypoint2.Longtitude) >= ?3 AND MIN(waypoint1.Longtitude, waypoint2.Longtitude) <= ?4 ORDER BY leg.AirwayID, leg.ID LIMIT {limit}");
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![south, north, west, east], |row| {
            Ok(AirwaySegment {
                name: row.get(0)?,
                airway_type: String::new(),
                route_type: String::new(),
                direction: String::new(),
                minimum_altitude: None,
                maximum_altitude: None,
                group: row.get::<_, i64>(1)?.to_string(),
                sequence: row.get(2)?,
                from_id: row.get(3)?,
                to_id: row.get(4)?,
                is_start: row.get::<_, i64>(5)? != 0,
                from: [row.get(6)?, row.get(7)?],
                to: [row.get(8)?, row.get(9)?],
            })
        })
        .map_err(|error| error.to_string())?;
    let segments = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(merge_fenix_airways(segments))
}

fn map_airways(
    connection: &Connection,
    source: &NavigationSource,
    west: f64,
    south: f64,
    east: f64,
    north: f64,
    zoom: f64,
) -> Result<Vec<NavigationAirway>, String> {
    let limit = if zoom < 4.5 {
        1_500
    } else if zoom < 6.0 {
        4_000
    } else if zoom < 8.0 {
        8_000
    } else {
        12_000
    };
    match source {
        NavigationSource::Lnm => map_lnm_airways(connection, west, south, east, north, limit),
        NavigationSource::Fenix => map_fenix_airways(connection, west, south, east, north, limit),
    }
}

#[tauri::command]
pub fn get_navigation_map_data(
    west: f64,
    south: f64,
    east: f64,
    north: f64,
    zoom: f64,
) -> Result<NavigationMapData, String> {
    if !(-180.0..=180.0).contains(&west)
        || !(-180.0..=180.0).contains(&east)
        || !(-90.0..=90.0).contains(&south)
        || !(-90.0..=90.0).contains(&north)
        || !(0.0..=22.0).contains(&zoom)
        || west >= east
        || south >= north
    {
        return Err("地图可视范围无效".to_string());
    }
    let (source, connection) = selected_connection()?;
    Ok(NavigationMapData {
        airports: map_airports(&connection, &source, west, south, east, north)?,
        navaids: map_navaids(&connection, &source, west, south, east, north)?,
        airways: map_airways(&connection, &source, west, south, east, north, zoom)?,
    })
}

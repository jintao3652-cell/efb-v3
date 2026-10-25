use super::dfdv2;
use super::flightplan::FlightRoutePoint;
use rusqlite::{params, params_from_iter, types::ValueRef, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum NavigationSource {
    Lnm,
    /// Fenix 自带的 `nd.db3`（DFD v1 风格表名：Airports / Waypoints / Terminals…）
    Fenix,
    /// Navigraph DFD v2（`tbl_pa_airports` / `tbl_er_enroute_airways` / `tbl_pd_sids`…）
    DfdV2,
}

impl NavigationSource {
    fn label(self) -> &'static str {
        match self {
            NavigationSource::Lnm => "Little Navmap",
            NavigationSource::Fenix => "Fenix",
            NavigationSource::DfdV2 => "Navigraph DFD v2",
        }
    }

    fn key(self) -> &'static str {
        match self {
            NavigationSource::Lnm => "lnm",
            NavigationSource::Fenix => "fenix",
            NavigationSource::DfdV2 => "dfdv2",
        }
    }
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

/// 跑道一端的坐标（DFD v2 的 `tbl_pg_runways` 每端各一行）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunwayEnd {
    pub ident: String,
    pub latitude: f64,
    pub longitude: f64,
}

/// 程序对应跑道的两端，用于在地图上画出跑道并参与自动框选。
/// 对端缺坐标时 `reciprocal` 为空，前端退化为只标阈值点。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunwayEnds {
    pub runway: String,
    pub primary: RunwayEnd,
    pub reciprocal: Option<RunwayEnd>,
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
    pub approaches: Vec<NavigationProcedureSummary>,
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
    /// 报告点类别："compulsory" / "non-compulsory" / "fly-over"
    /// （Jeppesen ENROUTE-7 图例键 §28）。当前数据源尚无此字段，
    /// 预留契约：一旦导航库能给出，即可驱动实心/空心与飞越圈符号。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reporting: Option<String>,
    pub latitude: f64,
    pub longitude: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NavigationAirwayLeg {
    pub coordinates: [[f64; 2]; 2],
    pub direction: String,
    /// 高度层（Fenix AirwayLegs.Level：L=低空 H=高空 B=两者；LNM 数据源为空）。
    /// Jeppesen 图例 ENRT-L / ENRT-H / ENRT-H/L 对应低空 / 高空 / 双层航路。
    pub level: String,
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
    /// 等待航线（Jeppesen SYMBOLS-8, ROUTES & AIRWAYS — Holding Patterns）。
    /// 空数组不参与序列化，前端相应图层保持关闭。
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub holding_patterns: Vec<NavigationHoldingPattern>,
    /// Grid MORA 网格单元（Jeppesen ENROUTE-7 §14）。同上，空则不序列化。
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub mora_cells: Vec<NavigationMoraCell>,
    /// 特殊空域面（Jeppesen SYMBOLS-3, AIRSPACE & BOUNDARIES）。同上。
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub special_use_airspace: Vec<NavigationSpecialUseAirspace>,
}

/// 等待航线：跑道形符号 + 入航边。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NavigationHoldingPattern {
    pub ident: String,
    pub name: String,
    /// 入航航向（度，磁航向）
    pub inbound_course: Option<f64>,
    /// 转弯方向："L" 左转 / "R" 右转
    pub turn_direction: Option<String>,
    pub latitude: f64,
    pub longitude: f64,
}

/// Grid MORA 网格单元。altitude_feet 为 null 表示图例中的 "Unsurveyed"。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NavigationMoraCell {
    pub latitude: f64,
    pub longitude: f64,
    pub altitude_feet: Option<i64>,
    /// 精度存疑时前端在数值后加 "±"
    pub doubtful: bool,
}

/// 特殊空域面。type 用于归类到 SYMBOLS-3 的绿 / 绛红两族。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NavigationSpecialUseAirspace {
    pub id: String,
    pub name: String,
    pub airspace_type: String,
    pub lower_limit: Option<String>,
    pub upper_limit: Option<String>,
    pub coordinates: Vec<[f64; 2]>,
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
            source: NavigationSource::DfdV2,
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

pub(super) fn quote_identifier(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

/// 用户可能在设置里选的是目录（Fenix 数据目录 / LNM 数据目录），
/// 这里统一解析成实际的 SQLite 文件，避免把目录直接交给 rusqlite。
fn resolve_database_path(path: &str) -> Result<PathBuf, String> {
    let candidate = PathBuf::from(path);
    if candidate.is_file() {
        return Ok(candidate);
    }
    if !candidate.is_dir() {
        return Err(format!("路径不存在：{path}"));
    }
    const NAMES: [&str; 5] = [
        "nd.db3",
        "little_navmap.sqlite",
        "little_navmap_db",
        "nd.db",
        "navdata.db3",
    ];
    for name in NAMES {
        let direct = candidate.join(name);
        if direct.is_file() {
            return Ok(direct);
        }
    }
    // 再向下找一层：Fenix 的 `Navdata/nd.db3`、LNM 的 `little_navmap_db/little_navmap.sqlite`。
    let mut nested: Vec<PathBuf> = Vec::new();
    if let Ok(entries) = fs::read_dir(&candidate) {
        for entry in entries.flatten() {
            let child = entry.path();
            if !child.is_dir() {
                continue;
            }
            for name in NAMES {
                let inner = child.join(name);
                if inner.is_file() {
                    nested.push(inner);
                }
            }
        }
    }
    nested.sort();
    if let Some(found) = nested.into_iter().next() {
        return Ok(found);
    }
    // 最后兜底：目录里任何 .db3 / .db / .sqlite 文件。
    let mut loose: Vec<PathBuf> = Vec::new();
    for entry in fs::read_dir(&candidate).map_err(|error| error.to_string())?.flatten() {
        let child = entry.path();
        let extension = child
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_lowercase();
        if child.is_file() && matches!(extension.as_str(), "db3" | "db" | "sqlite" | "sqlite3") {
            loose.push(child);
        }
    }
    loose.sort();
    loose
        .into_iter()
        .next()
        .ok_or_else(|| format!("目录中没有找到导航数据库文件：{path}"))
}

/// 按表结构判断数据库格式。DFD v2 的特征是 `tbl_` 前缀表名，
/// 与 Fenix 旧库（`Airports`/`Waypoints`）和 LNM（`airport`/`waypoint`）都不同。
fn detect_source(connection: &Connection) -> Option<NavigationSource> {
    let has = |table: &str| table_exists(connection, table).unwrap_or(false);
    if has("tbl_pa_airports")
        && (has("tbl_ea_enroute_waypoints") || has("tbl_pc_terminal_waypoints"))
    {
        return Some(NavigationSource::DfdV2);
    }
    if has("airport") && has("waypoint") && has("metadata") {
        return Some(NavigationSource::Lnm);
    }
    if has("Airports") && has("Waypoints") {
        return Some(NavigationSource::Fenix);
    }
    None
}

fn open_read_only(path: &Path) -> Result<Connection, String> {
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| error.to_string())
}

pub(super) fn table_exists(connection: &Connection, table: &str) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND lower(name) = lower(?1))",
            [table],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())
}

pub(super) fn table_columns(connection: &Connection, table: &str) -> Result<HashMap<String, String>, String> {
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

pub(super) fn find_column(columns: &HashMap<String, String>, candidates: &[&str]) -> Option<String> {
    candidates
        .iter()
        .find_map(|candidate| columns.get(&candidate.to_lowercase()).cloned())
}

pub(super) fn text_expression(column: Option<String>) -> String {
    column
        .map(|name| format!("COALESCE(CAST({} AS TEXT), '')", quote_identifier(&name)))
        .unwrap_or_else(|| "''".to_string())
}

pub(super) fn number_expression(column: Option<String>) -> String {
    column
        .map(|name| format!("COALESCE(CAST({} AS REAL), 0)", quote_identifier(&name)))
        .unwrap_or_else(|| "0".to_string())
}

fn airport_table(source: &NavigationSource) -> &'static str {
    match source {
        NavigationSource::Lnm => "airport",
        NavigationSource::Fenix => "Airports",
        NavigationSource::DfdV2 => "tbl_pa_airports",
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
        // DFD v2 字段名固定，候选列表只留规范名，避免误命中同义列。
        NavigationSource::DfdV2 => (
            &["airport_identifier"],
            &["ata_iata_code", "iata_code"],
            &["airport_name", "name"],
            &["city"],
            &["elevation", "airport_elevation"],
            &["airport_ref_latitude", "latitude"],
            &["airport_ref_longitude", "longitude"],
        ),
    }
}

fn airport_id_column(columns: &HashMap<String, String>) -> Option<String> {
    find_column(columns, &["airport_id", "airportid", "id", "airport_key"])
}

fn cycle_name_prefix(value: &str) -> Option<String> {
    let cycle = value.trim().chars().take(4).collect::<String>();
    (cycle.len() == 4 && cycle.chars().all(|character| character.is_ascii_digit())).then_some(cycle)
}

fn airac_cycle(connection: &Connection, table: &str) -> Option<String> {
    let columns = table_columns(connection, table).ok()?;
    if let Some(column) = find_column(&columns, &["cyclename"]) {
        let cycle_name: String = connection
            .query_row(
                &format!(
                    "SELECT CAST({} AS TEXT) FROM {} LIMIT 1",
                    quote_identifier(&column),
                    quote_identifier(table)
                ),
                [],
                |row| row.get(0),
            )
            .ok()?;
        if let Some(cycle) = cycle_name_prefix(&cycle_name) {
            return Some(cycle);
        }
    }
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
    let cycle_name = connection
        .query_row(
            &format!(
                "SELECT CAST({} AS TEXT) FROM {} WHERE lower(CAST({} AS TEXT)) = 'cyclename' LIMIT 1",
                quote_identifier(&value),
                quote_identifier(table),
                quote_identifier(&key)
            ),
            [],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .and_then(|cycle_name| cycle_name_prefix(&cycle_name));
    if cycle_name.is_some() {
        return cycle_name;
    }
    connection.query_row(
        &format!("SELECT CAST({} AS TEXT) FROM {} WHERE lower(CAST({} AS TEXT)) IN ('airac_cycle', 'airac', 'cycle', 'cycle_id') LIMIT 1", quote_identifier(&value), quote_identifier(table), quote_identifier(&key)),
        [], |row| row.get(0),
    ).ok()
}

fn database_status(
    source: NavigationSource,
    path: &str,
) -> Result<NavigationDatabaseStatus, String> {
    let file = resolve_database_path(path)?;
    let connection = open_read_only(&file).map_err(|_| {
        format!(
            "无法打开 {} 导航数据库：{}",
            source.label(),
            file.to_string_lossy()
        )
    })?;
    let detected = detect_source(&connection);
    let label = detected.unwrap_or(source).label();
    let valid = match detected {
        // DFD v2：机场表 + 任一航路点表即视为完整，程序表可能按需裁剪。
        Some(NavigationSource::DfdV2) => true,
        // LNM：机场 / 航路点 / 元数据 三表齐全。
        Some(NavigationSource::Lnm) => true,
        Some(NavigationSource::Fenix) => table_exists(&connection, "config")?,
        None => false,
    };
    let (airac_cycle, version) = if valid {
        match detected {
            Some(NavigationSource::DfdV2) => (
                dfdv2::cycle(&connection),
                dfdv2::dataset_version(&connection),
            ),
            Some(NavigationSource::Lnm) => (airac_cycle(&connection, "metadata"), None),
            Some(NavigationSource::Fenix) => (airac_cycle(&connection, "config"), None),
            None => (None, None),
        }
    } else {
        (None, None)
    };
    let message = if !valid {
        format!("所选文件缺少 {label} 核心数据表")
    } else {
        let mut message = format!("{label} 导航数据库已加载");
        if let Some(version) = version {
            message.push_str(&format!(" · DFD {version}"));
        }
        message
    };
    Ok(NavigationDatabaseStatus {
        source: detected.unwrap_or(source).key().to_string(),
        database_path: Some(file.to_string_lossy().to_string()),
        ready: valid,
        airac_cycle,
        message,
    })
}

fn selected_connection() -> Result<(NavigationSource, Connection), String> {
    let config = read_config()?;
    let path = config
        .database_path
        .ok_or_else(|| "尚未选择导航数据库".to_string())?;
    let file = resolve_database_path(&path)?;
    let connection =
        open_read_only(&file).map_err(|_| "无法打开已选择的导航数据库".to_string())?;
    // 以实际表结构为准：用户选了「Fenix」但文件其实是 DFD v2 也能直接用。
    let source = detect_source(&connection).ok_or_else(|| {
        "无法识别导航数据库格式：需要 Navigraph DFD v2 数据库（表名以 tbl_ 开头）".to_string()
    })?;
    Ok((source, connection))
}

fn has_procedures(connection: &Connection, source: NavigationSource) -> Result<bool, String> {
    match source {
        NavigationSource::DfdV2 => dfdv2::has_procedures(connection),
        _ => Ok(table_exists(connection, "Terminals")?
            && table_exists(connection, "TerminalLegs")?
            && table_exists(connection, "Waypoints")?),
    }
}

/// 程序（SID/STAR/进近）数据连接。只认设置里选的那一个数据库文件，
/// 不再去 `%PROGRAMDATA%\Fenix\Navdata\nd.db3` 兜底——导航库现在只保留 DFD v2，
/// 静默换成另一个厂商的库会让航路点和程序对不上。
fn procedure_connection() -> Result<Option<(Connection, NavigationSource, String)>, String> {
    let config = read_config()?;
    let mut candidates: Vec<(PathBuf, String)> = Vec::new();
    if let Some(path) = config.database_path.as_deref() {
        if let Ok(file) = resolve_database_path(path) {
            candidates.push((file, "所选导航数据库".to_string()));
        }
    }
    for (file, label) in candidates {
        let Ok(connection) = open_read_only(&file) else {
            continue;
        };
        let Some(source) = detect_source(&connection) else {
            continue;
        };
        if has_procedures(&connection, source)? {
            let name = if matches!(source, NavigationSource::DfdV2) {
                format!("{label} · {}", source.label())
            } else {
                label
            };
            return Ok(Some((connection, source, name)));
        }
    }
    Ok(None)
}

pub(super) fn normalize_runway(value: &str) -> String {
    value
        .trim()
        .to_uppercase()
        .strip_prefix("RW")
        .unwrap_or(value.trim())
        .to_uppercase()
}

pub(super) fn push_unique(values: &mut Vec<String>, value: String) {
    if !value.is_empty() && !values.iter().any(|existing| existing == &value) {
        values.push(value);
    }
}

/// 宽容读取整数列。Fenix `nd.db3` 的 `Terminals.Proc` 是 **TEXT**（'1'=STAR、'2'=SID），
/// 而 rusqlite 的 `row.get::<_, i64>` 只接受 INTEGER 存储，会抛
/// `Invalid column type Text ... name: Proc`；不同导航库版本又可能存成 INTEGER，
/// 因此两种存储都兼容。
fn flexible_column_int(row: &rusqlite::Row<'_>, index: usize, name: &str) -> rusqlite::Result<i64> {
    match row.get_ref(index)? {
        ValueRef::Integer(value) => Ok(value),
        ValueRef::Real(value) => Ok(value as i64),
        ValueRef::Text(text) => std::str::from_utf8(text)
            .ok()
            .and_then(|text| text.trim().parse::<i64>().ok())
            .ok_or_else(|| {
                rusqlite::Error::FromSqlConversionFailure(
                    index,
                    rusqlite::types::Type::Text,
                    format!("列 {name} 的值不是合法整数").into(),
                )
            }),
        ValueRef::Blob(_) | ValueRef::Null => Ok(0),
    }
}

fn airport_procedures(
    connection: &Connection,
    source: NavigationSource,
    icao: &str,
) -> Result<
    (
        Vec<NavigationProcedureSummary>,
        Vec<NavigationProcedureSummary>,
        Vec<NavigationProcedureSummary>,
    ),
    String,
> {
    // DFD v2 把 SID / STAR / IAP 拆成三张表，逻辑完全不同，交给 dfdv2 模块。
    if matches!(source, NavigationSource::DfdV2) {
        return dfdv2::airport_procedures(connection, icao);
    }
    // Fenix Terminals.Proc：'1'=STAR、'2'=SID、'3'=进近（TEXT 存储，flexible_column_int 兼容）。
    let mut statement = connection.prepare("SELECT terminal.ID, terminal.Proc, terminal.Name, COALESCE(terminal.Rwy, ''), COALESCE(leg.Transition, '') FROM Terminals AS terminal LEFT JOIN TerminalLegs AS leg ON leg.TerminalID = terminal.ID WHERE UPPER(terminal.ICAO) = ?1 AND terminal.Proc IN (1, 2, 3) ORDER BY terminal.Proc, terminal.Name, terminal.ID, leg.ID").map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![icao.trim().to_uppercase()], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                flexible_column_int(row, 1, "Proc")?,
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
    let approaches = procedures
        .iter()
        .filter(|(procedure_type, _)| *procedure_type == 3)
        .map(|(_, summary)| summary.clone())
        .collect();
    let stars = procedures
        .into_iter()
        .filter(|(procedure_type, _)| *procedure_type == 1)
        .map(|(_, summary)| summary)
        .collect();
    Ok((sids, stars, approaches))
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
            |row| flexible_column_int(row, 0, "Proc"),
        )
        .map_err(|_| "找不到所选 SID/STAR".to_string())?;
    if procedure_type != 1 && procedure_type != 2 && procedure_type != 3 {
        return Err("所选数据不是 SID/STAR/进近程序".to_string());
    }
    let selected_runway = normalize_runway(runway);
    let selected_transition = transition.trim().to_uppercase();
    let mut statement = connection.prepare("SELECT COALESCE(waypoint.Ident, ''), COALESCE(waypoint.Name, ''), leg.WptLat, leg.WptLon, COALESCE(leg.Transition, ''), COALESCE(leg.TrackCode, ''), leg.CenterLat, leg.CenterLon, leg.Course FROM TerminalLegs AS leg LEFT JOIN Waypoints AS waypoint ON waypoint.ID = leg.WptID WHERE leg.TerminalID = ?1 ORDER BY leg.ID").map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![procedure_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<f64>>(2)?.unwrap_or_default(),
                row.get::<_, Option<f64>>(3)?.unwrap_or_default(),
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, Option<f64>>(6)?.unwrap_or_default(),
                row.get::<_, Option<f64>>(7)?.unwrap_or_default(),
                row.get::<_, Option<f64>>(8)?.unwrap_or_default(),
            ))
        })
        .map_err(|error| error.to_string())?;
    // 与 DFD v2 同一策略：过渡腿与公共腿分开收集，按程序类型拼接
    // （SID：跑道过渡→公共→航路过渡；STAR/进近：航路过渡→公共→跑道专属），
    // 避免 leg.ID 顺序把两组腿交错连成来回穿插的折线。
    let mut runway_legs: Vec<FlightRoutePoint> = Vec::new();
    let mut named_legs: Vec<FlightRoutePoint> = Vec::new();
    let mut common_legs: Vec<FlightRoutePoint> = Vec::new();
    let mut last_drawn: Option<(f64, f64)> = None;
    for (index, row) in rows.enumerate() {
        let (ident, name, latitude, longitude, leg_transition, track_code, center_latitude, center_longitude, course) =
            row.map_err(|error| error.to_string())?;
        let normalized_transition = leg_transition.trim().to_uppercase();
        let runway_leg = normalized_transition.starts_with("RW")
            && normalize_runway(&normalized_transition) == selected_runway;
        let named_transition =
            !selected_transition.is_empty() && normalized_transition == selected_transition;
        let is_transition_leg = !normalized_transition.is_empty() && normalized_transition != "ALL";
        if is_transition_leg && !runway_leg && !named_transition {
            continue;
        }
        let leg_type = {
            let code = track_code.trim().to_uppercase();
            (!code.is_empty()).then_some(code)
        };
        let has_coordinates = latitude.is_finite()
            && longitude.is_finite()
            && latitude.abs() <= 90.0
            && longitude.abs() <= 180.0
            && (latitude != 0.0 || longitude != 0.0);
        // CA/CD/CR/VA/VI 这类纯航向腿没有终点坐标（到高度/截获航向道为止），
        // 从上一个已绘点沿航向外推一个展示点，让这类航段在地图上可见（前端画虚线）。
        if !has_coordinates {
            if !course.is_finite() {
                continue;
            }
            let Some((previous_latitude, previous_longitude)) = last_drawn else {
                continue;
            };
            let stub = project_course(previous_latitude, previous_longitude, course, 6.0);
            let point = FlightRoutePoint {
                name: leg_type.clone().unwrap_or_else(|| "COURSE".to_string()),
                ident: leg_type.clone().unwrap_or_else(|| "COURSE".to_string()),
                latitude: stub.0,
                longitude: stub.1,
                leg_type: leg_type.clone(),
                arc_center: None,
                course: Some(course),
                course_only: true,
            };
            last_drawn = Some((point.latitude, point.longitude));
            if !is_transition_leg {
                common_legs.push(point);
            } else if runway_leg {
                runway_legs.push(point);
            } else {
                named_legs.push(point);
            }
            continue;
        }
        let ident = if ident.trim().is_empty() {
            format!("{}{}", track_code.trim(), index + 1)
        } else {
            ident.trim().to_string()
        };
        let arc_center = (leg_type.as_deref() == Some("RF")
            && center_latitude.is_finite()
            && center_longitude.is_finite()
            && (center_latitude != 0.0 || center_longitude != 0.0))
        .then_some((center_latitude, center_longitude));
        let point = FlightRoutePoint {
            name: if name.trim().is_empty() {
                ident.clone()
            } else {
                name.trim().to_string()
            },
            ident,
            latitude,
            longitude,
            leg_type: leg_type.clone(),
            arc_center,
            course: None,
            course_only: false,
        };
        last_drawn = Some((point.latitude, point.longitude));
        if !is_transition_leg {
            common_legs.push(point);
        } else if runway_leg {
            runway_legs.push(point);
        } else {
            named_legs.push(point);
        }
    }
    // TerminalLegs 的 Proc：'1'=STAR、'2'=SID、3=进近。
    let mut points = if procedure_type == 2 {
        let mut ordered = runway_legs;
        ordered.append(&mut common_legs);
        ordered.append(&mut named_legs);
        ordered
    } else {
        let mut ordered = named_legs;
        ordered.append(&mut common_legs);
        ordered.append(&mut runway_legs);
        ordered
    };
    points.dedup_by(|previous, current| same_route_position(previous, current));
    // 进近（Proc=3）：RWxx 收尾腿之后的腿属于复飞程序，不连进同一条折线。
    if procedure_type == 3 && !selected_runway.is_empty() {
        if let Some(index) = points
            .iter()
            .rposition(|point| !point.course_only && normalize_runway(&point.ident) == selected_runway)
        {
            points.truncate(index + 1);
        }
    }
    // 收尾去环：与 DFD v2 同一规则，末尾重复已访问位置的点（挂属性用的
    // 冗余记录）不画进折线，避免从出口点折回起点。
    while points.len() > 2 {
        let Some(last) = points.last() else { break };
        let (last_latitude, last_longitude) = (last.latitude, last.longitude);
        let revisits = points[..points.len() - 1].iter().any(|point| {
            (point.latitude - last_latitude).abs() < 1e-4
                && (point.longitude - last_longitude).abs() < 1e-4
        });
        if !revisits {
            break;
        }
        points.pop();
    }
    Ok(points)
}

/// 沿磁航向（度，从北顺时针）从起点外推指定海里数，返回 (lat, lon)。
/// 短距离（个位数海里）用平面近似即可。
pub(super) fn project_course(latitude: f64, longitude: f64, course_degrees: f64, distance_nm: f64) -> (f64, f64) {
    let radians = course_degrees.to_radians();
    let delta_latitude = distance_nm * radians.cos() / 60.0;
    let delta_longitude =
        distance_nm * radians.sin() / (60.0 * latitude.to_radians().cos().max(0.2));
    (latitude + delta_latitude, longitude + delta_longitude)
}

fn search_airports(
    connection: &Connection,
    source: &NavigationSource,
    query: &str,
) -> Result<Vec<NavigationAirport>, String> {
    if matches!(source, NavigationSource::DfdV2) {
        return dfdv2::search_airports(connection, query);
    }
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
    let icao_column = find_column(&columns, icao_candidates)
        .ok_or_else(|| format!("{} 机场表缺少 ICAO 字段", source.label()))?;
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

pub(super) fn format_frequency(value: &str) -> String {
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
    if matches!(source, NavigationSource::DfdV2) {
        return dfdv2::airport_details(connection, icao);
    }
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
    let requested = match source.as_str() {
        "lnm" => NavigationSource::Lnm,
        "fenix" => NavigationSource::Fenix,
        "dfdv2" => NavigationSource::DfdV2,
        _ => return Err("不支持的导航数据库源".to_string()),
    };
    let path = database_path
        .as_deref()
        .ok_or_else(|| "请选择导航数据库文件或目录".to_string())?;
    let status = database_status(requested, path)?;
    if !status.ready {
        return Err(status.message);
    }
    // Fenix 的 nd.db3 可能已经是 DFD v2 格式，两种都放行；LNM / DFD v2 则要求格式吻合。
    let detected = if status.source == "lnm" {
        NavigationSource::Lnm
    } else if status.source == "dfdv2" {
        NavigationSource::DfdV2
    } else {
        NavigationSource::Fenix
    };
    let compatible = matches!(requested, NavigationSource::Fenix)
        && matches!(detected, NavigationSource::Fenix | NavigationSource::DfdV2)
        || (matches!(requested, NavigationSource::Lnm) && matches!(detected, NavigationSource::Lnm))
        || (matches!(requested, NavigationSource::DfdV2) && matches!(detected, NavigationSource::DfdV2));
    if !compatible {
        return Err(format!(
            "所选文件是 {} 格式，与「{}」不符",
            detected.label(),
            requested.label()
        ));
    }
    // 保存实际识别出的格式：后续查询直接按真实表结构走，不会再猜。
    save_config(&NavigationConfig {
        source: detected,
        database_path: status.database_path.clone(),
    })?;
    Ok(status)
}

#[tauri::command]
pub fn get_navigation_database_status() -> Result<NavigationDatabaseStatus, String> {
    let config = read_config()?;
    match config.database_path {
        Some(path) => database_status(config.source, &path),
        None => Ok(NavigationDatabaseStatus {
            source: config.source.key().to_string(),
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
    let Some((connection, source, label)) = procedure_connection()? else {
        return Ok(NavigationAirportProcedures {
            source: "lnm".to_string(),
            ready: false,
            message: "当前导航库不含 SID/STAR 航段；可在设置中选择 Fenix nd.db3 或 Navigraph DFD v2 数据库。".to_string(),
            sids: Vec::new(),
            stars: Vec::new(),
            approaches: Vec::new(),
        });
    };
    let (sids, stars, approaches) = airport_procedures(&connection, source, &normalized)?;
    let message = if sids.is_empty() && stars.is_empty() && approaches.is_empty() {
        format!("{label} 中没有 {normalized} 的 SID/STAR/进近程序")
    } else {
        format!(
            "{label} · {} 条 SID · {} 条 STAR · {} 条进近",
            sids.len(),
            stars.len(),
            approaches.len()
        )
    };
    Ok(NavigationAirportProcedures {
        source: source.key().to_string(),
        ready: true,
        message,
        sids,
        stars,
        approaches,
    })
}

#[tauri::command]
pub fn get_navigation_procedure_points(
    procedure_id: i64,
    runway: Option<String>,
    transition: Option<String>,
) -> Result<Vec<FlightRoutePoint>, String> {
    let Some((connection, source, _)) = procedure_connection()? else {
        return Err("没有可用的 SID/STAR 数据库".to_string());
    };
    if matches!(source, NavigationSource::DfdV2) {
        return dfdv2::procedure_points(
            &connection,
            procedure_id,
            runway.as_deref().unwrap_or_default(),
            transition.as_deref().unwrap_or_default(),
        );
    }
    procedure_points(
        &connection,
        procedure_id,
        runway.as_deref().unwrap_or_default(),
        transition.as_deref().unwrap_or_default(),
    )
}

/// 跑道入口（threshold）坐标：离场/进场有程序航迹时，航路应从跑道入口
/// 起飞、到入口落地，而不是钉在机场参考点上。Fenix 的 Runways 表自带
/// 门槛经纬度；查询不到（无库/无此跑道/LNM 源）就返回 None，由前端回退。
#[tauri::command]
pub fn get_navigation_runway_threshold(
    icao: String,
    runway: String,
) -> Result<Option<FlightRoutePoint>, String> {
    let normalized = icao.trim().to_uppercase();
    let selected_runway = normalize_runway(&runway);
    if normalized.len() != 4 || selected_runway.is_empty() {
        return Ok(None);
    }
    let Some((connection, source, _)) = procedure_connection()? else {
        return Ok(None);
    };
    if matches!(source, NavigationSource::DfdV2) {
        return dfdv2::runway_threshold(&connection, normalized, selected_runway);
    }
    let mut statement = connection
        .prepare(
            "SELECT r.Latitude, r.Longtitude FROM Runways AS r \
             JOIN Airports AS a ON a.ID = r.AirportID \
             WHERE UPPER(TRIM(a.ICAO)) = ?1 AND UPPER(TRIM(r.Ident)) = ?2 LIMIT 1",
        )
        .map_err(|error| error.to_string())?;
    let threshold = statement
        .query_row(params![normalized, selected_runway], |row| {
            let latitude: Option<f64> = row.get(0)?;
            let longitude: Option<f64> = row.get(1)?;
            Ok((
                latitude.unwrap_or_default(),
                longitude.unwrap_or_default(),
            ))
        })
        .ok()
        .filter(|(latitude, longitude)| {
            latitude.is_finite()
                && longitude.is_finite()
                && latitude.abs() <= 90.0
                && longitude.abs() <= 180.0
                && (*latitude != 0.0 || *longitude != 0.0)
        })
        .map(|(latitude, longitude)| FlightRoutePoint {
            name: format!("RW{selected_runway}"),
            ident: format!("RW{selected_runway}"),
            latitude,
            longitude,
            leg_type: None,
            arc_center: None,
            course: None,
            course_only: false,
        });
    Ok(threshold)
}

/// 程序对应跑道的两端坐标（画跑道 + 自动框选用）。
/// DFD v2 的 `tbl_pg_runways` 每端一行，选中端 + 反方向端一起返回；
/// 其它导航库只有单端坐标，对端留空。
#[tauri::command]
pub fn get_navigation_runway_ends(
    icao: String,
    runway: String,
) -> Result<Option<RunwayEnds>, String> {
    let normalized = icao.trim().to_uppercase();
    let selected_runway = normalize_runway(&runway);
    if normalized.len() != 4 || selected_runway.is_empty() {
        return Ok(None);
    }
    let Some((connection, source, _)) = procedure_connection()? else {
        return Ok(None);
    };
    if matches!(source, NavigationSource::DfdV2) {
        return dfdv2::runway_ends(&connection, normalized, selected_runway);
    }
    let threshold = get_navigation_runway_threshold(normalized, runway.clone())?;
    Ok(threshold.map(|point| RunwayEnds {
        runway: selected_runway.clone(),
        primary: RunwayEnd { ident: selected_runway, latitude: point.latitude, longitude: point.longitude },
        reciprocal: None,
    }))
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
                reporting: None,
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
    if matches!(source, NavigationSource::DfdV2) {
        return dfdv2::map_airports(connection, west, south, east, north);
    }
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
                reporting: None,
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
    if matches!(source, NavigationSource::DfdV2) {
        return dfdv2::map_points(connection, west, south, east, north);
    }
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
        // 已在函数入口分流，这里只用于满足穷尽匹配。
        NavigationSource::DfdV2 => (&[], &[], &[]),
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

/// ───────────────────────── 班机航路航点坐标解析 ─────────────────────────

/// 单表批量查询：`match_column` 的值（大写化后）命中 `values` 时取坐标。
/// 命中结果并入 `fixes`，已有的键不覆盖（前面的表优先级更高）。
fn lookup_fixes_by_column(
    connection: &Connection,
    table: &str,
    match_column: &str,
    name_column: Option<&String>,
    latitude_column: &str,
    longitude_column: &str,
    values: &[String],
    fixes: &mut HashMap<String, [f64; 2]>,
) -> Result<(), String> {
    for chunk in values.chunks(300) {
        if chunk.is_empty() {
            continue;
        }
        let placeholders = vec!["?"; chunk.len()].join(",");
        let sql = format!(
            "SELECT UPPER(TRIM(CAST({m} AS TEXT))), {n}, {la}, {lo} \
             FROM {t} WHERE UPPER(TRIM(CAST({m} AS TEXT))) IN ({ph})",
            m = quote_identifier(match_column),
            n = text_expression(name_column.cloned()),
            la = quote_identifier(latitude_column),
            lo = quote_identifier(longitude_column),
            t = quote_identifier(table),
            ph = placeholders,
        );
        let mut statement = match connection.prepare(&sql) {
            Ok(statement) => statement,
            // 列名在个别数据批次里可能对不上：跳过这张表，别让整次查询失败。
            Err(_) => continue,
        };
        let rows = statement.query_map(params_from_iter(chunk.iter()), |row| {
            let ident: String = row.get(0)?;
            let latitude: Option<f64> = row.get(2)?;
            let longitude: Option<f64> = row.get(3)?;
            Ok((ident, latitude, longitude))
        });
        let rows = match rows {
            Ok(rows) => rows,
            Err(_) => continue,
        };
        for row in rows.flatten() {
            let (ident, latitude, longitude) = row;
            if let (Some(latitude), Some(longitude)) = (latitude, longitude) {
                if latitude.is_finite() && longitude.is_finite() {
                    fixes.entry(ident).or_insert([latitude, longitude]);
                }
            }
        }
    }
    Ok(())
}

/// 按标识在当前导航库里批量查坐标（班机航路的航路点解析用）。
///
/// 查找顺序：航路点 → VHF/DME → NDB → 机场，先命中先用。NAIP 的 NDB 点
/// 标识带「NDB」字样（如「张庄NDB」），所以对没命中的标签再用去掉后缀的
/// 变体在各表**名称列**补一轮。返回 标识（大写）→ [纬度, 经度]。
fn lookup_fixes(
    connection: &Connection,
    source: NavigationSource,
    labels: &[String],
) -> Result<HashMap<String, [f64; 2]>, String> {
    let mut wanted: Vec<String> = labels
        .iter()
        .map(|label| label.trim().to_uppercase())
        .filter(|label| !label.is_empty())
        .collect();
    wanted.sort();
    wanted.dedup();

    // 标识候选：原标识 + 去掉导航台后缀的变体。
    let mut candidates = wanted.clone();
    for label in &wanted {
        for suffix in ["VORDME", "DVOR", "TACAN", "NDB", "VOR", "DME"] {
            if let Some(stripped) = label.strip_suffix(suffix) {
                let trimmed = stripped.trim().to_string();
                if !trimmed.is_empty() {
                    candidates.push(trimmed);
                }
            }
        }
    }
    candidates.sort();
    candidates.dedup();

    // (表名, 标识列候选, 名称列候选, 纬度列候选, 经度列候选)，按优先级排序。
    let tables: &[(&str, &[&str], &[&str], &[&str], &[&str])] = match source {
        NavigationSource::DfdV2 => &[
            (
                "tbl_ea_enroute_waypoints",
                &["waypoint_identifier"],
                &["waypoint_name"],
                &["waypoint_latitude"],
                &["waypoint_longitude"],
            ),
            (
                "tbl_d_vhfnavaids",
                &["navaid_identifier"],
                &["navaid_name"],
                &["navaid_latitude"],
                &["navaid_longitude"],
            ),
            (
                "tbl_db_enroute_ndbnavaids",
                &["navaid_identifier"],
                &["navaid_name"],
                &["navaid_latitude"],
                &["navaid_longitude"],
            ),
            (
                "tbl_pn_terminal_ndbnavaids",
                &["navaid_identifier"],
                &["navaid_name"],
                &["navaid_latitude"],
                &["navaid_longitude"],
            ),
            (
                "tbl_pa_airports",
                &["airport_identifier", "ident"],
                &["airport_name", "name"],
                &["airport_latitude", "latitude"],
                &["airport_longitude", "longitude"],
            ),
        ],
        NavigationSource::Lnm => &[
            ("waypoint", &["ident"], &["name"], &["laty", "latitude", "lat"], &["lonx", "longitude", "lon"]),
            ("vor", &["ident"], &["name"], &["laty", "latitude", "lat"], &["lonx", "longitude", "lon"]),
            ("ndb", &["ident"], &["name"], &["laty", "latitude", "lat"], &["lonx", "longitude", "lon"]),
            ("airport", &["ident", "icao"], &["name"], &["laty", "latitude", "lat"], &["lonx", "longitude", "lon"]),
        ],
        NavigationSource::Fenix => &[
            (
                "Waypoints",
                &["ident", "identifier", "code", "name"],
                &["name", "description", "ident"],
                &["latitude", "lat", "laty", "latitude_degrees"],
                &["longitude", "longtitude", "lon", "lonx", "longitude_degrees"],
            ),
            (
                "Navaids",
                &["ident", "identifier", "code", "name"],
                &["name", "description", "ident"],
                &["latitude", "lat", "laty", "latitude_degrees"],
                &["longitude", "longtitude", "lon", "lonx", "longitude_degrees"],
            ),
            (
                "Airports",
                &["icao", "icao_code", "ident", "identifier"],
                &["name", "airport_name"],
                &["latitude", "lat", "laty", "latitude_degrees"],
                &["longitude", "longtitude", "lon", "lonx", "longitude_degrees"],
            ),
        ],
    };

    let mut fixes: HashMap<String, [f64; 2]> = HashMap::new();
    for (table, ident_candidates, name_candidates, lat_candidates, lon_candidates) in tables {
        if !table_exists(connection, table)? {
            continue;
        }
        let columns = table_columns(connection, table)?;
        let Some(ident) = find_column(&columns, ident_candidates) else {
            continue;
        };
        let name = find_column(&columns, name_candidates);
        let (Some(latitude), Some(longitude)) = (
            find_column(&columns, lat_candidates),
            find_column(&columns, lon_candidates),
        ) else {
            continue;
        };
        lookup_fixes_by_column(
            connection,
            table,
            &ident,
            name.as_ref(),
            &latitude,
            &longitude,
            &candidates,
            &mut fixes,
        )?;
    }

    // 名称补查：标识没命中的，用去后缀变体去撞名称列（NDB 中文名的场景）。
    let unresolved: Vec<String> = wanted
        .iter()
        .filter(|label| !fixes.contains_key(*label))
        .flat_map(|label| {
            let mut variants = vec![label.clone()];
            for suffix in ["VORDME", "DVOR", "TACAN", "NDB", "VOR", "DME"] {
                if let Some(stripped) = label.strip_suffix(suffix) {
                    let trimmed = stripped.trim().to_string();
                    if !trimmed.is_empty() {
                        variants.push(trimmed);
                    }
                }
            }
            variants
        })
        .collect();
    if !unresolved.is_empty() {
        for (table, _ident_candidates, name_candidates, lat_candidates, lon_candidates) in tables {
            if !table_exists(connection, table)? {
                continue;
            }
            let columns = table_columns(connection, table)?;
            let Some(name) = find_column(&columns, name_candidates) else {
                continue;
            };
            let (Some(latitude), Some(longitude)) = (
                find_column(&columns, lat_candidates),
                find_column(&columns, lon_candidates),
            ) else {
                continue;
            };
            // 名称补查时不需要再嵌套查名称列，给 None 即可。
            lookup_fixes_by_column(
                connection,
                table,
                &name,
                None,
                &latitude,
                &longitude,
                &unresolved,
                &mut fixes,
            )?;
        }
    }
    Ok(fixes)
}

/// 班机航路航点坐标解析入口（给 naip.rs 用）：打开当前导航库批量查询。
pub fn resolve_route_fixes(labels: Vec<String>) -> Result<HashMap<String, [f64; 2]>, String> {
    let config = read_config()?;
    let Some(path) = config.database_path else {
        return Err("尚未选择导航数据库，无法解析班机航路的航点坐标".to_string());
    };
    let connection = open_read_only(Path::new(&path))?;
    lookup_fixes(&connection, config.source, &labels)
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
            level: segment.airway_type.clone(),
            minimum_altitude: segment.minimum_altitude,
            maximum_altitude: segment.maximum_altitude,
        })
        .collect();
    // 整条航路的级别：各段一致取该值，混杂（同一航路高低空分段）归入双层，
    // 对应 Jeppesen 图例 ENRT-H/L 行；Fenix 的 Level 就是权威值，LNM 走原有 airway_type。
    let airway_type = if segments.iter().all(|segment| segment.airway_type == segments[0].airway_type) {
        segments[0].airway_type.clone()
    } else {
        "B".to_string()
    };
    NavigationAirway {
        name: segments[0].name.clone(),
        airway_type,
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
    let sql = format!("SELECT airway.Ident, leg.AirwayID, leg.ID, leg.Waypoint1ID, leg.Waypoint2ID, leg.IsStart, waypoint1.Longtitude, waypoint1.Latitude, waypoint2.Longtitude, waypoint2.Latitude, leg.Level FROM AirwayLegs AS leg JOIN Airways AS airway ON airway.ID = leg.AirwayID JOIN Waypoints AS waypoint1 ON waypoint1.ID = leg.Waypoint1ID JOIN Waypoints AS waypoint2 ON waypoint2.ID = leg.Waypoint2ID WHERE MAX(waypoint1.Latitude, waypoint2.Latitude) >= ?1 AND MIN(waypoint1.Latitude, waypoint2.Latitude) <= ?2 AND MAX(waypoint1.Longtitude, waypoint2.Longtitude) >= ?3 AND MIN(waypoint1.Longtitude, waypoint2.Longtitude) <= ?4 ORDER BY leg.AirwayID, leg.ID LIMIT {limit}");
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![south, north, west, east], |row| {
            Ok(AirwaySegment {
                name: row.get(0)?,
                // Fenix 的 Level 直接存了航段高度层（L/H/B），Jeppesen 图例里
                // ENRT-L / ENRT-H / ENRT-H/L 的区分依据就是它。
                airway_type: row.get(10)?,
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
    // 行数预算按「去重后的航路点」计（dfdv2 查询里已按 seqno GROUP BY 去掉
    // 高度层重复行），比按原始行计稠密约 6 倍，因此预算可以给大。
    let limit = if zoom < 4.5 {
        3_000
    } else if zoom < 6.0 {
        8_000
    } else if zoom < 8.0 {
        15_000
    } else {
        20_000
    };
    match source {
        NavigationSource::Lnm => map_lnm_airways(connection, west, south, east, north, limit),
        NavigationSource::Fenix => map_fenix_airways(connection, west, south, east, north, limit),
        NavigationSource::DfdV2 => {
            dfdv2::map_airways(connection, west, south, east, north, limit)
        }
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
        // 以下三类当前数据源（LNM / Fenix 导航库）没有对应表，
        // 先固定为空集；接入数据后在此填充即可，前端契约已就绪。
        holding_patterns: Vec::new(),
        mora_cells: Vec::new(),
        special_use_airspace: Vec::new(),
    })
}

#[cfg(test)]
mod dfdv2_tests {
    use super::*;

    /// 临时诊断：用真实配置（用户当前选择的数据库）跑地图数据查询。
    #[test]
    fn debug_real_map_data() {
        let data = get_navigation_map_data(73.0, 18.0, 135.0, 54.0, 6.0).expect("map data");
        println!("airports={} navaids={} airways={}", data.airports.len(), data.navaids.len(), data.airways.len());
        println!("airway sample: {:?}", data.airways.iter().take(3).map(|a| (&a.name, a.coordinates.len())).collect::<Vec<_>>());
        println!("wpt sample: {:?}", data.navaids.iter().take(3).map(|p| (&p.name, &p.kind)).collect::<Vec<_>>());
    }

    /// 临时诊断：ZGSD 进近的点序回归 —— 过渡腿在前、公共腿在后，
    /// RWxx 收尾后不得再出现复飞腿（此前按 seqno 全局排序画成交叉线）。
    #[test]
    fn debug_real_zgsd_approach_order() {
        use crate::commands::dfdv2::PROCEDURE_ID_SCALE;
        let (connection, source, _) = procedure_connection().expect("db").expect("configured db");
        if !matches!(source, NavigationSource::DfdV2) {
            println!("skip: 当前导航库不是 DFD v2");
            return;
        }
        for (name, runway, transition, expect_last, banned, expect_order) in [
            ("I05-Y", "05", "GURIN", "RW05", vec!["D222A"], None),
            (
                "I23-Y",
                "23",
                "UJ",
                "RW23",
                vec![],
                Some(vec!["UJ", "D210A", "D210B", "D167A", "CI23", "FI23", "RW23"]),
            ),
            (
                "I23-Z",
                "23",
                "SD418",
                "RW23",
                vec!["SD426", "SD423"],
                Some(vec!["SD418", "SD514", "SD513", "SD512", "FI23", "RW23"]),
            ),
        ] {
            let rowid: i64 = connection
                .query_row(
                    "SELECT MIN(rowid) FROM tbl_pf_iaps \
                     WHERE UPPER(TRIM(airport_identifier))='ZGSD' AND procedure_identifier=?1",
                    params![name],
                    |row| row.get(0),
                )
                .expect("rowid");
            let points = dfdv2::procedure_points(&connection, 3 * PROCEDURE_ID_SCALE + rowid, runway, transition)
                .expect("points");
            let idents: Vec<&str> = points.iter().map(|p| p.ident.as_str()).collect();
            println!("{name} {} → {:?}", transition, idents);
            assert_eq!(idents.last().copied(), Some(expect_last), "{name} 应在 RWxx 收尾");
            for ident in &banned {
                assert!(!idents.contains(ident), "{name} 复飞腿 {ident} 不应出现");
            }
            if let Some(order) = expect_order {
                assert_eq!(idents, order, "{name} 过渡应先于公共段且无交叉");
            }
        }
        // SID MIPAG7：公共段末尾重复 ZAO 的记录是挂过渡高度的冗余行，
        // 折线应在出口点 MIPAG 结束，不得折回 ZAO。
        {
            let rowid: i64 = connection
                .query_row(
                    "SELECT MIN(rowid) FROM tbl_pd_sids \
                     WHERE UPPER(TRIM(airport_identifier))='ZGSD' AND procedure_identifier='MIPAG7'",
                    params![],
                    |row| row.get(0),
                )
                .expect("rowid");
            let points = dfdv2::procedure_points(&connection, 1 * PROCEDURE_ID_SCALE + rowid, "05", "RW05")
                .expect("points");
            let idents: Vec<&str> = points.iter().map(|p| p.ident.as_str()).collect();
            println!("MIPAG7 RW05 → {:?}", idents);
            assert_eq!(idents, vec!["DE05", "D225A", "ZAO", "GUBLO", "MIPAG"]);
        }
    }

    /// 最小 DFD v2 数据集：字段名与官方规范逐字一致，只建本模块用到的列。
    fn fixture() -> Connection {
        let connection = Connection::open_in_memory().expect("in-memory db");
        connection
            .execute_batch(
                r#"
                CREATE TABLE tbl_hdr_header (cycle TEXT, dataset_version TEXT);
                INSERT INTO tbl_hdr_header VALUES ('2610', '2.0.10.2610');

                CREATE TABLE tbl_pa_airports (
                    airport_identifier TEXT, ata_iata_code TEXT, airport_name TEXT, city TEXT,
                    elevation REAL, airport_ref_latitude REAL, airport_ref_longitude REAL,
                    ifr_capability TEXT
                );
                INSERT INTO tbl_pa_airports VALUES
                    ('ZBAA', 'PEK', 'BEIJING/CAPITAL', 'BEIJING', 116, 40.0725, 116.5847, 'Y'),
                    ('ZBAD', 'PKX', 'BEIJING/DAXING', 'BEIJING', 98, 39.5098, 116.4105, 'Y');

                CREATE TABLE tbl_pg_runways (
                    airport_identifier TEXT, runway_identifier TEXT, runway_length REAL,
                    runway_latitude REAL, runway_longitude REAL, surface_code TEXT
                );
                INSERT INTO tbl_pg_runways VALUES
                    ('ZBAA', '18L', 12468, 40.0900, 116.5600, 'A'),
                    ('ZBAA', '36R', 12468, 40.0550, 116.6100, 'C');

                CREATE TABLE tbl_pv_airport_communication (
                    airport_identifier TEXT, communication_type TEXT, callsign TEXT,
                    communication_frequency REAL, sectorization TEXT
                );
                INSERT INTO tbl_pv_airport_communication VALUES
                    ('ZBAA', 'TWR', 'BEIJING TOWER', 118.5, ''),
                    ('ZBAA', 'ATIS', 'BEIJING ATIS', 127.6, '');

                CREATE TABLE tbl_ea_enroute_waypoints (
                    waypoint_identifier TEXT, waypoint_name TEXT,
                    waypoint_latitude REAL, waypoint_longitude REAL
                );
                INSERT INTO tbl_ea_enroute_waypoints VALUES
                    ('DOTRA', 'DOTRA', 40.0, 116.0),
                    ('ELKUR', 'ELKUR', 41.0, 117.0),
                    ('SAPIN', 'SAPIN', 42.0, 118.0);

                CREATE TABLE tbl_pc_terminal_waypoints (
                    waypoint_identifier TEXT, waypoint_name TEXT,
                    waypoint_latitude REAL, waypoint_longitude REAL
                );
                INSERT INTO tbl_pc_terminal_waypoints VALUES ('BOTOP', 'BOTOP', 40.5, 117.2);

                CREATE TABLE tbl_d_vhfnavaids (
                    navaid_identifier TEXT, navaid_name TEXT, navaid_latitude REAL,
                    navaid_longitude REAL, navaid_class TEXT, navaid_frequency REAL
                );
                INSERT INTO tbl_d_vhfnavaids VALUES ('PEK', 'BEIJING', 40.1, 116.6, 'VD', 114.7);

                CREATE TABLE tbl_db_enroute_ndbnavaids (
                    navaid_identifier TEXT, navaid_name TEXT, navaid_latitude REAL,
                    navaid_longitude REAL, navaid_class TEXT
                );
                INSERT INTO tbl_db_enroute_ndbnavaids VALUES ('ZB', 'BEIJING', 40.2, 116.5, 'H');

                CREATE TABLE tbl_pn_terminal_ndbnavaids (
                    navaid_identifier TEXT, navaid_name TEXT, navaid_latitude REAL,
                    navaid_longitude REAL, navaid_class TEXT
                );

                CREATE TABLE tbl_er_enroute_airways (
                    route_identifier TEXT, route_identifier_postfix TEXT, flightlevel TEXT,
                    direction_restriction TEXT, seqno REAL, waypoint_identifier TEXT,
                    waypoint_latitude REAL, waypoint_longitude REAL,
                    minimum_altitude1 REAL, maximum_altitude REAL
                );
                INSERT INTO tbl_er_enroute_airways VALUES
                    -- seqno 模拟真实数据：全局序列号，间隔不规则（190/200/210）
                    ('A461', '', 'H', '', 190, 'DOTRA', 40.0, 116.0, 8900, 12500),
                    ('A461', '', 'H', '', 200, 'ELKUR', 41.0, 117.0, 8900, 12500),
                    ('A461', '', 'H', '', 210, 'SAPIN', 42.0, 118.0, 8900, 12500),
                    -- 同一航路点在不同飞行高度层重复成行：画图必须去重成一份几何
                    ('A461', '', 'L', '', 190, 'DOTRA', 40.0, 116.0, 6600, 8900),
                    ('A461', '', 'L', '', 200, 'ELKUR', 41.0, 117.0, 6600, 8900),
                    ('A461', '', 'L', '', 210, 'SAPIN', 42.0, 118.0, 6600, 8900);

                CREATE TABLE tbl_pd_sids (
                    airport_identifier TEXT, procedure_identifier TEXT, transition_identifier TEXT,
                    route_type TEXT, seqno REAL, waypoint_identifier TEXT,
                    waypoint_latitude REAL, waypoint_longitude REAL, path_termination TEXT,
                    course REAL, center_waypoint_latitude REAL, center_waypoint_longitude REAL
                );
                INSERT INTO tbl_pd_sids VALUES
                    ('ZBAA', 'ELKUR1D', 'RW18L', '1', 10, 'RW18L', 40.09, 116.56, 'TF', NULL, NULL, NULL),
                    ('ZBAA', 'ELKUR1D', 'RW18L', '1', 20, '', 40.20, 116.70, 'TF', NULL, NULL, NULL),
                    ('ZBAA', 'ELKUR1D', '', '2', 30, 'BOTOP', 40.50, 117.20, 'TF', NULL, NULL, NULL),
                    ('ZBAA', 'ELKUR1D', 'DOTRA', '3', 40, 'DOTRA', 41.00, 117.50, 'TF', NULL, NULL, NULL);

                CREATE TABLE tbl_pe_stars (
                    airport_identifier TEXT, procedure_identifier TEXT, transition_identifier TEXT,
                    route_type TEXT, seqno REAL, waypoint_identifier TEXT,
                    waypoint_latitude REAL, waypoint_longitude REAL, path_termination TEXT,
                    course REAL, center_waypoint_latitude REAL, center_waypoint_longitude REAL
                );
                INSERT INTO tbl_pe_stars VALUES
                    ('ZBAA', 'DOTRA2A', 'RW36R', '3', 10, 'DOTRA', 41.00, 117.50, 'TF', NULL, NULL, NULL),
                    ('ZBAA', 'DOTRA2A', 'RW36R', '3', 20, 'RW36R', 40.06, 116.61, 'TF', NULL, NULL, NULL);

                CREATE TABLE tbl_pf_iaps (
                    airport_identifier TEXT, procedure_identifier TEXT, transition_identifier TEXT,
                    route_type TEXT, seqno REAL, waypoint_identifier TEXT,
                    waypoint_latitude REAL, waypoint_longitude REAL, path_termination TEXT,
                    course REAL, center_waypoint_latitude REAL, center_waypoint_longitude REAL
                );
                INSERT INTO tbl_pf_iaps VALUES
                    ('ZBAA', 'ILS18L', 'DOTRA', '1', 10, 'DOTRA', 41.00, 117.50, 'TF', NULL, NULL, NULL),
                    ('ZBAA', 'ILS18L', '', '2', 20, 'FF18L', 40.15, 116.58, 'TF', NULL, NULL, NULL),
                    ('ZBAA', 'ILS18L', '', '2', 30, 'MA18L', 40.00, 116.55, 'TF', NULL, NULL, NULL);
                "#,
            )
            .expect("fixture schema");
        connection
    }

    #[test]
    fn detects_dfdv2_schema() {
        assert!(matches!(
            detect_source(&fixture()),
            Some(NavigationSource::DfdV2)
        ));
    }

    #[test]
    fn reads_header_cycle() {
        let connection = fixture();
        assert_eq!(dfdv2::cycle(&connection).as_deref(), Some("2610"));
        assert_eq!(
            dfdv2::dataset_version(&connection).as_deref(),
            Some("2.0.10.2610")
        );
    }

    #[test]
    fn searches_and_describes_airports() {
        let connection = fixture();
        let airports = dfdv2::search_airports(&connection, "pek").expect("search");
        assert_eq!(airports.len(), 1);
        assert_eq!(airports[0].icao, "ZBAA");
        assert_eq!(airports[0].elevation, "116 ft");

        let details = dfdv2::airport_details(&connection, "zbaa").expect("details");
        assert_eq!(details.runways.len(), 2);
        assert!(details.runways[0].starts_with("18L · 12,468 ft"));
        assert!(details.runways[0].ends_with("沥青"));
        // ATIS 排在塔台前面（communication_rank 决定）。
        assert_eq!(details.frequencies[0].name, "BEIJING ATIS");
        assert_eq!(details.frequencies[0].value, "127.600");
        assert_eq!(details.frequencies[1].value, "118.500");
    }

    #[test]
    fn maps_waypoints_and_navaids() {
        let connection = fixture();
        let points =
            dfdv2::map_points(&connection, 110.0, 35.0, 125.0, 45.0).expect("map points");
        let ident = |name: &str| points.iter().find(|point| point.ident == name);
        assert_eq!(ident("DOTRA").map(|point| point.symbol.as_str()), Some("waypoint"));
        assert_eq!(ident("BOTOP").map(|point| point.kind.as_str()), Some("终端航路点"));
        assert_eq!(ident("PEK").map(|point| point.symbol.as_str()), Some("vor-dme"));
        assert_eq!(ident("ZB").map(|point| point.symbol.as_str()), Some("ndb"));
    }

    #[test]
    fn rebuilds_airway_chain() {
        let connection = fixture();
        let airways =
            dfdv2::map_airways(&connection, 110.0, 35.0, 125.0, 45.0, 4000).expect("airways");
        // 同一航路在不同高度层重复的行必须去重：只产出一条 3 点几何，而不是两条碎片链
        assert_eq!(airways.len(), 1);
        let airway = &airways[0];
        assert_eq!(airway.name, "A461");
        assert_eq!(airway.airway_type, "H");
        assert_eq!(airway.coordinates.len(), 3);
        assert_eq!(airway.legs.len(), 2);
        assert_eq!(airway.legs[0].minimum_altitude, Some(6600));
        assert_eq!(airway.legs[0].maximum_altitude, Some(12500));
    }

    #[test]
    fn lists_procedures_by_kind() {
        let connection = fixture();
        let (sids, stars, approaches) =
            dfdv2::airport_procedures(&connection, "ZBAA").expect("procedures");
        assert_eq!(sids.len(), 1);
        assert_eq!(sids[0].name, "ELKUR1D");
        assert_eq!(sids[0].runways, vec!["18L".to_string()]);
        assert_eq!(sids[0].transitions, vec!["DOTRA".to_string()]);
        assert_eq!(stars[0].runways, vec!["36R".to_string()]);
        assert_eq!(approaches[0].name, "ILS18L");
    }

    #[test]
    fn resolves_procedure_legs_by_runway_and_transition() {
        let connection = fixture();
        let (sids, _, _) = dfdv2::airport_procedures(&connection, "ZBAA").expect("procedures");
        let points = dfdv2::procedure_points(&connection, sids[0].id, "18L", "DOTRA")
            .expect("procedure points");
        let idents: Vec<&str> = points.iter().map(|point| point.ident.as_str()).collect();
        assert_eq!(idents, vec!["RW18L", "TF2", "BOTOP", "DOTRA"]);
        assert_eq!(points[0].leg_type.as_deref(), Some("TF"));

        // 不选过渡点时只保留公共航段 + 跑道转换段。
        let common =
            dfdv2::procedure_points(&connection, sids[0].id, "18L", "").expect("common legs");
        assert_eq!(common.len(), 3);

        // 程序编号里编码了种类，串到别的表会解析回同一个程序。
        let _ = connection;
    }

    #[test]
    fn decodes_procedure_id_across_tables() {
        let connection = fixture();
        let (_, _, approaches) =
            dfdv2::airport_procedures(&connection, "ZBAA").expect("procedures");
        let kind = approaches[0].id / dfdv2::PROCEDURE_ID_SCALE;
        assert_eq!(kind, 3);
        let points = dfdv2::procedure_points(&connection, approaches[0].id, "", "")
            .expect("approach legs");
        assert_eq!(points.len(), 2);
    }

    #[test]
    fn dispatches_through_navigation_source() {
        // 这里调用的是 navigation.rs 自己的入口函数，验证「识别 → 分流」这一段没漏。
        let connection = fixture();
        let source = detect_source(&connection).expect("source");
        let bounds = (110.0, 35.0, 125.0, 45.0);

        let airports = search_airports(&connection, &source, "ZBAA").expect("search dispatch");
        assert_eq!(airports.len(), 1);
        assert_eq!(airports[0].name, "BEIJING/CAPITAL");

        let details = airport_details(&connection, &source, "ZBAA").expect("details dispatch");
        assert_eq!(details.runways.len(), 2);
        assert!(!details.frequencies.is_empty());

        let mapped = map_airports(&connection, &source, bounds.0, bounds.1, bounds.2, bounds.3)
            .expect("map airports dispatch");
        assert_eq!(mapped.len(), 2);
        assert_eq!(mapped[0].symbol, "airport-ifr");

        let points = map_navaids(&connection, &source, bounds.0, bounds.1, bounds.2, bounds.3)
            .expect("map navaids dispatch");
        assert!(points.iter().any(|point| point.ident == "DOTRA"));

        let airways = map_airways(&connection, &source, bounds.0, bounds.1, bounds.2, bounds.3, 3.0)
            .expect("map airways dispatch");
        assert_eq!(airways.len(), 1);

        let (sids, stars, approaches) =
            airport_procedures(&connection, source, "ZBAA").expect("procedure dispatch");
        assert_eq!((sids.len(), stars.len(), approaches.len()), (1, 1, 1));
    }

    #[test]
    fn resolves_directory_to_database_file() {
        let root = std::env::temp_dir().join(format!("efb-dfdv2-{}", std::process::id()));
        let navdata = root.join("Navdata");
        fs::create_dir_all(&navdata).expect("temp dir");
        let database = navdata.join("nd.db3");
        {
            let connection = Connection::open(&database).expect("create db");
            connection
                .execute_batch("CREATE TABLE tbl_pa_airports (airport_identifier TEXT);")
                .expect("schema");
        }
        let resolved = resolve_database_path(&root.to_string_lossy()).expect("resolve");
        assert_eq!(resolved.file_name().and_then(|name| name.to_str()), Some("nd.db3"));

        // 直接给文件路径也要原样返回。
        let direct = resolve_database_path(&database.to_string_lossy()).expect("direct");
        assert_eq!(direct, database);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn finds_runway_threshold() {
        let connection = fixture();
        let threshold = dfdv2::runway_threshold(&connection, "ZBAA".to_string(), "18L".to_string())
            .expect("threshold")
            .expect("some threshold");
        assert_eq!(threshold.ident, "RW18L");
        assert!((threshold.latitude - 40.09).abs() < 1e-6);
        assert!((threshold.longitude - 116.56).abs() < 1e-6);

        assert!(dfdv2::runway_threshold(&connection, "ZBAA".to_string(), "09".to_string())
            .expect("missing runway")
            .is_none());
    }
}

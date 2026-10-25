//! Navigraph DFD v2 导航数据读取层。
//!
//! 表名与字段名严格遵循 DFD Data Format v2 规范：
//! <https://developers.navigraph.com/docs/navigation-data/dfd-data-format-v2>
//!
//! 该规范由 ARINC 424 记录直接落库，**没有声明主键与外键**，所有关联都靠
//! `airport_identifier` / `waypoint_identifier` / `route_identifier` + `seqno`
//! 这些业务键完成，因此本模块：
//!
//! - 机场、跑道、频率、航路点、导航台都用 `airport_identifier` 直连；
//! - 航路以「一条航路 = 同一 `route_identifier` + `route_identifier_postfix`
//!   + `flightlevel` 下 `seqno` 连续的航路点序列」重建，相邻点连成一段；
//! - SID / STAR / IAP 是**三张独立的航段表**（`tbl_pd_sids` /
//!   `tbl_pe_stars` / `tbl_pf_iaps`），一行一个航段。前端只需要一个整数
//!   `procedure_id`，所以用 `种类 × 1e10 + 该程序首行的 rowid` 合成，
//!   反查时再用 rowid 回到原行取机场与程序名。
//!
//! 跑道转换在 ARINC 424 里不是独立字段，而是把 `transition_identifier`
//! 写成 `RW18L` 这种形式；因此「跑道」与「过渡点」都从同一列拆出来，
//! 与 Fenix 旧库的 `Terminals.Rwy` / `TerminalLegs.Transition` 语义对齐。

use super::flightplan::FlightRoutePoint;
use super::navigation::{
    find_column, format_frequency, normalize_runway, number_expression, project_course,
    push_unique, quote_identifier, table_columns, table_exists, text_expression,
    NavigationAirport, NavigationAirportDetails, NavigationAirway, NavigationAirwayLeg,
    NavigationFrequency, NavigationMapPoint, NavigationProcedureSummary, RunwayEnd, RunwayEnds,
};
use rusqlite::{params, Connection};
use std::collections::HashMap;

/// 程序编号的合成基数：`id = 种类 * SCALE + rowid`。
/// 取 1e10 既保证 JS number 安全（< 2^53），也远大于任何实际表行数。
pub(super) const PROCEDURE_ID_SCALE: i64 = 10_000_000_000;

/// 程序种类 → DFD v2 航段表。
fn procedure_table(kind: i64) -> Option<&'static str> {
    match kind {
        1 => Some("tbl_pd_sids"),
        2 => Some("tbl_pe_stars"),
        3 => Some("tbl_pf_iaps"),
        _ => None,
    }
}

fn procedure_kind_name(kind: i64) -> &'static str {
    match kind {
        1 => "SID",
        2 => "STAR",
        3 => "进近",
        _ => "程序",
    }
}

// ───────────────────────────── 元数据 ─────────────────────────────

/// `tbl_hdr_header.cycle`（四位 AIRAC 周期号）。
pub(super) fn cycle(connection: &Connection) -> Option<String> {
    if !table_exists(connection, "tbl_hdr_header").ok()? {
        return None;
    }
    let columns = table_columns(connection, "tbl_hdr_header").ok()?;
    let cycle = find_column(&columns, &["cycle", "airac_cycle"])?;
    let value: String = connection
        .query_row(
            &format!(
                "SELECT CAST({} AS TEXT) FROM tbl_hdr_header LIMIT 1",
                quote_identifier(&cycle)
            ),
            [],
            |row| row.get(0),
        )
        .ok()?;
    let trimmed = value.trim().to_string();
    (!trimmed.is_empty()).then_some(trimmed)
}

/// `tbl_hdr_header.dataset_version`（形如 2.0.xx.xxxx），用于在设置页显示格式版本。
pub(super) fn dataset_version(connection: &Connection) -> Option<String> {
    if !table_exists(connection, "tbl_hdr_header").ok()? {
        return None;
    }
    let columns = table_columns(connection, "tbl_hdr_header").ok()?;
    let column = find_column(&columns, &["dataset_version", "revision"])?;
    let value: String = connection
        .query_row(
            &format!(
                "SELECT CAST({} AS TEXT) FROM tbl_hdr_header LIMIT 1",
                quote_identifier(&column)
            ),
            [],
            |row| row.get(0),
        )
        .ok()?;
    let trimmed = value.trim().to_string();
    (!trimmed.is_empty()).then_some(trimmed)
}

pub(super) fn has_procedures(connection: &Connection) -> Result<bool, String> {
    Ok(table_exists(connection, "tbl_pd_sids")?
        || table_exists(connection, "tbl_pe_stars")?
        || table_exists(connection, "tbl_pf_iaps")?)
}

// ───────────────────────────── 机场 ─────────────────────────────

pub(super) fn search_airports(
    connection: &Connection,
    query: &str,
) -> Result<Vec<NavigationAirport>, String> {
    let columns = table_columns(connection, "tbl_pa_airports")?;
    let icao = text_expression(find_column(&columns, &["airport_identifier"]));
    let iata = text_expression(find_column(&columns, &["ata_iata_code", "iata_code"]));
    let name = text_expression(find_column(&columns, &["airport_name", "name"]));
    let city = text_expression(find_column(&columns, &["city", "airport_name"]));
    let elevation = number_expression(find_column(&columns, &["elevation", "airport_elevation"]));
    let latitude = number_expression(find_column(
        &columns,
        &["airport_ref_latitude", "latitude"],
    ));
    let longitude = number_expression(find_column(
        &columns,
        &["airport_ref_longitude", "longitude"],
    ));
    let sql = format!(
        "SELECT {icao}, {iata}, {name}, {city}, {elevation}, {latitude}, {longitude} \
         FROM tbl_pa_airports \
         WHERE UPPER({icao}) LIKE ?1 OR UPPER({iata}) LIKE ?1 OR UPPER({name}) LIKE ?1 OR UPPER({city}) LIKE ?1 \
         ORDER BY {icao} LIMIT 100"
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| error.to_string())?;
    let filter = format!("%{}%", query.trim().to_uppercase());
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

fn surface_label(code: &str) -> String {
    // ARINC 424 5.54 道面代码（单字符）。未收录的代码原样显示，不臆造含义。
    match code.trim().to_uppercase().as_str() {
        "A" => "沥青".to_string(),
        "B" => "砖".to_string(),
        "C" => "混凝土".to_string(),
        "D" => "土".to_string(),
        "G" => "草地".to_string(),
        "W" => "水面".to_string(),
        "" => String::new(),
        other => other.to_string(),
    }
}

fn group_digits(value: i64) -> String {
    let text = value.abs().to_string();
    let mut out = String::new();
    for (index, character) in text.chars().enumerate() {
        if index > 0 && (text.len() - index) % 3 == 0 {
            out.push(',');
        }
        out.push(character);
    }
    if value < 0 {
        format!("-{out}")
    } else {
        out
    }
}

/// 通信类型排序：塔台/地面/进近优先，ATIS 放最前，其余按字母。
fn communication_rank(kind: &str) -> u8 {
    match kind.trim().to_uppercase().as_str() {
        "ATIS" | "D-ATIS" => 0,
        "DEL" | "CLD" | "PRE" => 1,
        "GND" => 2,
        "TWR" => 3,
        "APP" | "DEP" => 4,
        "CTR" | "FSS" | "RDO" => 5,
        "UNIC" | "UNICOM" | "CTAF" => 7,
        _ => 6,
    }
}

fn communication_label(kind: &str) -> String {
    match kind.trim().to_uppercase().as_str() {
        "ATIS" | "D-ATIS" => "ATIS".to_string(),
        "DEL" | "CLD" | "CTR" | "PRE" => "放行".to_string(),
        "GND" => "地面".to_string(),
        "TWR" => "塔台".to_string(),
        "APP" => "进近".to_string(),
        "DEP" => "离场".to_string(),
        "FSS" | "RDO" => "咨询".to_string(),
        "UNIC" | "UNICOM" => "UNICOM".to_string(),
        "CTAF" => "CTAF".to_string(),
        "" => "通信".to_string(),
        other => other.to_string(),
    }
}

/// 跑道与频率。DFD v2 里跑道长度单位为英尺（ARINC 5.67），频率为
/// `communication_frequency`（VHF 以 MHz 存储，个别数据源会乘 1000）。
pub(super) fn airport_details(
    connection: &Connection,
    icao: &str,
) -> Result<NavigationAirportDetails, String> {
    let normalized = icao.trim().to_uppercase();
    let mut runways = Vec::new();
    if table_exists(connection, "tbl_pg_runways")? {
        let columns = table_columns(connection, "tbl_pg_runways")?;
        let ident = text_expression(find_column(&columns, &["runway_identifier"]));
        let length = number_expression(find_column(&columns, &["runway_length"]));
        let surface = text_expression(find_column(&columns, &["surface_code"]));
        let sql = format!(
            "SELECT {ident}, {length}, {surface} FROM tbl_pg_runways \
             WHERE UPPER(TRIM(airport_identifier)) = ?1 ORDER BY {ident}"
        );
        let mut statement = connection
            .prepare(&sql)
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![normalized], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, f64>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        for row in rows {
            let (ident, length, surface) = row.map_err(|error| error.to_string())?;
            let ident = ident.trim().to_uppercase();
            if ident.is_empty() {
                continue;
            }
            let mut text = ident;
            if length > 0.0 {
                text.push_str(&format!(" · {} ft", group_digits(length.round() as i64)));
            }
            let surface = surface_label(&surface);
            if !surface.is_empty() {
                text.push_str(&format!(" · {surface}"));
            }
            runways.push(text);
        }
    }

    let mut frequencies = Vec::new();
    if table_exists(connection, "tbl_pv_airport_communication")? {
        let columns = table_columns(connection, "tbl_pv_airport_communication")?;
        let kind = text_expression(find_column(&columns, &["communication_type", "service_indicator"]));
        let callsign = text_expression(find_column(&columns, &["callsign", "narrative"]));
        let value = number_expression(find_column(&columns, &["communication_frequency"]));
        let sector = text_expression(find_column(&columns, &["sectorization"]));
        let sql = format!(
            "SELECT {kind}, {callsign}, {value}, {sector} FROM tbl_pv_airport_communication \
             WHERE UPPER(TRIM(airport_identifier)) = ?1 AND {value} > 0"
        );
        let mut statement = connection
            .prepare(&sql)
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![normalized], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, f64>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        let mut collected: Vec<(u8, String, String)> = Vec::new();
        for row in rows {
            let (kind, callsign, value, _sector) = row.map_err(|error| error.to_string())?;
            let callsign = callsign.trim().to_string();
            // 呼号比类型更好认（「BEIJING TOWER」优于「TWR」），没有呼号才退回类型。
            let name = if callsign.is_empty() {
                communication_label(&kind)
            } else {
                callsign
            };
            let frequency = format_frequency(&format!("{value}"));
            if frequency.is_empty() {
                continue;
            }
            collected.push((communication_rank(&kind), name, frequency));
        }
        collected.sort_by(|first, second| {
            first
                .0
                .cmp(&second.0)
                .then(first.1.cmp(&second.1))
                .then(first.2.cmp(&second.2))
        });
        let mut seen = HashMap::<String, ()>::new();
        for (_, name, value) in collected {
            if seen.insert(format!("{name}:{value}"), ()).is_some() {
                continue;
            }
            frequencies.push(NavigationFrequency { name, value });
        }
    }

    Ok(NavigationAirportDetails {
        runways,
        frequencies,
    })
}

pub(super) fn map_airports(
    connection: &Connection,
    west: f64,
    south: f64,
    east: f64,
    north: f64,
) -> Result<Vec<NavigationMapPoint>, String> {
    let columns = table_columns(connection, "tbl_pa_airports")?;
    let icao = text_expression(find_column(&columns, &["airport_identifier"]));
    let iata = text_expression(find_column(&columns, &["ata_iata_code", "iata_code"]));
    let name = text_expression(find_column(&columns, &["airport_name", "name"]));
    let latitude = number_expression(find_column(
        &columns,
        &["airport_ref_latitude", "latitude"],
    ));
    let longitude = number_expression(find_column(
        &columns,
        &["airport_ref_longitude", "longitude"],
    ));
    let ifr = text_expression(find_column(&columns, &["ifr_capability"]));
    let sql = format!(
        "SELECT {icao}, {iata}, {name}, {latitude}, {longitude}, {ifr} FROM tbl_pa_airports \
         WHERE {latitude} BETWEEN ?1 AND ?2 AND {longitude} BETWEEN ?3 AND ?4 LIMIT 1200"
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![south, north, west, east], |row| {
            let ident: String = row.get(0)?;
            let ifr: String = row.get(5)?;
            Ok(NavigationMapPoint {
                icao: ident.clone(),
                ident,
                iata: row.get(1)?,
                name: row.get(2)?,
                kind: "机场".to_string(),
                symbol: if ifr.trim().eq_ignore_ascii_case("Y") {
                    "airport-ifr".to_string()
                } else {
                    "airport-vfr".to_string()
                },
                reporting: None,
                latitude: row.get(3)?,
                longitude: row.get(4)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

// ─────────────────────── 航路点与导航台 ───────────────────────

/// VHF 导航台类别（ARINC 424 5.35）→ 地图符号。
/// 第 1 位是设备主体（V=VOR、T=TACAN、D=DME），后续位标注是否有 DME/TACAN。
fn vhf_symbol(class: &str) -> &'static str {
    let normalized = class.trim().to_uppercase();
    let first = normalized.chars().next().unwrap_or('V');
    let has_dme = normalized.chars().skip(1).any(|character| character == 'D');
    let has_tacan = normalized.chars().skip(1).any(|character| character == 'T');
    match first {
        'T' => "tacan",
        'D' => "dme",
        'V' if has_tacan => "vortac",
        'V' if has_dme => "vor-dme",
        _ => "vor",
    }
}

fn point_rows(
    connection: &Connection,
    table: &str,
    ident_column: &str,
    name_column: &str,
    latitude_column: &str,
    longitude_column: &str,
    extra_column: Option<&str>,
    kind: &str,
    symbol: impl Fn(&rusqlite::Row<'_>) -> rusqlite::Result<String>,
    west: f64,
    south: f64,
    east: f64,
    north: f64,
) -> Result<Vec<NavigationMapPoint>, String> {
    if !table_exists(connection, table)? {
        return Ok(Vec::new());
    }
    // 第 5 列用于承载符号判据（导航台的 navaid_class），没有就填常量占位。
    let extra = extra_column
        .map(|column| format!("COALESCE({}, '')", quote_identifier(column)))
        .unwrap_or_else(|| "''".to_string());
    let sql = format!(
        "SELECT {ident_column}, {name_column}, {latitude_column}, {longitude_column}, {extra} \
         FROM {table} WHERE {latitude_column} BETWEEN ?1 AND ?2 AND {longitude_column} BETWEEN ?3 AND ?4 LIMIT 1500",
        table = quote_identifier(table),
        ident_column = quote_identifier(ident_column),
        name_column = quote_identifier(name_column),
        latitude_column = quote_identifier(latitude_column),
        longitude_column = quote_identifier(longitude_column),
    );
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
                symbol: symbol(row)?,
                reporting: None,
                latitude: row.get(2)?,
                longitude: row.get(3)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

/// 航路点 + 导航台（地图像素级要素）。
pub(super) fn map_points(
    connection: &Connection,
    west: f64,
    south: f64,
    east: f64,
    north: f64,
) -> Result<Vec<NavigationMapPoint>, String> {
    let mut points = Vec::new();
    for (table, kind) in [
        ("tbl_ea_enroute_waypoints", "航路点"),
        ("tbl_pc_terminal_waypoints", "终端航路点"),
    ] {
        points.extend(point_rows(
            connection,
            table,
            "waypoint_identifier",
            "waypoint_name",
            "waypoint_latitude",
            "waypoint_longitude",
            None,
            kind,
            |_| Ok("waypoint".to_string()),
            west,
            south,
            east,
            north,
        )?);
    }
    for (table, kind) in [
        ("tbl_d_vhfnavaids", "导航台"),
        ("tbl_db_enroute_ndbnavaids", "导航台"),
        ("tbl_pn_terminal_ndbnavaids", "导航台"),
    ] {
        let is_ndb = table.contains("ndb");
        points.extend(point_rows(
            connection,
            table,
            "navaid_identifier",
            "navaid_name",
            "navaid_latitude",
            "navaid_longitude",
            (!is_ndb).then_some("navaid_class"),
            kind,
            move |row| {
                if is_ndb {
                    return Ok("ndb".to_string());
                }
                let class: String = row.get::<_, Option<String>>(4)?.unwrap_or_default();
                Ok(vhf_symbol(&class).to_string())
            },
            west,
            south,
            east,
            north,
        )?);
    }
    let mut seen = std::collections::HashSet::new();
    points.retain(|point| {
        seen.insert(format!(
            "{}:{}:{:.4}:{:.4}",
            point.kind, point.ident, point.latitude, point.longitude
        ))
    });
    Ok(points)
}

// ───────────────────────────── 航路 ─────────────────────────────

struct AirwayPoint {
    seqno: f64,
    coordinate: [f64; 2],
    minimum_altitude: Option<i64>,
    maximum_altitude: Option<i64>,
}

fn altitude(value: Option<f64>) -> Option<i64> {
    // ARINC 424 的 0 表示「未定义」，不要当成 0 英尺。
    value.filter(|value| value.is_finite() && *value > 0.0).map(|value| value.round() as i64)
}

/// 航路重建：DFD v2 的 `tbl_er_enroute_airways` 一行是一个航路点，
/// 相邻两个 `seqno` 连续的点之间才是一条航段（seqno 断开说明是另一段航路）。
pub(super) fn map_airways(
    connection: &Connection,
    west: f64,
    south: f64,
    east: f64,
    north: f64,
    limit: usize,
) -> Result<Vec<NavigationAirway>, String> {
    if !table_exists(connection, "tbl_er_enroute_airways")? {
        return Ok(Vec::new());
    }
    // 先取视口内出现的航路标识，再整条取回：否则横跨视口的航路会被
    // 「只有一个端点落在框内」的过滤条件截断成孤立点。
    let mut statement = connection
        .prepare(
            "SELECT DISTINCT route_identifier FROM tbl_er_enroute_airways \
             WHERE waypoint_latitude BETWEEN ?1 AND ?2 AND waypoint_longitude BETWEEN ?3 AND ?4 \
             LIMIT 400",
        )
        .map_err(|error| error.to_string())?;
    let names = statement
        .query_map(params![south, north, west, east], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    if names.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = vec!["?"; names.len()].join(",");
    // 关键：库中同一航路点会按飞行高度层重复多行（每个 level 一行），
    // 若按原始行取，行预算会被字母序最前的少数航路耗光，地图上只剩几条 2-4 点的碎片。
    // 这里按 (航路, 段后缀, seqno, 航路点) GROUP BY 去重——画图只需要一份几何，
    // 高度层 / 方向 / 限制高度聚合后仅作显示属性。
    let sql = format!(
        "SELECT route_identifier, COALESCE(route_identifier_postfix, ''), \
                MIN(COALESCE(flightlevel, '')), MIN(COALESCE(direction_restriction, '')), COALESCE(seqno, 0), \
                waypoint_latitude, waypoint_longitude, MIN(minimum_altitude1), MAX(maximum_altitude) \
         FROM tbl_er_enroute_airways \
         WHERE route_identifier IN ({placeholders}) \
         GROUP BY route_identifier, route_identifier_postfix, seqno, waypoint_identifier, waypoint_latitude, waypoint_longitude \
         ORDER BY route_identifier, route_identifier_postfix, seqno LIMIT {limit}"
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| error.to_string())?;
    let parameters: Vec<&dyn rusqlite::ToSql> =
        names.iter().map(|name| name as &dyn rusqlite::ToSql).collect();
    let rows = statement
        .query_map(parameters.as_slice(), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                AirwayPoint {
                    seqno: row.get(4)?,
                    coordinate: [row.get(6)?, row.get(5)?],
                    minimum_altitude: altitude(row.get(7)?),
                    maximum_altitude: altitude(row.get(8)?),
                },
            ))
        })
        .map_err(|error| error.to_string())?;

    // 组内有序，组之间用 BTreeMap 保证输出稳定（同一视口截图可复现）。
    type AirwayGroup = (String, String, String, String, Vec<AirwayPoint>);
    let mut groups: std::collections::BTreeMap<String, AirwayGroup> =
        std::collections::BTreeMap::new();
    for row in rows {
        let (identifier, postfix, level, direction, point) =
            row.map_err(|error| error.to_string())?;
        let key = format!("{identifier}|{postfix}|{level}");
        groups
            .entry(key)
            .or_insert_with(|| (identifier, postfix, level, direction, Vec::new()))
            .4
            .push(point);
    }

    let mut airways: Vec<NavigationAirway> = Vec::new();
    for (_, (identifier, postfix, level, direction, points)) in groups {
        let name = format!("{}{}", identifier.trim(), postfix.trim());
        // seqno 连续才算同一条链，断点处另起一条（避免跨段连出假航段）。
        let mut chain: Vec<AirwayPoint> = Vec::new();
        let flush = |chain: &mut Vec<AirwayPoint>, airways: &mut Vec<NavigationAirway>| {
            if chain.len() < 2 {
                chain.clear();
                return;
            }
            let legs = chain
                .windows(2)
                .map(|pair| NavigationAirwayLeg {
                    coordinates: [pair[0].coordinate, pair[1].coordinate],
                    direction: direction.clone(),
                    level: level.clone(),
                    minimum_altitude: pair[1].minimum_altitude.or(pair[0].minimum_altitude),
                    maximum_altitude: pair[1].maximum_altitude.or(pair[0].maximum_altitude),
                })
                .collect::<Vec<_>>();
            airways.push(NavigationAirway {
                name: name.clone(),
                airway_type: if level.trim().is_empty() {
                    "B".to_string()
                } else {
                    level.clone()
                },
                route_type: String::new(),
                direction: direction.clone(),
                coordinates: chain.iter().map(|point| point.coordinate).collect(),
                legs,
            });
            chain.clear();
        };
        // DFD 的 seqno 是全局序列号（实测 190→200→210…间隔不规则，且不同
        // 高度层段共享同一套连续编号），不是 1,2,3 递增。按「差 1」判断连续
        // 会把每个航路点都当成断链，只剩 2-4 点的碎片。SQL 已按 seqno 排序，
        // 相邻行就是航路顺序，直接顺序连链即可；同 seqno 的跨层重复行已在
        // 上面的 GROUP BY 里去重。
        for point in points {
            chain.push(point);
        }
        flush(&mut chain, &mut airways);
    }
    Ok(airways)
}

// ─────────────────────── SID / STAR / 进近 ───────────────────────

fn split_runway_transition(
    transition: &str,
    summary: &mut NavigationProcedureSummary,
) {
    let normalized = transition.trim().to_uppercase();
    if normalized.starts_with("RW") {
        push_unique(&mut summary.runways, normalize_runway(&normalized));
    } else if !normalized.is_empty() && normalized != "ALL" {
        push_unique(&mut summary.transitions, normalized);
    }
}

/// 每张航段表逐个程序汇总：跑道来自 `RW##` 形式的转换名，其余转换名即过渡点。
pub(super) fn airport_procedures(
    connection: &Connection,
    icao: &str,
) -> Result<
    (
        Vec<NavigationProcedureSummary>,
        Vec<NavigationProcedureSummary>,
        Vec<NavigationProcedureSummary>,
    ),
    String,
> {
    let normalized = icao.trim().to_uppercase();
    let mut sids = Vec::new();
    let mut stars = Vec::new();
    let mut approaches = Vec::new();
    for kind in [1_i64, 2, 3] {
        let Some(table) = procedure_table(kind) else {
            continue;
        };
        if !table_exists(connection, table)? {
            continue;
        }
        let sql = format!(
            "SELECT rowid, procedure_identifier, COALESCE(transition_identifier, '') \
             FROM {table} WHERE UPPER(TRIM(airport_identifier)) = ?1 \
             ORDER BY procedure_identifier, rowid",
            table = quote_identifier(table)
        );
        let mut statement = connection
            .prepare(&sql)
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![normalized], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|error| error.to_string())?;

        let mut summaries: Vec<NavigationProcedureSummary> = Vec::new();
        let mut indexes = HashMap::<String, usize>::new();
        for row in rows {
            let (rowid, name, transition) = row.map_err(|error| error.to_string())?;
            let name = name.trim().to_string();
            if name.is_empty() {
                continue;
            }
            let index = match indexes.get(&name) {
                Some(index) => *index,
                None => {
                    let index = summaries.len();
                    // 排序后同程序的首行 rowid 最小，正好当作稳定的程序锚点。
                    summaries.push(NavigationProcedureSummary {
                        id: kind * PROCEDURE_ID_SCALE + rowid,
                        name: name.clone(),
                        runways: Vec::new(),
                        transitions: Vec::new(),
                    });
                    indexes.insert(name, index);
                    index
                }
            };
            let summary = &mut summaries[index];
            split_runway_transition(&transition, summary);
        }
        for summary in &mut summaries {
            summary.runways.sort();
            summary.transitions.sort();
        }
        summaries.sort_by(|first, second| first.name.cmp(&second.name));
        match kind {
            1 => sids = summaries,
            2 => stars = summaries,
            _ => approaches = summaries,
        }
    }
    Ok((sids, stars, approaches))
}

fn same_position(first: &FlightRoutePoint, second: &FlightRoutePoint) -> bool {
    (first.latitude - second.latitude).abs() < 0.00001
        && (first.longitude - second.longitude).abs() < 0.00001
}

pub(super) fn procedure_points(
    connection: &Connection,
    procedure_id: i64,
    runway: &str,
    transition: &str,
) -> Result<Vec<FlightRoutePoint>, String> {
    let kind = procedure_id / PROCEDURE_ID_SCALE;
    let rowid = procedure_id % PROCEDURE_ID_SCALE;
    let table = procedure_table(kind).ok_or_else(|| "无法识别的程序编号".to_string())?;
    if !table_exists(connection, table)? {
        return Err(format!("当前导航库没有 {} 程序表", procedure_kind_name(kind)));
    }
    // DFD v2 无主键，rowid 是唯一稳定的行锚点：由它反查机场与程序名。
    let (airport, procedure): (String, String) = connection
        .query_row(
            &format!(
                "SELECT airport_identifier, procedure_identifier FROM {} WHERE rowid = ?1",
                quote_identifier(table)
            ),
            params![rowid],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| "找不到所选程序".to_string())?;

    let sql = format!(
        "SELECT COALESCE(waypoint_identifier, ''), COALESCE(transition_identifier, ''), \
                COALESCE(path_termination, ''), waypoint_latitude, waypoint_longitude, \
                course, center_waypoint_latitude, center_waypoint_longitude \n         FROM {table} WHERE UPPER(TRIM(airport_identifier)) = ?1 AND procedure_identifier = ?2 \n         ORDER BY seqno, rowid",
        table = quote_identifier(table)
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![airport.trim().to_uppercase(), procedure], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<f64>>(3)?.unwrap_or_default(),
                row.get::<_, Option<f64>>(4)?.unwrap_or_default(),
                row.get::<_, Option<f64>>(5)?.unwrap_or_default(),
                row.get::<_, Option<f64>>(6)?.unwrap_or_default(),
                row.get::<_, Option<f64>>(7)?.unwrap_or_default(),
            ))
        })
        .map_err(|error| error.to_string())?;

    let selected_runway = normalize_runway(runway);
    let selected_transition = transition.trim().to_uppercase();
    // 过渡腿与公共腿分开收集：DFD 的 seqno 把各过渡、公共段交错编号，按 seqno
    // 全局排序会把多组腿连成来回穿插的折线。正确的拼接顺序（各自保持 seqno 序）：
    // SID = 跑道过渡 → 公共段 → 航路过渡；STAR/进近 = 航路过渡 → 公共段 → 跑道专属。
    let mut runway_legs: Vec<FlightRoutePoint> = Vec::new();
    let mut named_legs: Vec<FlightRoutePoint> = Vec::new();
    let mut common_legs: Vec<FlightRoutePoint> = Vec::new();
    let mut last_drawn: Option<(f64, f64)> = None;
    for (index, row) in rows.enumerate() {
        let (
            ident,
            leg_transition,
            path_termination,
            latitude,
            longitude,
            course,
            center_latitude,
            center_longitude,
        ) = row.map_err(|error| error.to_string())?;
        let normalized_transition = leg_transition.trim().to_uppercase();
        let runway_leg = normalized_transition.starts_with("RW")
            && normalize_runway(&normalized_transition) == selected_runway;
        let named_transition =
            !selected_transition.is_empty() && normalized_transition == selected_transition;
        let is_transition_leg = !normalized_transition.is_empty() && normalized_transition != "ALL";
        // 公共航段（transition 为空或 ALL）永远保留，其余只保留选中的跑道/过渡点。
        if is_transition_leg && !runway_leg && !named_transition {
            continue;
        }
        let leg_type = {
            let code = path_termination.trim().to_uppercase();
            (!code.is_empty()).then_some(code)
        };
        let has_coordinates = latitude.is_finite()
            && longitude.is_finite()
            && latitude.abs() <= 90.0
            && longitude.abs() <= 180.0
            && (latitude != 0.0 || longitude != 0.0);
        let point = if !has_coordinates {
            // CA/CD/CR/VI 这类腿没有终点坐标，沿航向外推一个展示点。
            if !course.is_finite() || course == 0.0 {
                continue;
            }
            let Some((previous_latitude, previous_longitude)) = last_drawn else {
                continue;
            };
            let stub = project_course(previous_latitude, previous_longitude, course, 6.0);
            FlightRoutePoint {
                name: leg_type.clone().unwrap_or_else(|| "COURSE".to_string()),
                ident: leg_type.clone().unwrap_or_else(|| "COURSE".to_string()),
                latitude: stub.0,
                longitude: stub.1,
                leg_type: leg_type.clone(),
                arc_center: None,
                course: Some(course),
                course_only: true,
            }
        } else {
            let ident = if ident.trim().is_empty() {
                format!("{}{}", path_termination.trim(), index + 1)
            } else {
                ident.trim().to_string()
            };
            let arc_center = (leg_type.as_deref() == Some("RF")
                && center_latitude.is_finite()
                && center_longitude.is_finite()
                && (center_latitude != 0.0 || center_longitude != 0.0))
            .then_some((center_latitude, center_longitude));
            FlightRoutePoint {
                name: ident.clone(),
                ident,
                latitude,
                longitude,
                leg_type,
                arc_center,
                course: None,
                course_only: false,
            }
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
    let mut points = match kind {
        1 => {
            let mut ordered = runway_legs;
            ordered.append(&mut common_legs);
            ordered.append(&mut named_legs);
            ordered
        }
        _ => {
            let mut ordered = named_legs;
            ordered.append(&mut common_legs);
            ordered.append(&mut runway_legs);
            ordered
        }
    };
    points.dedup_by(|previous, current| same_position(previous, current));
    // 进近：RWxx 是落地收尾腿，其后的 CA/DF/TF 腿属于复飞程序，
    // 连进同一条折线会从跑道口折回复飞点再绕回跑道，图上就是乱穿的大三角。
    if kind == 3 && !selected_runway.is_empty() {
        if let Some(index) = points
            .iter()
            .rposition(|point| !point.course_only && normalize_runway(&point.ident) == selected_runway)
        {
            points.truncate(index + 1);
        }
    }
    // 收尾去环：DFD 常在公共段末尾追加一行重复航路点的记录挂程序级属性
    // （如 MIPAG7 的过渡高度 8900 挂在重复的 ZAO 上），画进折线会从出口点
    // 折回已飞过的位置。只要最后一个点回到路径中已访问的位置就继续丢弃。
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

/// 跑道入口坐标：`tbl_pg_runways.runway_latitude/longitude` 即跑道入口点。
pub(super) fn runway_threshold(
    connection: &Connection,
    icao: String,
    runway: String,
) -> Result<Option<FlightRoutePoint>, String> {
    let normalized = icao.trim().to_uppercase();
    let selected = normalize_runway(&runway);
    if !table_exists(connection, "tbl_pg_runways")? {
        return Ok(None);
    }
    let columns = table_columns(connection, "tbl_pg_runways")?;
    let ident = text_expression(find_column(&columns, &["runway_identifier"]));
    let latitude = number_expression(find_column(&columns, &["runway_latitude"]));
    let longitude = number_expression(find_column(&columns, &["runway_longitude"]));
    let sql = format!(
        "SELECT {ident}, {latitude}, {longitude} FROM tbl_pg_runways \
         WHERE UPPER(TRIM(airport_identifier)) = ?1"
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![normalized], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, f64>(1)?,
                row.get::<_, f64>(2)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut fallback: Option<(f64, f64)> = None;
    for row in rows {
        let (ident, latitude, longitude) = row.map_err(|error| error.to_string())?;
        if !(latitude.is_finite()
            && longitude.is_finite()
            && latitude.abs() <= 90.0
            && longitude.abs() <= 180.0
            && (latitude != 0.0 || longitude != 0.0))
        {
            continue;
        }
        let ident = ident.trim().to_uppercase();
        if normalize_runway(&ident) == selected {
            fallback = Some((latitude, longitude));
            break;
        }
        // 数据源偶尔只写「18」不写「18L」，按前缀兜底。
        if fallback.is_none() && (ident == selected || ident.starts_with(&selected)) {
            fallback = Some((latitude, longitude));
        }
    }
    Ok(fallback.map(|(latitude, longitude)| FlightRoutePoint {
        name: format!("RW{selected}"),
        ident: format!("RW{selected}"),
        latitude,
        longitude,
        leg_type: None,
        arc_center: None,
        course: None,
        course_only: false,
    }))
}

/// 「18L → 36R」：编号 ±18、侧字母 L/R 互换，给出去掉前导零等候选写法。
fn reciprocal_idents(ident: &str) -> Vec<String> {
    let digits: String = ident.chars().take_while(|c| c.is_ascii_digit()).collect();
    let side: String = ident.chars().skip_while(|c| c.is_ascii_digit()).collect();
    let number: u32 = match digits.parse() {
        Ok(value) if (1..=36).contains(&value) => value,
        _ => return Vec::new(),
    };
    let reciprocal = if number > 18 { number - 18 } else { number + 18 };
    let mirror = match side.as_str() { "L" => "R", "R" => "L", other => other };
    vec![format!("{reciprocal:02}{mirror}"), format!("{reciprocal}{mirror}")]
}

/// 跑道两端坐标。选中端按「先精确、再前缀兜底」匹配（与 runway_threshold 一致），
/// 对端由反方向编号在同一机场的跑道行里找。
pub(super) fn runway_ends(
    connection: &Connection,
    icao: String,
    runway: String,
) -> Result<Option<RunwayEnds>, String> {
    if !table_exists(connection, "tbl_pg_runways")? {
        return Ok(None);
    }
    let columns = table_columns(connection, "tbl_pg_runways")?;
    let ident = text_expression(find_column(&columns, &["runway_identifier"]));
    let latitude = number_expression(find_column(&columns, &["runway_latitude"]));
    let longitude = number_expression(find_column(&columns, &["runway_longitude"]));
    let sql = format!(
        "SELECT {ident}, {latitude}, {longitude} FROM tbl_pg_runways \
         WHERE UPPER(TRIM(airport_identifier)) = ?1"
    );
    let mut statement = connection.prepare(&sql).map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![icao], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, f64>(1)?,
                row.get::<_, f64>(2)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut ends: Vec<RunwayEnd> = Vec::new();
    for row in rows {
        let (ident, latitude, longitude) = row.map_err(|error| error.to_string())?;
        if !(latitude.is_finite()
            && longitude.is_finite()
            && latitude.abs() <= 90.0
            && longitude.abs() <= 180.0
            && (latitude != 0.0 || longitude != 0.0))
        {
            continue;
        }
        // 数据源写的是「RW03」这种带前缀的形式，统一去掉前缀再存，
        // 前端标签才能拼成「RW03」而不是「RWRW03」。
        ends.push(RunwayEnd { ident: normalize_runway(&ident), latitude, longitude });
    }
    ends.sort_by(|a, b| a.ident.cmp(&b.ident));
    ends.dedup_by(|a, b| a.ident == b.ident);
    // 数据源偶尔只写「18」不写「18L」，精确匹配不到时按前缀兜底。
    let selected = ends
        .iter()
        .find(|end| end.ident == runway)
        .or_else(|| ends.iter().find(|end| end.ident.starts_with(&runway)));
    let Some(primary) = selected.cloned() else {
        return Ok(None);
    };
    let candidates = reciprocal_idents(&primary.ident);
    let reciprocal = ends
        .iter()
        .filter(|end| end.ident != primary.ident)
        .find(|end| {
            let normalized = normalize_runway(&end.ident);
            candidates.iter().any(|candidate| normalize_runway(candidate) == normalized)
        })
        .cloned();
    Ok(Some(RunwayEnds { runway, primary, reciprocal }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reciprocal_runway_idents() {
        // ZSLG：21 ↔ 03
        assert_eq!(reciprocal_idents("21"), vec!["03", "3"]);
        assert_eq!(reciprocal_idents("03"), vec!["21", "21"]);
        // 首都：18L ↔ 36R，01 ↔ 19
        assert_eq!(reciprocal_idents("18L"), vec!["36R", "36R"]);
        assert_eq!(reciprocal_idents("36R"), vec!["18L", "18L"]);
        assert_eq!(reciprocal_idents("01"), vec!["19", "19"]);
        assert_eq!(reciprocal_idents("19"), vec!["01", "1"]);
        // 中心跑道字母不变
        assert_eq!(reciprocal_idents("09C"), vec!["27C", "27C"]);
        // 非法输入返回空
        assert!(reciprocal_idents("AB").is_empty());
        assert!(reciprocal_idents("").is_empty());
    }
}

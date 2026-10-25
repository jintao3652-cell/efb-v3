//! NAIP 数据包解析（Terminal 的**上一级**目录）。
//!
//! 目录结构（用户选中的是 `<root>`，不是 `<root>/Terminal`）：
//!
//! ```text
//! <root>/AD_HP.csv                 机场库：CODE_ID = ICAO，TXT_NAME = 中文名
//! <root>/FLIGHT_AIRLINE.csv        班机航路主表：name = ZBAA-ZSAM-01，StartAirportID / EndAirportID
//! <root>/FLIGHT_AIRLINE_POINT.csv  航路航段：按 Sequnce 给出 AirwayName + 起止点
//! <root>/Terminal/<ICAO>/          航图（索引逻辑在 chart.rs）
//! ```
//!
//! 注意 `FLIGHT_AIRLINE.csv` 的 `Routes` 列是**中文描述**（「北京/首都经ELKUR、W40PANKI…」），
//! 不能直接提交给 FSD；真正的航路串要把 `FLIGHT_AIRLINE_POINT.csv` 里的航段按 `Sequnce`
//! 拼起来：起点 + 航路名 + 该航路段终点，同一航路连续多跳只保留末端点。
//!
//! 两份 CSV 都随数据批次变动列名，所以这里先精确匹配表头、再退回关键词包含匹配；
//! `get_naip_status` 会把识别结果回显给 UI，对不上时用户能直接看出是哪一列没认出来。

use super::chart::read_library_config;
use super::flightplan::FlightRoutePoint;
use encoding_rs::GBK;
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::UNIX_EPOCH,
};

const AIRPORT_FILE: &str = "AD_HP.csv";
const ROUTE_FILE: &str = "FLIGHT_AIRLINE.csv";
const ROUTE_POINT_FILE: &str = "FLIGHT_AIRLINE_POINT.csv";

/// 四字 ICAO 码。机场库与航路库里都可能出现国外机场（如 `RJAA`），
/// 所以这里只校验格式，不限定 `Z` 开头；国内机场的筛选交给前端。
fn airport_icao(value: &str) -> Option<String> {
    let code = value.trim().to_uppercase();
    (code.len() == 4 && code.chars().all(|character| character.is_ascii_alphabetic()))
        .then_some(code)
}

fn read_text(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    let text = match std::str::from_utf8(&bytes) {
        Ok(text) => text.to_string(),
        // NAIP 的 CSV 是 GBK；UTF-8 读失败才回落，避免把正常 UTF-8 读成乱码。
        Err(_) => GBK.decode(&bytes).0.into_owned(),
    };
    Ok(text.trim_start_matches('\u{feff}').to_string())
}

/// 选中的目录（或它的上一级）里找数据包根：谁带 AD_HP.csv / FLIGHT_AIRLINE.csv 谁是根。
fn data_root() -> Result<Option<PathBuf>, String> {
    let Some(config) = read_library_config()? else {
        return Ok(None);
    };
    let selected = PathBuf::from(config.path.trim());
    let mut candidates = vec![selected.clone()];
    if let Some(parent) = selected.parent() {
        candidates.push(parent.to_path_buf());
    }
    for directory in candidates {
        if directory.as_os_str().is_empty() {
            continue;
        }
        if directory.join(AIRPORT_FILE).is_file() || directory.join(ROUTE_FILE).is_file() {
            return Ok(Some(directory));
        }
    }
    Ok(None)
}

fn read_records(text: &str) -> (Vec<String>, Vec<Vec<String>>) {
    let mut reader = csv::ReaderBuilder::new()
        .flexible(true)
        .trim(csv::Trim::All)
        .from_reader(text.as_bytes());
    let headers = reader
        .headers()
        .map(|row| row.iter().map(|value| value.trim().to_string()).collect())
        .unwrap_or_default();
    let rows = reader
        .records()
        .filter_map(Result::ok)
        .map(|row| row.iter().map(|value| value.trim().to_string()).collect())
        .collect();
    (headers, rows)
}

/// 表头规范化：去掉下划线/空格/括号，统一大写，`CODE_ID` 与 `Code Id` 等价。
fn normalized(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_alphanumeric())
        .flat_map(char::to_uppercase)
        .collect()
}

/// 先精确命中，再退回「包含关键词」。
/// 例：`StartAirportName` 里也有 `Name`，但 `name` 列会先被精确匹配拿走。
fn find_column(headers: &[String], wants: &[&str], excludes: &[&str]) -> Option<usize> {
    let keys: Vec<String> = headers.iter().map(|header| normalized(header)).collect();
    let blocked = |index: usize| excludes.iter().any(|bad| keys[index].contains(bad));
    for want in wants {
        if let Some(index) = keys.iter().position(|key| key == want) {
            if !blocked(index) {
                return Some(index);
            }
        }
    }
    keys.iter().position(|key| {
        wants.iter().any(|want| key.contains(want)) && !excludes.iter().any(|bad| key.contains(bad))
    })
}

fn number(value: &str) -> Option<f64> {
    let cleaned: String = value
        .chars()
        .filter(|character| character.is_ascii_digit() || *character == '.' || *character == '-')
        .collect();
    cleaned.parse::<f64>().ok().filter(|value| value.is_finite())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NaipAirport {
    pub icao: String,
    pub name: String,
    pub iata: String,
    pub international: bool,
    /// 原始坐标串（`N400421` 这类），交给前端统一按度分秒解析。
    pub latitude_raw: String,
    pub longitude_raw: String,
    /// 已是人读文本，如 `35 m`；无标高时为空串。
    pub elevation: String,
}

fn parse_airports(text: &str) -> Result<Vec<NaipAirport>, String> {
    let (headers, rows) = read_records(text);
    if headers.is_empty() {
        return Err("AD_HP.csv 是空文件".to_string());
    }
    let icao = find_column(&headers, &["CODEID", "CODEICAO", "ICAO"], &[])
        .ok_or_else(|| format!("AD_HP.csv 里找不到 ICAO 列（表头：{}）", headers.join(", ")))?;
    let name = find_column(&headers, &["TXTNAME", "NAME"], &["EN"]);
    let iata = find_column(&headers, &["CODEIATA", "IATA"], &[]);
    let international = find_column(&headers, &["ISINTERNATIONAL"], &[]);
    let latitude = find_column(&headers, &["GEOLAT"], &[]);
    let longitude = find_column(&headers, &["GEOLONG"], &[]);
    let elevation = find_column(&headers, &["VALELEV", "ELEV"], &[]);
    let unit = find_column(&headers, &["UOMDISTVER", "ELEVUNIT"], &[]);

    let mut airports = Vec::new();
    for row in rows {
        let Some(code) = row.get(icao).and_then(|value| airport_icao(value)) else {
            continue;
        };
        let label = name
            .and_then(|index| row.get(index))
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| code.clone());
        let elevation_text = elevation
            .and_then(|index| row.get(index))
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .map(|value| {
                let unit = unit
                    .and_then(|index| row.get(index))
                    .map(|value| value.trim().to_lowercase())
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| "m".to_string());
                format!("{value} {unit}")
            })
            .unwrap_or_default();
        airports.push(NaipAirport {
            icao: code,
            name: label,
            iata: iata
                .and_then(|index| row.get(index))
                .map(|value| value.trim().to_string())
                .unwrap_or_default(),
            international: international
                .and_then(|index| row.get(index))
                .is_some_and(|value| value.trim().eq_ignore_ascii_case("Y")),
            latitude_raw: latitude
                .and_then(|index| row.get(index))
                .map(|value| value.trim().to_string())
                .unwrap_or_default(),
            longitude_raw: longitude
                .and_then(|index| row.get(index))
                .map(|value| value.trim().to_string())
                .unwrap_or_default(),
            elevation: elevation_text,
        });
    }
    Ok(airports)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NaipRoute {
    pub id: String,
    pub name: String,
    pub departure: String,
    pub arrival: String,
    /// 已拼好的航路串（不含首尾机场码），可直接提交给 FSD / 航路解析。
    pub route: String,
    /// 航段数，用于判断这条航路在 POINT 表里是否完整。
    pub legs: usize,
    pub distance_nm: Option<f64>,
    /// CSV 的 `Routes` 原文（中文描述），解析失败时用来对照。
    pub description: String,
}

/// 主表一行。
#[derive(Debug, Clone)]
struct AirlineRecord {
    id: String,
    name: String,
    departure: String,
    arrival: String,
    distance: Option<f64>,
    description: String,
}

/// 航段一行（`FLIGHT_AIRLINE_POINT.csv`）。
#[derive(Debug, Clone)]
struct RouteLeg {
    sequence: f64,
    airway: String,
    start: String,
    end: String,
}

/// 起止点标签：优先用 `StartPointIdentifier`（AR / TOS / P149 这类可解析标识），
/// 没有标识才用 `StartPointName`。
fn point_label(name: &str, identifier: &str) -> String {
    let ident = identifier.trim();
    if !ident.is_empty() {
        return ident.to_uppercase();
    }
    name.trim().to_uppercase()
}

fn parse_airlines(text: &str) -> Result<Vec<AirlineRecord>, String> {
    let (headers, rows) = read_records(text);
    if headers.is_empty() {
        return Err("FLIGHT_AIRLINE.csv 是空文件".to_string());
    }
    let id = find_column(&headers, &["FLIGHTAIRLINEID"], &["POINT"])
        .ok_or_else(|| format!("FLIGHT_AIRLINE.csv 里找不到 FLIGHT_AIRLINE_ID（表头：{}）", headers.join(", ")))?;
    let name = find_column(&headers, &["NAME"], &["AIRPORT"]);
    let departure = find_column(&headers, &["STARTAIRPORTID", "DEP", "ADEP", "ORIGIN"], &["ARR", "NAME"]);
    let arrival = find_column(&headers, &["ENDAIRPORTID", "ARR", "ADES", "DEST"], &["DEP", "NAME"]);
    let distance = find_column(&headers, &["DISTANCE", "DIST"], &[]);
    let description = find_column(&headers, &["ROUTES"], &[]);

    let mut records = Vec::new();
    for row in rows {
        let Some(record_id) = row.get(id).map(|value| value.trim().to_string()).filter(|value| !value.is_empty()) else {
            continue;
        };
        records.push(AirlineRecord {
            id: record_id,
            name: name
                .and_then(|index| row.get(index))
                .map(|value| value.trim().to_string())
                .unwrap_or_default(),
            departure: departure
                .and_then(|index| row.get(index))
                .and_then(|value| airport_icao(value))
                .unwrap_or_default(),
            arrival: arrival
                .and_then(|index| row.get(index))
                .and_then(|value| airport_icao(value))
                .unwrap_or_default(),
            distance: distance
                .and_then(|index| row.get(index))
                .and_then(|value| number(value)),
            description: description
                .and_then(|index| row.get(index))
                .map(|value| value.trim().to_string())
                .unwrap_or_default(),
        });
    }
    Ok(records)
}

/// 预筛：只把命中 `wanted` 的行留给 csv 解析器。
///
/// 航段表实测 78 MB / 39 万行 / 22 列，让 csv crate 全量建 `Vec<String>`
/// 要分配 860 万个字符串（约 1~2 秒、上百 MB 峰值），而一次查询往往只关心几条航路。
/// 这里先用零分配的字节切片挑行：真实文件里 `FLIGHT_AIRLINE_ID` 是第 2 列且为 UUID，
/// 不含引号和逗号，所以「找前两个逗号」是安全的；列序不符时退回全量解析。
fn filter_rows(text: &str, id_column: usize, wanted: &HashSet<String>) -> Option<String> {
    if id_column != 1 || text.is_empty() {
        return None;
    }
    let header_end = text.find('\n')?;
    let mut kept = String::from(&text[..=header_end]);
    let body = &text[header_end + 1..];
    let mut hits = 0usize;
    for line in body.split('\n') {
        if line.is_empty() {
            continue;
        }
        let Some(id) = line.splitn(3, ',').nth(1) else {
            continue;
        };
        if wanted.contains(id.trim()) {
            kept.push_str(line);
            kept.push('\n');
            hits += 1;
        }
    }
    // 一条都没命中说明预筛假设不成立（分隔符/列序变了），交给全量解析兜底。
    if hits == 0 && !wanted.is_empty() && !body.is_empty() {
        return None;
    }
    Some(kept)
}

/// 只收 `wanted` 里的航路航段，边读边过滤。
fn parse_legs(text: &str, wanted: &HashSet<String>) -> Result<HashMap<String, Vec<RouteLeg>>, String> {
    let header_end = text.find('\n').ok_or_else(|| "FLIGHT_AIRLINE_POINT.csv 是空文件".to_string())?;
    let (header, _) = read_records(&text[..header_end]);
    if header.is_empty() {
        return Err("FLIGHT_AIRLINE_POINT.csv 是空文件".to_string());
    }
    let airline = find_column(&header, &["FLIGHTAIRLINEID"], &["POINT"])
        .ok_or_else(|| format!("FLIGHT_AIRLINE_POINT.csv 里找不到 FLIGHT_AIRLINE_ID（表头：{}）", header.join(", ")))?;
    let sequence = find_column(&header, &["SEQUNCE", "SEQUENCE", "SEQ"], &[]);
    let airway = find_column(&header, &["AIRWAYNAME", "AIRWAY"], &[]);
    let start_name = find_column(&header, &["STARTPOINTNAME"], &["NO1"]);
    let start_identifier = find_column(&header, &["STARTPOINTIDENTIFIER"], &[]);
    let end_name = find_column(&header, &["ENDPOINTNAME"], &["NO1"]);
    let end_identifier = find_column(&header, &["ENDPOINTIDENTIFIER"], &[]);

    let filtered = filter_rows(text, airline, wanted).unwrap_or_else(|| text.to_string());
    let (_, rows) = read_records(&filtered);

    let mut grouped: HashMap<String, Vec<RouteLeg>> = HashMap::new();
    for row in rows {
        let Some(key) = row.get(airline).map(|value| value.trim().to_string()).filter(|value| !value.is_empty()) else {
            continue;
        };
        let text_at = |index: Option<usize>| {
            index
                .and_then(|column| row.get(column))
                .map(|value| value.trim().to_string())
                .unwrap_or_default()
        };
        grouped.entry(key).or_default().push(RouteLeg {
            sequence: sequence
                .and_then(|column| row.get(column))
                .and_then(|value| number(value))
                .unwrap_or_default(),
            airway: text_at(airway),
            start: point_label(&text_at(start_name), &text_at(start_identifier)),
            end: point_label(&text_at(end_name), &text_at(end_identifier)),
        });
    }
    for legs in grouped.values_mut() {
        legs.sort_by(|left, right| left.sequence.total_cmp(&right.sequence));
    }
    Ok(grouped)
}

/// 把航段拼成标准航路串：`ELKUR W40 PANKI W158 AR H104 …`。
///
/// 同一航路连续多跳（W40 里 DOXAB/OVNUG/P149 都是中间点）只保留末端点，
/// 否则航路串会膨胀到几十个点、提交给 FSD 也难看。
fn build_route_text(legs: &[RouteLeg]) -> String {
    let mut tokens: Vec<String> = Vec::new();
    let mut last_airway = String::new();
    for leg in legs {
        if tokens.is_empty() && !leg.start.is_empty() {
            tokens.push(leg.start.clone());
        }
        if leg.end.is_empty() {
            continue;
        }
        if !last_airway.is_empty() && leg.airway.eq_ignore_ascii_case(&last_airway) {
            if let Some(last) = tokens.last_mut() {
                *last = leg.end.clone();
            }
        } else {
            if !leg.airway.is_empty() {
                tokens.push(leg.airway.clone());
                last_airway = leg.airway.clone();
            } else {
                last_airway.clear();
            }
            tokens.push(leg.end.clone());
        }
    }
    tokens.join(" ")
}

fn file_stamp(path: &Path) -> u128 {
    fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or_default()
}

fn cache_key(path: &Path) -> String {
    format!("{}|{}", path.display(), file_stamp(path))
}

/// 主表缓存：13908 行、3.4 MB，解析一次约几十毫秒，按文件修改时间失效。
struct CachedAirlines {
    key: String,
    records: Arc<Vec<AirlineRecord>>,
}

static AIRLINE_CACHE: OnceLock<Mutex<Option<CachedAirlines>>> = OnceLock::new();

fn airline_records(path: &Path) -> Result<Arc<Vec<AirlineRecord>>, String> {
    let key = cache_key(path);
    let cache = AIRLINE_CACHE.get_or_init(|| Mutex::new(None));
    if let Ok(guard) = cache.lock() {
        if let Some(cached) = guard.as_ref().filter(|cached| cached.key == key) {
            return Ok(Arc::clone(&cached.records));
        }
    }
    let records = Arc::new(parse_airlines(&read_text(path)?)?);
    if let Ok(mut guard) = cache.lock() {
        *guard = Some(CachedAirlines {
            key,
            records: Arc::clone(&records),
        });
    }
    Ok(records)
}

/// 航段缓存：**累积式**，只记已经查过的航路。
///
/// 航段表 78 MB，全量分组要几百 MB；但用户一次只查一对起降场，
/// 所以每次只扫出目标航路的行（`filter_rows` 零分配预筛），
/// 结果并入缓存，同一个数据包内后续查询直接命中。
struct CachedLegs {
    key: String,
    legs: HashMap<String, Vec<RouteLeg>>,
}

static LEG_CACHE: OnceLock<Mutex<Option<CachedLegs>>> = OnceLock::new();

fn legs_for(point_path: &Path, wanted: &HashSet<String>) -> Result<HashMap<String, Vec<RouteLeg>>, String> {
    let key = cache_key(point_path);
    let cache = LEG_CACHE.get_or_init(|| Mutex::new(None));

    let mut missing = wanted.clone();
    if let Ok(guard) = cache.lock() {
        if let Some(cached) = guard.as_ref().filter(|cached| cached.key == key) {
            missing.retain(|id| !cached.legs.contains_key(id));
        }
    }

    if !missing.is_empty() {
        let mut parsed = parse_legs(&read_text(point_path)?, &missing)?;
        // 没有航段的目标也记成空向量，避免同一条航路被反复全表扫描。
        for id in &missing {
            parsed.entry(id.clone()).or_default();
        }
        if let Ok(mut guard) = cache.lock() {
            match guard.as_mut().filter(|cached: &&mut CachedLegs| cached.key == key) {
                Some(cached) => cached.legs.extend(parsed),
                None => {
                    *guard = Some(CachedLegs {
                        key: key.clone(),
                        legs: parsed,
                    })
                }
            }
        }
    }

    let mut result = HashMap::new();
    if let Ok(guard) = cache.lock() {
        if let Some(cached) = guard.as_ref().filter(|cached| cached.key == key) {
            for id in wanted {
                if let Some(legs) = cached.legs.get(id) {
                    result.insert(id.clone(), legs.clone());
                }
            }
        }
    }
    Ok(result)
}

fn route_paths(root: &Path) -> Result<(PathBuf, PathBuf), String> {
    let airline_path = root.join(ROUTE_FILE);
    if !airline_path.is_file() {
        return Err(format!("所选目录下没有 {ROUTE_FILE}"));
    }
    let point_path = root.join(ROUTE_POINT_FILE);
    if !point_path.is_file() {
        return Err(format!(
            "缺少 {ROUTE_POINT_FILE}：班机航路要靠它按航段拼出航路串，只有 {ROUTE_FILE} 拼不出来"
        ));
    }
    Ok((airline_path, point_path))
}

/// 把主表记录 + 航段拼成可提交的航路。
fn stitch_routes(point_path: &Path, records: &[AirlineRecord]) -> Result<Vec<NaipRoute>, String> {
    if records.is_empty() {
        return Ok(Vec::new());
    }
    let wanted: HashSet<String> = records.iter().map(|record| record.id.clone()).collect();
    let legs = legs_for(point_path, &wanted)?;
    let mut routes = Vec::with_capacity(records.len());
    for record in records {
        let route_legs = legs.get(&record.id).map(Vec::as_slice).unwrap_or(&[]);
        let route_text = build_route_text(route_legs);
        if route_text.is_empty() {
            continue;
        }
        routes.push(NaipRoute {
            id: record.id.clone(),
            name: if record.name.is_empty() {
                format!("{}-{}", record.departure, record.arrival)
            } else {
                record.name.clone()
            },
            departure: record.departure.clone(),
            arrival: record.arrival.clone(),
            route: route_text,
            legs: route_legs.len(),
            distance_nm: record.distance,
            description: record.description.clone(),
        });
    }
    Ok(routes)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NaipStatus {
    pub root: Option<String>,
    pub airport_file: Option<String>,
    pub route_file: Option<String>,
    pub point_file: Option<String>,
    pub airport_count: usize,
    pub route_count: usize,
    pub airport_message: String,
    pub route_message: String,
}

/// 读机场库：AD_HP.csv 里的 ICAO + 中文名 + 坐标原始串。
#[tauri::command]
pub fn get_local_airports() -> Result<Vec<NaipAirport>, String> {
    let Some(root) = data_root()? else {
        return Err("尚未选择本地航图库".to_string());
    };
    let path = root.join(AIRPORT_FILE);
    if !path.is_file() {
        return Err(format!("所选目录下没有 {AIRPORT_FILE}"));
    }
    parse_airports(&read_text(&path)?)
}

/// 按起降机场查班机航路；`dep` / `arr` 留空时返回前若干条（供 UI 自检）。
#[tauri::command]
pub fn search_flight_routes(dep: String, arr: String, limit: Option<usize>) -> Result<Vec<NaipRoute>, String> {
    let Some(root) = data_root()? else {
        return Err("尚未选择本地航图库".to_string());
    };
    let (airline_path, point_path) = route_paths(&root)?;
    let departure = dep.trim().to_uppercase();
    let arrival = arr.trim().to_uppercase();
    let max = limit.unwrap_or(24).clamp(1, 200);
    let records = airline_records(&airline_path)?;
    let picked: Vec<AirlineRecord> = records
        .iter()
        .filter(|route| departure.is_empty() || route.departure == departure)
        .filter(|route| arrival.is_empty() || route.arrival == arrival)
        .take(max)
        .cloned()
        .collect();
    stitch_routes(&point_path, &picked)
}

/// NAIP 的度分秒坐标串（`N400421` / `E1163551`，允许小数秒）→ 十进制度。
/// 与前端 airport-data.ts 的 parseCoordinate 同一套规则：纬度 2 位度、经度 3 位度。
fn dms_to_degrees(raw: &str) -> Option<f64> {
    let text = raw.trim().to_uppercase();
    let sign = match text.chars().next()? {
        'N' | 'E' => 1.0,
        'S' | 'W' => -1.0,
        _ => return None,
    };
    let digits: String = text.chars().filter(|c| c.is_ascii_digit() || *c == '.').collect();
    let (whole, fraction) = match digits.split_once('.') {
        Some((whole, fraction)) => (whole.to_string(), fraction.to_string()),
        None => (digits, String::new()),
    };
    if whole.len() < 5 {
        return None;
    }
    let degree_digits = if whole.len() >= 7 { 3 } else { 2 };
    let degrees: f64 = whole[..degree_digits].parse().ok()?;
    let minutes: f64 = whole[degree_digits..degree_digits + 2].parse().ok()?;
    let seconds: f64 = format!("{}.{}", whole.get(degree_digits + 2..).unwrap_or("0"), fraction).parse().ok()?;
    let value = sign * (degrees + minutes / 60.0 + seconds / 3600.0);
    value.is_finite().then_some(value)
}

/// 班机航路的航点解析结果。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NaipRoutePoints {
    /// 航段端点总数（含起降衔接点）。
    pub total: usize,
    /// 按航段顺序排好的航点（只含有坐标的）。
    pub points: Vec<FlightRoutePoint>,
    /// 导航库与机场库都没查到坐标的标识。
    pub missing: Vec<String>,
    /// 解析过程的提示（如导航库不可用）。
    pub note: String,
}

/// 班机航路的航路点：**不走 XFS**。
///
/// 航点序列直接取 `FLIGHT_AIRLINE_POINT.csv` 的航段端点（按 Sequnce 排序、
/// 相邻去重）；坐标查本地导航库（DFD v2 / LNM / Fenix），机场四字码再退
/// AD_HP.csv 兜底。`route_id` 是 FLIGHT_AIRLINE.csv 的 FLIGHT_AIRLINE_ID。
#[tauri::command]
pub fn get_naip_route_points(route_id: String) -> Result<NaipRoutePoints, String> {
    let Some(root) = data_root()? else {
        return Err("尚未选择本地航图库".to_string());
    };
    let (_airline_path, point_path) = route_paths(&root)?;
    let route_id = route_id.trim().to_string();
    let wanted: HashSet<String> = HashSet::from([route_id.clone()]);
    let legs = legs_for(&point_path, &wanted)?;
    let route_legs = legs.get(&route_id).map(Vec::as_slice).unwrap_or(&[]);
    if route_legs.is_empty() {
        return Err("航段表（FLIGHT_AIRLINE_POINT.csv）里没有这条航路的数据".to_string());
    }

    // 全量端点序列：首段起点 + 每段终点；相邻重复（同一点是两段的衔接处）只留一个。
    let mut labels: Vec<String> = Vec::new();
    for leg in route_legs {
        for endpoint in [&leg.start, &leg.end] {
            let label = endpoint.trim().to_uppercase();
            if label.is_empty() {
                continue;
            }
            if labels.last().map(|last| last != &label).unwrap_or(true) {
                labels.push(label);
            }
        }
    }

    // 坐标：先查导航库；导航库没配/查失败不致命，机场端点还有 AD_HP 兜底。
    let mut note = String::new();
    let fixes = match super::navigation::resolve_route_fixes(labels.clone()) {
        Ok(fixes) => fixes,
        Err(error) => {
            note = format!("导航库坐标不可用：{error}");
            HashMap::new()
        }
    };

    // 导航库没命中的四字码用 AD_HP.csv 的机场坐标兜底（按需才解析，约几十毫秒）。
    let mut airports_by_icao: HashMap<String, [f64; 2]> = HashMap::new();
    let unresolved_airports: Vec<&String> = labels
        .iter()
        .filter(|label| !fixes.contains_key(*label))
        .filter(|label| label.len() == 4 && label.chars().all(|c| c.is_ascii_alphabetic()))
        .collect();
    if !unresolved_airports.is_empty() {
        let airport_path = root.join(AIRPORT_FILE);
        if airport_path.is_file() {
            if let Ok(list) = parse_airports(&read_text(&airport_path)?) {
                for airport in list {
                    if let (Some(latitude), Some(longitude)) = (
                        dms_to_degrees(&airport.latitude_raw),
                        dms_to_degrees(&airport.longitude_raw),
                    ) {
                        airports_by_icao.insert(airport.icao, [latitude, longitude]);
                    }
                }
            }
        }
    }

    let mut points = Vec::new();
    let mut missing = Vec::new();
    for label in &labels {
        let fix = fixes
            .get(label)
            .or_else(|| airports_by_icao.get(label))
            .copied();
        match fix {
            Some([latitude, longitude]) => points.push(FlightRoutePoint {
                ident: label.clone(),
                name: label.clone(),
                latitude,
                longitude,
                leg_type: None,
                arc_center: None,
                course: None,
                course_only: false,
            }),
            None => missing.push(label.clone()),
        }
    }
    Ok(NaipRoutePoints {
        total: labels.len(),
        points,
        missing,
        note,
    })
}

/// 设置页自检：数据包根目录、三份 CSV 的条数与解析结论。
#[tauri::command]
pub fn get_naip_status() -> Result<NaipStatus, String> {
    let root = data_root()?;
    let root_text = root.as_ref().map(|path| path.to_string_lossy().to_string());
    let airport_path = root.as_ref().map(|path| path.join(AIRPORT_FILE)).filter(|path| path.is_file());
    let route_path = root.as_ref().map(|path| path.join(ROUTE_FILE)).filter(|path| path.is_file());
    let point_path = root.as_ref().map(|path| path.join(ROUTE_POINT_FILE)).filter(|path| path.is_file());

    let (airport_count, airport_message) = match &airport_path {
        Some(path) => match read_text(path).and_then(|text| parse_airports(&text)) {
            Ok(list) => (list.len(), format!("已识别 {} 座机场", list.len())),
            Err(error) => (0, error),
        },
        None => (0, format!("目录里没有 {AIRPORT_FILE}")),
    };
    let (route_count, route_message) = match root.as_ref() {
        Some(directory) => match route_paths(directory) {
            Err(error) => (0, error),
            Ok((airline_path, point_path)) => match airline_records(&airline_path) {
                Err(error) => (0, error),
                Ok(records) => {
                    // 抽样拼 3 条，验证航段表能真的拼出航路串（只扫一次，约百毫秒）。
                    let sample = records.len().min(3);
                    let stitched = stitch_routes(&point_path, &records[..sample])
                        .map(|routes| routes.len())
                        .unwrap_or(0);
                    let size = fs::metadata(&point_path).map(|meta| meta.len() / 1024 / 1024).unwrap_or(0);
                    (
                        records.len(),
                        format!("已识别 {} 条班机航路（航段表 {size} MB，抽样拼出 {stitched}/{sample} 条）", records.len()),
                    )
                }
            },
        },
        None => (0, "尚未选择数据包目录".to_string()),
    };

    Ok(NaipStatus {
        root: root_text,
        airport_file: airport_path.map(|path| path.to_string_lossy().to_string()),
        route_file: route_path.map(|path| path.to_string_lossy().to_string()),
        point_file: point_path.map(|path| path.to_string_lossy().to_string()),
        airport_count,
        route_count,
        airport_message,
        route_message,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const AIRPORTS: &str = "AD_HP_ID,CODE_ID,TXT_NAME,CODE_IATA,GEO_LAT_ACCURACY,GEO_LONG_ACCURACY,VAL_ELEV,UOM_DIST_VER,IS_INTERNATIONAL\n\
1,ZBAA,北京/首都,PEK,N400421,E1163551,35,M,Y\n\
2,ZSAM,厦门/高崎,XMN,N243239,E1180740,18,M,N\n\
3,,,,,,,, \n";

    /// 与真实数据同构：主表的 `Routes` 是中文描述，航路串要从 POINT 表拼。
    const AIRLINES: &str = "FLIGHT_AIRLINE_ID,name,LineType,StartAirportID,StartAirportName,EndAirportID,EndAirportName,Distance,Routes\n\
a1,ZBAA-ZSAM-01,国内班机航线,ZBAA,北京/首都,ZSAM,厦门/高崎,1360,北京/首都经ELKUR、W40PANKI至厦门/高崎。\n\
a2,ZBAA-ZSPD-01,国内班机航线,ZBAA,北京/首都,ZSPD,上海/浦东,1131,北京/首都经ELKUR至上海/浦东。\n";

    const POINTS: &str = "FLIGHT_AIRLINE_POINT_ID,FLIGHT_AIRLINE_ID,Sequnce,AirwayName,StartPointName,StartPointIdentifier,EndPointName,EndPointIdentifier\n\
p1,a1,1,W40,ELKUR,,DOXAB,\n\
p2,a1,2,W40,DOXAB,,PANKI,\n\
p3,a1,3,W158,PANKI,,\u{5f20}\u{5e84}NDB,AR\n\
p4,a2,1,W40,ELKUR,,PANKI,\n";

    fn wanted(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|id| id.to_string()).collect()
    }

    #[test]
    fn reads_airport_names_and_skips_empty_rows() {
        let airports = parse_airports(AIRPORTS).expect("airport csv");
        assert_eq!(airports.len(), 2);
        assert_eq!(airports[0].icao, "ZBAA");
        assert_eq!(airports[0].name, "北京/首都");
        assert_eq!(airports[0].iata, "PEK");
        assert!(airports[0].international);
        assert_eq!(airports[0].latitude_raw, "N400421");
        assert_eq!(airports[0].elevation, "35 m");
    }

    #[test]
    fn stitches_route_from_legs() {
        let records = parse_airlines(AIRLINES).expect("airline csv");
        let legs = parse_legs(POINTS, &wanted(&["a1", "a2"])).expect("point csv");
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].departure, "ZBAA");
        assert_eq!(records[0].arrival, "ZSAM");

        // 同一航路连续多跳只保留末端点：W40 的 DOXAB 被 PANKI 顶掉。
        let route = build_route_text(&legs["a1"]);
        assert_eq!(route, "ELKUR W40 PANKI W158 AR");
        let second = build_route_text(&legs["a2"]);
        assert_eq!(second, "ELKUR W40 PANKI");
    }

    #[test]
    fn sorts_legs_by_sequence() {
        let shuffled = "FLIGHT_AIRLINE_POINT_ID,FLIGHT_AIRLINE_ID,Sequnce,AirwayName,StartPointName,EndPointName\n\
p2,a1,2,W40,DOXAB,PANKI\n\
p1,a1,1,W40,ELKUR,DOXAB\n";
        let legs = parse_legs(shuffled, &wanted(&["a1"])).expect("point csv");
        assert_eq!(build_route_text(&legs["a1"]), "ELKUR W40 PANKI");
    }

    #[test]
    fn skips_legs_of_other_routes() {
        // wanted 只给 a2，a1 的航段不该出现，也不该把 a1 塞进结果里。
        let legs = parse_legs(POINTS, &wanted(&["a2"])).expect("point csv");
        assert_eq!(legs.len(), 1);
        assert!(!legs.contains_key("a1"));
        assert_eq!(build_route_text(&legs["a2"]), "ELKUR W40 PANKI");
    }

    #[test]
    fn prefilter_matches_second_column_only() {
        // 预筛只看第 2 列：起点列里出现 a1 不算命中。
        let text = "ID,AIRLINE,POINT\na1,x,a1\na9,a1,y\n";
        let filtered = filter_rows(text, 1, &wanted(&["a1"])).expect("prefilter");
        assert_eq!(filtered, "ID,AIRLINE,POINT\na9,a1,y\n");
        // 列序不符时不下结论，交回调用方全量解析。
        assert!(filter_rows(text, 0, &wanted(&["a1"])).is_none());
    }

    #[test]
    fn parses_dms_coordinates() {
        // 纬度 2 位度：N40°04'21" = 40.0725
        let latitude = dms_to_degrees("N400421").expect("lat");
        assert!((latitude - 40.0725).abs() < 1e-9);
        // 经度 3 位度 + 小数秒：E116°35'51.2"
        let longitude = dms_to_degrees("E1163551.2").expect("lon");
        assert!((longitude - (116.0 + 35.0 / 60.0 + 51.2 / 3600.0)).abs() < 1e-9);
        // 南/西为负
        assert!(dms_to_degrees("S335930").unwrap() < 0.0);
        assert!(dms_to_degrees("W1200000").unwrap() < 0.0);
        // 非法输入返回 None
        assert!(dms_to_degrees("ZBAA").is_none());
        assert!(dms_to_degrees("").is_none());
    }

    #[test]
    fn dedups_consecutive_leg_endpoints() {
        // 相邻航段共用端点时，序列里同一点只出现一次（a1 的 DOXAB 被 PANKI 衔接顶掉）。
        let legs = parse_legs(POINTS, &wanted(&["a1"])).expect("point csv");
        let mut labels: Vec<String> = Vec::new();
        for leg in &legs["a1"] {
            for endpoint in [&leg.start, &leg.end] {
                let label = endpoint.trim().to_uppercase();
                if label.is_empty() {
                    continue;
                }
                if labels.last().map(|last| last != &label).unwrap_or(true) {
                    labels.push(label);
                }
            }
        }
        assert_eq!(labels, vec!["ELKUR", "DOXAB", "PANKI", "AR"]);
    }

    /// 真实数据端到端：用已配置的数据包 + 导航库解析班机航路航点。
    /// 平时忽略，验证时 `cargo test --lib debug_real_naip -- --ignored --nocapture`。
    #[test]
    #[ignore]
    fn debug_real_naip_route_points() {
        let rows = search_flight_routes("ZBAA".into(), "ZSAM".into(), Some(3)).expect("search");
        assert!(!rows.is_empty(), "没查到班机航路");
        for row in &rows {
            let started = std::time::Instant::now();
            let result = get_naip_route_points(row.id.clone()).expect("points");
            println!(
                "{}: {} 段 → {} 点（缺失 {}），耗时 {:?}{}",
                row.name,
                row.legs,
                result.points.len(),
                result.missing.join(","),
                started.elapsed(),
                if result.note.is_empty() { String::new() } else { format!("，note: {}", result.note) },
            );
            for point in result.points.iter().take(3) {
                println!("  {} @ {:.4},{:.4}", point.ident, point.latitude, point.longitude);
            }
        }
    }
}

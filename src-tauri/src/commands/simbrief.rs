use super::flightplan::FlightRoutePoint;
use serde::Serialize;
use serde_json::Value;
use std::time::Duration;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimBriefFlight {
    pub username: String,
    pub callsign: String,
    pub departure: String,
    pub arrival: String,
    pub alternate: Option<String>,
    pub route: String,
    pub aircraft: String,
    pub cruise_altitude: String,
    pub scheduled_out: String,
    pub route_points: Vec<FlightRoutePoint>,
}

fn text_at(payload: &Value, pointer: &str) -> String {
    payload
        .pointer(pointer)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn first_text(payload: &Value, pointers: &[&str]) -> String {
    pointers
        .iter()
        .map(|pointer| text_at(payload, pointer))
        .find(|value| !value.is_empty())
        .unwrap_or_default()
}

fn format_altitude(value: String) -> String {
    if value.len() == 5 && value.chars().all(|character| character.is_ascii_digit()) {
        return format!("FL{}", &value[..3]);
    }
    value
}

fn value_text(value: Option<&Value>) -> String {
    value
        .and_then(|value| {
            value
                .as_str()
                .map(str::to_string)
                .or_else(|| value.as_f64().map(|number| number.to_string()))
        })
        .unwrap_or_default()
}

fn coordinate(value: Option<&Value>, latitude: bool) -> Option<f64> {
    let raw = value_text(value).trim().to_uppercase();
    if raw.is_empty() {
        return None;
    }
    let negative = raw.starts_with('S') || raw.starts_with('W') || raw.starts_with('-');
    let numeric = raw
        .trim_start_matches(['N', 'S', 'E', 'W', '+', '-'])
        .parse::<f64>()
        .ok()?;
    let limit = if latitude { 90.0 } else { 180.0 };
    let result = if numeric > limit {
        let degrees = (numeric / 100.0).floor();
        degrees + (numeric - degrees * 100.0) / 60.0
    } else {
        numeric
    };
    (result <= limit).then_some(if negative { -result } else { result })
}

fn is_non_enroute_fix(fix: &serde_json::Map<String, Value>) -> bool {
    let terminal = ["is_sid_star", "is_terminal", "terminal"]
        .iter()
        .filter_map(|key| fix.get(*key))
        .map(|value| value_text(Some(value)).to_uppercase())
        .any(|value| {
            matches!(
                value.as_str(),
                "1" | "TRUE" | "YES" | "SID" | "STAR" | "APPROACH"
            )
        });
    let phase = ["stage", "phase", "type", "fix_type", "procedure_type"]
        .iter()
        .filter_map(|key| fix.get(*key))
        .map(|value| value_text(Some(value)).to_uppercase())
        .any(|value| {
            [
                "SID",
                "STAR",
                "APP",
                "APPROACH",
                "ARRIVAL",
                "DEPARTURE",
                "TERMINAL",
                "AIRPORT",
                "APT",
            ]
            .iter()
            .any(|excluded| value == *excluded || value.contains(excluded))
        });
    let airport = ["is_airport", "airport"]
        .iter()
        .filter_map(|key| fix.get(*key))
        .map(|value| value_text(Some(value)).to_uppercase())
        .any(|value| matches!(value.as_str(), "1" | "TRUE" | "YES"));
    let ident = ["ident", "fix", "name", "id"]
        .iter()
        .map(|key| value_text(fix.get(*key)).to_uppercase())
        .find(|value| !value.is_empty())
        .unwrap_or_default();
    terminal || phase || airport || matches!(ident.as_str(), "TOC" | "TOD")
}

fn simbrief_route_points(payload: &Value) -> Vec<FlightRoutePoint> {
    let fixes = payload
        .pointer("/navlog/fix")
        .or_else(|| payload.pointer("/navlog/fixes"))
        .and_then(Value::as_array);
    let Some(fixes) = fixes else {
        return Vec::new();
    };
    let mut points = Vec::new();
    for fix in fixes.iter().filter_map(Value::as_object) {
        if is_non_enroute_fix(fix) {
            continue;
        }
        let latitude = coordinate(
            fix.get("pos_lat")
                .or_else(|| fix.get("latitude"))
                .or_else(|| fix.get("lat")),
            true,
        );
        let longitude = coordinate(
            fix.get("pos_long")
                .or_else(|| fix.get("longitude"))
                .or_else(|| fix.get("lon")),
            false,
        );
        let (Some(latitude), Some(longitude)) = (latitude, longitude) else {
            continue;
        };
        let ident = ["ident", "fix", "name", "id"]
            .iter()
            .map(|key| value_text(fix.get(*key)))
            .find(|value| !value.is_empty())
            .unwrap_or_else(|| "航路点".to_string());
        if points.last().is_some_and(|point: &FlightRoutePoint| {
            (point.latitude - latitude).abs() < 0.00001
                && (point.longitude - longitude).abs() < 0.00001
        }) {
            continue;
        }
        points.push(FlightRoutePoint {
            name: value_text(fix.get("name")),
            ident,
            latitude,
            longitude,
            leg_type: None,
            arc_center: None,
            course: None,
            course_only: false,
        });
    }
    points
}

fn simbrief_airport_point(payload: &Value, section: &str, ident: &str) -> Option<FlightRoutePoint> {
    let airport = payload.pointer(section)?.as_object()?;
    let latitude = coordinate(
        airport
            .get("pos_lat")
            .or_else(|| airport.get("latitude"))
            .or_else(|| airport.get("lat")),
        true,
    )?;
    let longitude = coordinate(
        airport
            .get("pos_long")
            .or_else(|| airport.get("longitude"))
            .or_else(|| airport.get("lon")),
        false,
    )?;
    Some(FlightRoutePoint {
        ident: ident.to_string(),
        name: value_text(airport.get("name")),
        latitude,
        longitude,
        leg_type: None,
        arc_center: None,
        course: None,
        course_only: false,
    })
}

#[tauri::command]
pub async fn import_simbrief_flight(username: String) -> Result<SimBriefFlight, String> {
    let username = username.trim().to_string();
    if username.is_empty()
        || username.len() > 64
        || !username.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '_' || character == '-'
        })
    {
        return Err("请输入有效的 SimBrief 用户名".to_string());
    }
    let url = reqwest::Url::parse_with_params(
        "https://www.simbrief.com/api/xml.fetcher.php",
        [("username", username.as_str()), ("json", "1")],
    )
    .map_err(|_| "无法创建 SimBrief 请求".to_string())?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent("SkyBoard-EFB/1.0")
        .build()
        .map_err(|_| "无法创建 SimBrief 请求".to_string())?;
    let response = client.get(url).send().await.map_err(|error| {
        if error.is_timeout() {
            "SimBrief 请求超时".to_string()
        } else {
            "无法连接 SimBrief 服务".to_string()
        }
    })?;
    if !response.status().is_success() {
        return Err("未找到该用户的最近飞行计划，或 SimBrief 服务返回错误".to_string());
    }
    let payload: Value = response
        .json()
        .await
        .map_err(|_| "SimBrief 返回的数据不是有效 JSON".to_string())?;
    let departure = first_text(&payload, &["/origin/icao_code", "/origin/icao"]);
    let arrival = first_text(&payload, &["/destination/icao_code", "/destination/icao"]);
    if departure.is_empty() || arrival.is_empty() {
        return Err("SimBrief 飞行计划缺少出发或到达机场".to_string());
    }
    let airline = first_text(
        &payload,
        &["/general/icao_airline", "/general/airline_icao"],
    );
    let flight_number = first_text(
        &payload,
        &["/general/flight_number", "/general/icao_flight_number"],
    );
    let callsign = first_text(
        &payload,
        &["/general/icao_flight_number", "/general/callsign"],
    );
    let mut route_points = simbrief_route_points(&payload);
    if let Some(origin) = simbrief_airport_point(&payload, "/origin", &departure) {
        if !route_points.first().is_some_and(|point| {
            (point.latitude - origin.latitude).abs() < 0.00001
                && (point.longitude - origin.longitude).abs() < 0.00001
        }) {
            route_points.insert(0, origin);
        }
    }
    if let Some(destination) = simbrief_airport_point(&payload, "/destination", &arrival) {
        if !route_points.last().is_some_and(|point| {
            (point.latitude - destination.latitude).abs() < 0.00001
                && (point.longitude - destination.longitude).abs() < 0.00001
        }) {
            route_points.push(destination);
        }
    }
    Ok(SimBriefFlight {
        username,
        callsign: if callsign.is_empty() {
            format!("{airline}{flight_number}")
        } else {
            callsign
        },
        departure,
        arrival,
        alternate: first_text(&payload, &["/alternate/icao_code", "/alternate/icao"]).into(),
        route: first_text(&payload, &["/general/route", "/atc/route"]),
        aircraft: first_text(
            &payload,
            &[
                "/aircraft/icao_code",
                "/aircraft/icaocode",
                "/aircraft/name",
            ],
        ),
        cruise_altitude: format_altitude(first_text(
            &payload,
            &["/general/initial_altitude", "/general/cruise_altitude"],
        )),
        scheduled_out: first_text(&payload, &["/times/sched_out", "/times/scheduled_out"]),
        route_points,
    })
}

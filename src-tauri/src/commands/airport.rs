use serde::{de::DeserializeOwned, Deserialize, Serialize};

const API_ROOT: &str = "https://api.xflysim.com/pilot/api/efb";

#[derive(Debug, Deserialize)]
struct ApiResponse<T> {
    data: T,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AirportGate {
    pub id: i64,
    pub gate_ref: String,
    pub gate_type: String,
    pub latitude: f64,
    pub longitude: f64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AirportFrequency {
    pub id: String,
    pub airport_ident: String,
    pub description: String,
    #[serde(rename(deserialize = "type", serialize = "frequencyType"))]
    pub frequency_type: String,
    pub frequency_mhz: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AirportRunway {
    pub id: String,
    pub airport_ident: String,
    pub le_ident: String,
    pub he_ident: String,
    pub length_ft: String,
    pub width_ft: String,
    pub surface: String,
    pub le_latitude_deg: String,
    pub le_longitude_deg: String,
    pub he_latitude_deg: String,
    pub he_longitude_deg: String,
    pub closed: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AirportChart {
    pub id: String,
    pub index_number: String,
    pub name: String,
    pub category: String,
    pub revision_date: String,
    pub image_day_url: String,
    pub image_night_url: String,
    pub thumb_day_url: String,
    pub thumb_night_url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XflyAirportData {
    pub gates: Vec<AirportGate>,
    pub frequencies: Vec<AirportFrequency>,
    pub runways: Vec<AirportRunway>,
    pub charts: Vec<AirportChart>,
}

async fn fetch_endpoint<T: DeserializeOwned>(
    client: &reqwest::Client,
    endpoint: &str,
    icao: &str,
) -> Result<T, String> {
    client
        .get(format!("{API_ROOT}/{endpoint}/{icao}"))
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?
        .json::<ApiResponse<T>>()
        .await
        .map(|response| response.data)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn get_xfly_airport_data(icao: String) -> Result<XflyAirportData, String> {
    let icao = icao.trim().to_uppercase();
    if icao.len() != 4
        || !icao
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
    {
        return Err("ICAO 机场代码无效".to_string());
    }
    let client = reqwest::Client::new();
    let (gates, frequencies, runways, charts) = tokio::try_join!(
        fetch_endpoint(&client, "gates", &icao),
        fetch_endpoint(&client, "frequency", &icao),
        fetch_endpoint(&client, "runway", &icao),
        fetch_endpoint(&client, "charts", &icao),
    )?;
    Ok(XflyAirportData {
        gates,
        frequencies,
        runways,
        charts,
    })
}

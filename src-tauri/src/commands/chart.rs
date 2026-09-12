use encoding_rs::GBK;
use serde::{Deserialize, Serialize};
use std::{
    collections::{hash_map::DefaultHasher, HashMap},
    fs::{self, File},
    hash::{Hash, Hasher},
    io::{self, Read},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};
use tauri::{AppHandle, Manager};
use zip::ZipArchive;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum LocalChartSourceType {
    Folder,
    Zip,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalChartLibraryConfig {
    path: String,
    source_type: LocalChartSourceType,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalChartLibraryStatus {
    pub ready: bool,
    pub path: Option<String>,
    pub source_type: Option<String>,
    pub airport_count: usize,
    pub chart_count: usize,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalChart {
    pub id: String,
    pub airport: String,
    pub title: String,
    pub category: String,
    pub revision: String,
}

#[derive(Debug, Clone, Deserialize)]
struct ChartCsvRecord {
    #[serde(rename = "AirportIcao", default)]
    airport: String,
    #[serde(rename = "ChartName", default)]
    title: String,
    #[serde(rename = "ChartTypeEx_CH", default)]
    chart_type: String,
    #[serde(rename = "PAGE_NUMBER", default)]
    page_number: String,
}

#[derive(Debug, Clone)]
struct ChartMetadata {
    title: String,
    chart_type: String,
    page_number: String,
}

type ChartMetadataIndex = HashMap<(String, String), ChartMetadata>;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalChartIndex {
    /// 解析规则版本：规则变化后 +1，让旧索引自动失效重扫。
    #[serde(default)]
    version: u32,
    path: String,
    source_type: LocalChartSourceType,
    charts: Vec<LocalChart>,
}

const INDEX_VERSION: u32 = 2;

static LOCAL_CHART_INDEX: OnceLock<Mutex<Option<LocalChartIndex>>> = OnceLock::new();

fn app_directory() -> Result<PathBuf, String> {
    let directory = std::env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .map_err(|_| "无法找到 Windows LocalAppData 目录".to_string())?
        .join("SkyBoard EFB");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory)
}

fn cache_directory(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?
        .join("chart-cache");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory)
}

fn library_config_path() -> Result<PathBuf, String> {
    Ok(app_directory()?.join("local-chart-library.json"))
}

fn library_index_path() -> Result<PathBuf, String> {
    Ok(app_directory()?.join("local-chart-index.json"))
}

fn read_library_config() -> Result<Option<LocalChartLibraryConfig>, String> {
    let path = library_config_path()?;
    if !path.exists() {
        return Ok(None);
    }
    serde_json::from_str(&fs::read_to_string(path).map_err(|error| error.to_string())?)
        .map(Some)
        .map_err(|_| "本地航图库配置无效".to_string())
}

fn write_library_config(config: &LocalChartLibraryConfig) -> Result<(), String> {
    fs::write(
        library_config_path()?,
        serde_json::to_string(config).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

fn index_matches(index: &LocalChartIndex, config: &LocalChartLibraryConfig) -> bool {
    index.version == INDEX_VERSION && index.path == config.path && index.source_type == config.source_type
}

fn read_library_index(config: &LocalChartLibraryConfig) -> Option<Vec<LocalChart>> {
    let memory = LOCAL_CHART_INDEX.get_or_init(|| Mutex::new(None));
    if let Ok(guard) = memory.lock() {
        if let Some(index) = guard.as_ref().filter(|index| index_matches(index, config)) {
            return Some(index.charts.clone());
        }
    }
    let index =
        serde_json::from_slice::<LocalChartIndex>(&fs::read(library_index_path().ok()?).ok()?)
            .ok()?;
    if !index_matches(&index, config) {
        return None;
    }
    if let Ok(mut guard) = memory.lock() {
        *guard = Some(index.clone());
    }
    Some(index.charts)
}

fn write_library_index(
    config: &LocalChartLibraryConfig,
    charts: &[LocalChart],
) -> Result<(), String> {
    let index = LocalChartIndex {
        version: INDEX_VERSION,
        path: config.path.clone(),
        source_type: config.source_type.clone(),
        charts: charts.to_vec(),
    };
    fs::write(
        library_index_path()?,
        serde_json::to_vec(&index).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    if let Ok(mut guard) = LOCAL_CHART_INDEX.get_or_init(|| Mutex::new(None)).lock() {
        *guard = Some(index);
    }
    Ok(())
}

fn terminal_directory(path: &Path) -> Option<PathBuf> {
    let is_terminal_directory = |name: &str| {
        name.eq_ignore_ascii_case("terminal") || name.eq_ignore_ascii_case("terminals")
    };
    if path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(is_terminal_directory)
    {
        return Some(path.to_path_buf());
    }
    ["Terminal", "Terminals"]
        .iter()
        .map(|name| path.join(name))
        .find(|directory| directory.is_dir())
}

fn airport_icao(value: &str) -> Option<String> {
    let value = value.trim().to_uppercase();
    (value.len() == 4
        && value
            .chars()
            .all(|character| character.is_ascii_alphabetic()))
    .then_some(value)
}

fn chart_category(name: &str) -> String {
    let name = name.to_uppercase();
    // 「精密进近地形图」属于机场障碍物图族，只是名字里带「进近」，
    // 必须先于进近规则排除，否则会被误分类为进场。
    if name.contains("精密进近地形") {
        return "机场".to_string();
    }
    if name.contains("标准仪表离场") || name.contains("SID") || name.contains("DEP") {
        "离场".to_string()
    } else if name.contains("标准仪表进场")
        || name.contains("进近")
        || name.contains("STAR")
        || name.contains("ARR")
        || name.contains("IAC")
        || name.contains("APP")
    {
        "进场".to_string()
    } else if name.contains("航路") || name.contains("ENR") || name.contains("ROUTE") {
        "航路".to_string()
    } else {
        "机场".to_string()
    }
}

fn chart_title(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("未命名航图")
        .replace(['_', '-'], " ")
}

fn is_pdf(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"))
}

fn normalized_chart_key(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_alphanumeric())
        .flat_map(char::to_uppercase)
        .collect()
}

fn decode_chart_csv(bytes: &[u8]) -> String {
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.trim_start_matches('\u{feff}').to_string();
    }
    let (text, _, _) = GBK.decode(bytes);
    text.trim_start_matches('\u{feff}').to_string()
}

/// 解析一份 Charts.csv。NAIP 数据的 `<ICAO>/Charts.csv` **没有 AirportIcao 列**
/// （表头为 ChartName,PAGE_NUMBER,ChartTypeEx_CH,IS_SUP,IsModify），
/// 此时机场码由所在文件夹名通过 `default_airport` 传入；带 AirportIcao 列的
/// 数据集仍按行内值优先。
fn chart_metadata_from_bytes(bytes: &[u8], default_airport: Option<&str>) -> ChartMetadataIndex {
    let text = decode_chart_csv(bytes);
    let mut reader = csv::ReaderBuilder::new()
        .flexible(true)
        .trim(csv::Trim::All)
        .from_reader(text.as_bytes());
    let mut metadata = ChartMetadataIndex::new();
    for record in reader
        .deserialize::<ChartCsvRecord>()
        .filter_map(Result::ok)
    {
        let airport = airport_icao(&record.airport)
            .or_else(|| default_airport.and_then(airport_icao));
        let Some(airport) = airport else {
            continue;
        };
        let item = ChartMetadata {
            title: record.title.trim().to_string(),
            chart_type: record.chart_type.trim().to_string(),
            page_number: record.page_number.trim().to_string(),
        };
        for key in [&item.page_number, &item.title] {
            let key = normalized_chart_key(key);
            if !key.is_empty() {
                metadata.insert((airport.clone(), key), item.clone());
            }
        }
    }
    metadata
}

fn extend_folder_metadata(
    metadata: &mut ChartMetadataIndex,
    path: &Path,
    default_airport: Option<&str>,
) -> Result<(), String> {
    if !path.is_file() {
        return Ok(());
    }
    metadata.extend(chart_metadata_from_bytes(
        &fs::read(path).map_err(|error| error.to_string())?,
        default_airport,
    ));
    Ok(())
}

fn folder_chart_metadata(terminals: &Path) -> Result<ChartMetadataIndex, String> {
    let mut metadata = ChartMetadataIndex::new();
    if let Some(parent) = terminals.parent() {
        extend_folder_metadata(&mut metadata, &parent.join("Charts.csv"), None)?;
    }
    extend_folder_metadata(&mut metadata, &terminals.join("Charts.csv"), None)?;
    for entry in fs::read_dir(terminals).map_err(|error| error.to_string())? {
        let path = entry.map_err(|error| error.to_string())?.path();
        if path.is_dir() {
            // 每个机场文件夹自己的 Charts.csv 不带 AirportIcao 列，机场码取文件夹名。
            let folder = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default();
            extend_folder_metadata(&mut metadata, &path.join("Charts.csv"), Some(folder))?;
        }
    }
    Ok(metadata)
}

fn metadata_for_pdf<'a>(
    metadata: &'a ChartMetadataIndex,
    airport: &str,
    path: &Path,
) -> Option<&'a ChartMetadata> {
    let stem = path
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    let code = stem.strip_prefix(&format!("{airport}-")).unwrap_or(stem);
    let key = normalized_chart_key(code);
    metadata
        .get(&(airport.to_string(), key.clone()))
        .or_else(|| {
            metadata
                .iter()
                .filter(|((item_airport, item_key), _)| {
                    item_airport == airport
                        && item_key.len() >= 4
                        && (key.starts_with(item_key) || item_key.starts_with(&key))
                })
                .max_by_key(|((_, item_key), _)| item_key.len())
                .map(|(_, item)| item)
        })
}

fn chart_type_label(chart_type: &str) -> String {
    if chart_type.contains("标准仪表进场图") {
        "标准仪表进场图（STAR）".to_string()
    } else if chart_type.contains("标准仪表离场图") {
        "标准仪表离场图（SID）".to_string()
    } else if chart_type.contains("仪表进近图") || chart_type.contains("进近图_") {
        format!("{chart_type}（IAC）")
    } else {
        chart_type.to_string()
    }
}

fn local_chart(
    id: String,
    airport: String,
    path: &Path,
    metadata: &ChartMetadataIndex,
    fallback_revision: &str,
) -> LocalChart {
    if let Some(item) = metadata_for_pdf(metadata, &airport, path) {
        let document_name = if item.page_number.is_empty() {
            chart_title(path.to_string_lossy().as_ref())
        } else {
            format!("{airport}-{}", item.page_number)
        };
        // 标题优先显示 ChartTypeEx_CH（如「标准仪表进场图」「仪表进近图_ILS」），
        // 其次 ChartName，都没有才退回文件名。
        let title = if !item.chart_type.is_empty() {
            item.chart_type.clone()
        } else if !item.title.is_empty() && !item.title.eq_ignore_ascii_case(&document_name) {
            item.title.clone()
        } else {
            document_name
        };
        // revision 放航图编号（PAGE_NUMBER，如 0C-01），比重复的类型文字更有辨识度。
        let revision = if item.page_number.is_empty() {
            chart_type_label(&item.chart_type)
        } else {
            item.page_number.clone()
        };
        return LocalChart {
            id,
            airport,
            title,
            category: chart_category(&item.chart_type),
            revision: if revision.is_empty() {
                fallback_revision.to_string()
            } else {
                revision
            },
        };
    }
    let title = chart_title(path.to_string_lossy().as_ref());
    LocalChart {
        id,
        airport,
        category: chart_category(&title),
        title,
        revision: fallback_revision.to_string(),
    }
}

fn folder_charts(terminals: &Path) -> Result<Vec<LocalChart>, String> {
    let mut charts = Vec::new();
    let metadata = folder_chart_metadata(terminals)?;
    for airport_entry in fs::read_dir(terminals).map_err(|error| error.to_string())? {
        let airport_entry = airport_entry.map_err(|error| error.to_string())?;
        let Some(airport) = airport_icao(&airport_entry.file_name().to_string_lossy()) else {
            continue;
        };
        if !airport_entry.path().is_dir() {
            continue;
        }
        let mut files = vec![airport_entry.path()];
        while let Some(directory) = files.pop() {
            for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
                let entry = entry.map_err(|error| error.to_string())?;
                let path = entry.path();
                if path.is_dir() {
                    files.push(path);
                    continue;
                }
                if !is_pdf(&path) {
                    continue;
                }
                let relative = path
                    .strip_prefix(terminals)
                    .map_err(|_| "航图路径无效".to_string())?
                    .to_string_lossy()
                    .replace('\\', "/");
                charts.push(local_chart(
                    relative,
                    airport.clone(),
                    &path,
                    &metadata,
                    "本地航图",
                ));
            }
        }
    }
    charts.sort_by(|first, second| {
        first
            .airport
            .cmp(&second.airport)
            .then(first.title.cmp(&second.title))
    });
    Ok(charts)
}

fn zip_chart_parts(name: &str) -> Option<(String, String)> {
    let parts: Vec<&str> = name.split('/').filter(|part| !part.is_empty()).collect();
    let terminal_index = parts.iter().position(|part| {
        part.eq_ignore_ascii_case("terminal") || part.eq_ignore_ascii_case("terminals")
    })?;
    let airport = airport_icao(parts.get(terminal_index + 1)?)?;
    let relative = parts[terminal_index + 1..].join("/");
    Path::new(&relative)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"))
        .then_some((airport, relative))
}

fn zip_charts(path: &Path) -> Result<Vec<LocalChart>, String> {
    let file = File::open(path).map_err(|_| "无法打开 ZIP 航图库".to_string())?;
    let mut archive =
        ZipArchive::new(file).map_err(|_| "所选文件不是有效的 ZIP 航图库".to_string())?;
    let mut metadata = ChartMetadataIndex::new();
    let mut metadata_entries = Vec::new();
    for index in 0..archive.len() {
        let name = archive
            .by_index(index)
            .map_err(|error| error.to_string())?
            .name()
            .replace('\\', "/");
        if name
            .rsplit('/')
            .next()
            .is_some_and(|file_name| file_name.eq_ignore_ascii_case("Charts.csv"))
        {
            metadata_entries.push(index);
        }
    }
    for index in metadata_entries {
        let mut entry = archive.by_index(index).map_err(|error| error.to_string())?;
        // `<ICAO>/Charts.csv` 缺 AirportIcao 列，机场码取倒数第二级目录名。
        let entry_path = entry.name().replace('\\', "/");
        let parts = entry_path
            .split('/')
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>();
        let default_airport = parts.len().checked_sub(2).and_then(|position| parts.get(position).copied());
        let mut bytes = Vec::new();
        entry
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        metadata.extend(chart_metadata_from_bytes(&bytes, default_airport));
    }
    let mut charts = Vec::new();
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(|error| error.to_string())?;
        let name = entry.name().to_string();
        if let Some((airport, relative)) = zip_chart_parts(&name) {
            charts.push(local_chart(
                name,
                airport,
                Path::new(&relative),
                &metadata,
                "本地 ZIP 航图",
            ));
        }
    }
    charts.sort_by(|first, second| {
        first
            .airport
            .cmp(&second.airport)
            .then(first.title.cmp(&second.title))
    });
    Ok(charts)
}

fn library_charts(config: &LocalChartLibraryConfig) -> Result<Vec<LocalChart>, String> {
    match config.source_type {
        LocalChartSourceType::Folder => {
            let root = PathBuf::from(&config.path);
            let terminals = terminal_directory(&root)
                .ok_or_else(|| "所选文件夹中未找到 Terminal 或 Terminals 文件夹".to_string())?;
            folder_charts(&terminals)
        }
        LocalChartSourceType::Zip => zip_charts(Path::new(&config.path)),
    }
}

fn indexed_library_charts(config: &LocalChartLibraryConfig) -> Result<Vec<LocalChart>, String> {
    if let Some(charts) = read_library_index(config) {
        return Ok(charts);
    }
    let charts = library_charts(config)?;
    write_library_index(config, &charts)?;
    Ok(charts)
}

fn status_from_charts(
    config: &LocalChartLibraryConfig,
    charts: &[LocalChart],
) -> LocalChartLibraryStatus {
    let airport_count = charts
        .iter()
        .map(|chart| &chart.airport)
        .collect::<std::collections::HashSet<_>>()
        .len();
    let source_type = match config.source_type {
        LocalChartSourceType::Folder => "folder",
        LocalChartSourceType::Zip => "zip",
    };
    LocalChartLibraryStatus {
        ready: !charts.is_empty(),
        path: Some(config.path.clone()),
        source_type: Some(source_type.to_string()),
        airport_count,
        chart_count: charts.len(),
        message: if charts.is_empty() {
            "未在 Terminal/<ICAO> 或 Terminals/<ICAO> 中找到 PDF 航图".to_string()
        } else {
            format!(
                "已加载 {} 个机场的 {} 份本地航图",
                airport_count,
                charts.len()
            )
        },
    }
}

fn status_from_config(config: &LocalChartLibraryConfig) -> Result<LocalChartLibraryStatus, String> {
    let charts = indexed_library_charts(config)?;
    Ok(status_from_charts(config, &charts))
}

fn cache_name(identifier: &str) -> String {
    let mut hasher = DefaultHasher::new();
    identifier.hash(&mut hasher);
    format!("local-{:x}.pdf", hasher.finish())
}

fn cache_file(app: &AppHandle, source: &Path, identifier: &str) -> Result<String, String> {
    let target = cache_directory(app)?.join(cache_name(identifier));
    if target.is_file()
        && fs::metadata(source)
            .ok()
            .zip(fs::metadata(&target).ok())
            .is_some_and(|(source_meta, target_meta)| source_meta.len() == target_meta.len())
    {
        return Ok(target.to_string_lossy().to_string());
    }
    fs::copy(source, &target).map_err(|error| error.to_string())?;
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
pub fn clear_chart_cache(app: AppHandle) -> Result<(), String> {
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?;
    for name in [
        "chart-cache",
        "chart-thumbnails",
        "chart-images",
        "navigraph-chart-cache",
        "weather-cache",
        "notam-cache",
        "airport-cache",
        "airac-cache",
    ] {
        let directory = root.join(name);
        if directory.exists() {
            fs::remove_dir_all(directory).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn cache_chart_pdf(
    app: AppHandle,
    source_path: String,
    chart_id: String,
) -> Result<String, String> {
    let source = PathBuf::from(source_path);
    if !is_pdf(&source) {
        return Err("请选择 PDF 航图文件".to_string());
    }
    if !source.is_file() {
        return Err("找不到所选航图文件".to_string());
    }
    cache_file(&app, &source, &chart_id)
}

#[tauri::command]
pub fn set_local_chart_library(path: String) -> Result<LocalChartLibraryStatus, String> {
    let selected = PathBuf::from(path.trim());
    let source_type = if selected.is_dir() {
        LocalChartSourceType::Folder
    } else if selected.is_file()
        && selected
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
    {
        LocalChartSourceType::Zip
    } else {
        return Err("请选择航图库文件夹或 ZIP 压缩包".to_string());
    };
    let config = LocalChartLibraryConfig {
        path: selected.to_string_lossy().to_string(),
        source_type,
    };
    let charts = library_charts(&config)?;
    let status = status_from_charts(&config, &charts);
    if !status.ready {
        return Err(status.message);
    }
    write_library_config(&config)?;
    write_library_index(&config, &charts)?;
    Ok(status)
}

#[tauri::command]
pub fn get_local_chart_library_status() -> Result<LocalChartLibraryStatus, String> {
    match read_library_config()? {
        Some(config) => status_from_config(&config),
        None => Ok(LocalChartLibraryStatus {
            ready: false,
            path: None,
            source_type: None,
            airport_count: 0,
            chart_count: 0,
            message: "尚未选择本地航图库".to_string(),
        }),
    }
}

#[tauri::command]
pub fn list_local_charts() -> Result<Vec<LocalChart>, String> {
    match read_library_config()? {
        Some(config) => indexed_library_charts(&config),
        None => Ok(Vec::new()),
    }
}

#[tauri::command]
pub fn open_local_chart(app: AppHandle, chart_id: String) -> Result<String, String> {
    let config = read_library_config()?.ok_or_else(|| "尚未选择本地航图库".to_string())?;
    let charts = indexed_library_charts(&config)?;
    if !charts.iter().any(|chart| chart.id == chart_id) {
        return Err("航图不在当前本地航图库中".to_string());
    }
    match config.source_type {
        LocalChartSourceType::Folder => {
            let terminals = terminal_directory(Path::new(&config.path))
                .ok_or_else(|| "未找到 Terminal 或 Terminals 文件夹".to_string())?
                .canonicalize()
                .map_err(|error| error.to_string())?;
            let source = terminals
                .join(&chart_id)
                .canonicalize()
                .map_err(|_| "找不到所选航图文件".to_string())?;
            if !source.starts_with(&terminals) || !is_pdf(&source) {
                return Err("航图路径无效".to_string());
            }
            cache_file(&app, &source, &chart_id)
        }
        LocalChartSourceType::Zip => {
            let file = File::open(&config.path).map_err(|_| "无法打开 ZIP 航图库".to_string())?;
            let mut archive =
                ZipArchive::new(file).map_err(|_| "所选文件不是有效的 ZIP 航图库".to_string())?;
            let mut entry = archive
                .by_name(&chart_id)
                .map_err(|_| "找不到所选航图文件".to_string())?;
            let target = cache_directory(&app)?.join(cache_name(&chart_id));
            if target.is_file() {
                return Ok(target.to_string_lossy().to_string());
            }
            let mut output = File::create(&target).map_err(|error| error.to_string())?;
            io::copy(&mut entry, &mut output).map_err(|error| error.to_string())?;
            Ok(target.to_string_lossy().to_string())
        }
    }
}

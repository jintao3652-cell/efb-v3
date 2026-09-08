use serde::{Deserialize, Serialize};
use std::{collections::hash_map::DefaultHasher, fs::{self, File}, hash::{Hash, Hasher}, io, path::{Path, PathBuf}};
use zip::ZipArchive;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum LocalChartSourceType {
    Folder,
    Zip,
}

#[derive(Debug, Serialize, Deserialize)]
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalChart {
    pub id: String,
    pub airport: String,
    pub title: String,
    pub category: String,
    pub revision: String,
}

fn app_directory() -> Result<PathBuf, String> {
    let directory = std::env::var("LOCALAPPDATA").map(PathBuf::from).map_err(|_| "无法找到 Windows LocalAppData 目录".to_string())?.join("SkyBoard EFB");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory)
}

fn cache_directory() -> Result<PathBuf, String> {
    let directory = app_directory()?.join("chart-cache");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory)
}

fn library_config_path() -> Result<PathBuf, String> {
    Ok(app_directory()?.join("local-chart-library.json"))
}

fn read_library_config() -> Result<Option<LocalChartLibraryConfig>, String> {
    let path = library_config_path()?;
    if !path.exists() { return Ok(None); }
    serde_json::from_str(&fs::read_to_string(path).map_err(|error| error.to_string())?).map(Some).map_err(|_| "本地航图库配置无效".to_string())
}

fn write_library_config(config: &LocalChartLibraryConfig) -> Result<(), String> {
    fs::write(library_config_path()?, serde_json::to_string(config).map_err(|error| error.to_string())?).map_err(|error| error.to_string())
}

fn terminal_directory(path: &Path) -> Option<PathBuf> {
    if path.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.eq_ignore_ascii_case("terminals")) { Some(path.to_path_buf()) } else {
        let terminals = path.join("Terminals");
        terminals.is_dir().then_some(terminals)
    }
}

fn airport_icao(value: &str) -> Option<String> {
    let value = value.trim().to_uppercase();
    (value.len() == 4 && value.chars().all(|character| character.is_ascii_alphabetic())).then_some(value)
}

fn chart_category(name: &str) -> String {
    let name = name.to_uppercase();
    if name.contains("SID") || name.contains("DEP") { "离场".to_string() } else if name.contains("STAR") || name.contains("ARR") || name.contains("IAC") || name.contains("APP") { "进场".to_string() } else if name.contains("ENR") || name.contains("ROUTE") { "航路".to_string() } else { "机场".to_string() }
}

fn chart_title(path: &str) -> String {
    Path::new(path).file_stem().and_then(|name| name.to_str()).unwrap_or("未命名航图").replace(['_', '-'], " ")
}

fn is_pdf(path: &Path) -> bool {
    path.extension().and_then(|extension| extension.to_str()).is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"))
}

fn folder_charts(terminals: &Path) -> Result<Vec<LocalChart>, String> {
    let mut charts = Vec::new();
    for airport_entry in fs::read_dir(terminals).map_err(|error| error.to_string())? {
        let airport_entry = airport_entry.map_err(|error| error.to_string())?;
        let Some(airport) = airport_icao(&airport_entry.file_name().to_string_lossy()) else { continue; };
        if !airport_entry.path().is_dir() { continue; }
        let mut files = vec![airport_entry.path()];
        while let Some(directory) = files.pop() {
            for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
                let entry = entry.map_err(|error| error.to_string())?;
                let path = entry.path();
                if path.is_dir() { files.push(path); continue; }
                if !is_pdf(&path) { continue; }
                let relative = path.strip_prefix(terminals).map_err(|_| "航图路径无效".to_string())?.to_string_lossy().replace('\\', "/");
                charts.push(LocalChart { id: relative.clone(), airport: airport.clone(), title: chart_title(&relative), category: chart_category(&relative), revision: "本地航图".to_string() });
            }
        }
    }
    charts.sort_by(|first, second| first.airport.cmp(&second.airport).then(first.title.cmp(&second.title)));
    Ok(charts)
}

fn zip_chart_parts(name: &str) -> Option<(String, String)> {
    let parts: Vec<&str> = name.split('/').filter(|part| !part.is_empty()).collect();
    let terminal_index = parts.iter().position(|part| part.eq_ignore_ascii_case("terminals"))?;
    let airport = airport_icao(parts.get(terminal_index + 1)?)?;
    let relative = parts[terminal_index + 1..].join("/");
    Path::new(&relative).extension().and_then(|extension| extension.to_str()).is_some_and(|extension| extension.eq_ignore_ascii_case("pdf")).then_some((airport, relative))
}

fn zip_charts(path: &Path) -> Result<Vec<LocalChart>, String> {
    let file = File::open(path).map_err(|_| "无法打开 ZIP 航图库".to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|_| "所选文件不是有效的 ZIP 航图库".to_string())?;
    let mut charts = Vec::new();
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(|error| error.to_string())?;
        let name = entry.name().to_string();
        if let Some((airport, _)) = zip_chart_parts(&name) {
            charts.push(LocalChart { id: name.clone(), airport, title: chart_title(&name), category: chart_category(&name), revision: "本地 ZIP 航图".to_string() });
        }
    }
    charts.sort_by(|first, second| first.airport.cmp(&second.airport).then(first.title.cmp(&second.title)));
    Ok(charts)
}

fn library_charts(config: &LocalChartLibraryConfig) -> Result<Vec<LocalChart>, String> {
    match config.source_type {
        LocalChartSourceType::Folder => {
            let root = PathBuf::from(&config.path);
            let terminals = terminal_directory(&root).ok_or_else(|| "所选文件夹中未找到 Terminals 文件夹".to_string())?;
            folder_charts(&terminals)
        }
        LocalChartSourceType::Zip => zip_charts(Path::new(&config.path)),
    }
}

fn status_from_config(config: &LocalChartLibraryConfig) -> Result<LocalChartLibraryStatus, String> {
    let charts = library_charts(config)?;
    let airport_count = charts.iter().map(|chart| &chart.airport).collect::<std::collections::HashSet<_>>().len();
    let source_type = match config.source_type { LocalChartSourceType::Folder => "folder", LocalChartSourceType::Zip => "zip" };
    Ok(LocalChartLibraryStatus { ready: !charts.is_empty(), path: Some(config.path.clone()), source_type: Some(source_type.to_string()), airport_count, chart_count: charts.len(), message: if charts.is_empty() { "未在 Terminals/<ICAO> 中找到 PDF 航图".to_string() } else { format!("已加载 {} 个机场的 {} 份本地航图", airport_count, charts.len()) } })
}

fn cache_name(identifier: &str) -> String {
    let mut hasher = DefaultHasher::new();
    identifier.hash(&mut hasher);
    format!("local-{:x}.pdf", hasher.finish())
}

fn cache_file(source: &Path, identifier: &str) -> Result<String, String> {
    let target = cache_directory()?.join(cache_name(identifier));
    fs::copy(source, &target).map_err(|error| error.to_string())?;
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
pub fn clear_chart_cache() -> Result<(), String> {
    let directory = cache_directory()?;
    for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
        let path = entry.map_err(|error| error.to_string())?.path();
        if path.is_file() { fs::remove_file(path).map_err(|error| error.to_string())?; }
    }
    Ok(())
}

#[tauri::command]
pub fn cache_chart_pdf(source_path: String, chart_id: String) -> Result<String, String> {
    let source = PathBuf::from(source_path);
    if !is_pdf(&source) { return Err("请选择 PDF 航图文件".to_string()); }
    if !source.is_file() { return Err("找不到所选航图文件".to_string()); }
    cache_file(&source, &chart_id)
}

#[tauri::command]
pub fn set_local_chart_library(path: String) -> Result<LocalChartLibraryStatus, String> {
    let selected = PathBuf::from(path.trim());
    let source_type = if selected.is_dir() { LocalChartSourceType::Folder } else if selected.is_file() && selected.extension().and_then(|extension| extension.to_str()).is_some_and(|extension| extension.eq_ignore_ascii_case("zip")) { LocalChartSourceType::Zip } else { return Err("请选择航图库文件夹或 ZIP 压缩包".to_string()) };
    let config = LocalChartLibraryConfig { path: selected.to_string_lossy().to_string(), source_type };
    let status = status_from_config(&config)?;
    if !status.ready { return Err(status.message); }
    write_library_config(&config)?;
    Ok(status)
}

#[tauri::command]
pub fn get_local_chart_library_status() -> Result<LocalChartLibraryStatus, String> {
    match read_library_config()? {
        Some(config) => status_from_config(&config),
        None => Ok(LocalChartLibraryStatus { ready: false, path: None, source_type: None, airport_count: 0, chart_count: 0, message: "尚未选择本地航图库".to_string() }),
    }
}

#[tauri::command]
pub fn list_local_charts() -> Result<Vec<LocalChart>, String> {
    match read_library_config()? { Some(config) => library_charts(&config), None => Ok(Vec::new()) }
}

#[tauri::command]
pub fn open_local_chart(chart_id: String) -> Result<String, String> {
    let config = read_library_config()?.ok_or_else(|| "尚未选择本地航图库".to_string())?;
    let charts = library_charts(&config)?;
    if !charts.iter().any(|chart| chart.id == chart_id) { return Err("航图不在当前本地航图库中".to_string()); }
    match config.source_type {
        LocalChartSourceType::Folder => {
            let terminals = terminal_directory(Path::new(&config.path)).ok_or_else(|| "未找到 Terminals 文件夹".to_string())?.canonicalize().map_err(|error| error.to_string())?;
            let source = terminals.join(&chart_id).canonicalize().map_err(|_| "找不到所选航图文件".to_string())?;
            if !source.starts_with(&terminals) || !is_pdf(&source) { return Err("航图路径无效".to_string()); }
            cache_file(&source, &chart_id)
        }
        LocalChartSourceType::Zip => {
            let file = File::open(&config.path).map_err(|_| "无法打开 ZIP 航图库".to_string())?;
            let mut archive = ZipArchive::new(file).map_err(|_| "所选文件不是有效的 ZIP 航图库".to_string())?;
            let mut entry = archive.by_name(&chart_id).map_err(|_| "找不到所选航图文件".to_string())?;
            let target = cache_directory()?.join(cache_name(&chart_id));
            let mut output = File::create(&target).map_err(|error| error.to_string())?;
            io::copy(&mut entry, &mut output).map_err(|error| error.to_string())?;
            Ok(target.to_string_lossy().to_string())
        }
    }
}

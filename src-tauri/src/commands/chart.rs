use std::{fs, path::PathBuf};

fn cache_directory() -> Result<PathBuf, String> {
    let directory = std::env::var("LOCALAPPDATA").map(PathBuf::from).map_err(|_| "无法找到 Windows LocalAppData 目录".to_string())?.join("SkyBoard EFB").join("chart-cache");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory)
}

#[tauri::command]
pub fn clear_chart_cache() -> Result<(), String> {
    let directory = cache_directory()?;
    for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
        let path = entry.map_err(|error| error.to_string())?.path();
        if path.is_file() {
            fs::remove_file(path).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn cache_chart_pdf(source_path: String, chart_id: String) -> Result<String, String> {
    let source = PathBuf::from(source_path);
    if source.extension().and_then(|extension| extension.to_str()).map(|extension| extension.eq_ignore_ascii_case("pdf")) != Some(true) {
        return Err("请选择 PDF 航图文件".to_string());
    }
    if !source.is_file() {
        return Err("找不到所选航图文件".to_string());
    }
    let safe_id: String = chart_id.chars().filter(|character| character.is_ascii_alphanumeric() || *character == '-' || *character == '_').collect();
    if safe_id.is_empty() {
        return Err("无效的航图标识".to_string());
    }
    let target = cache_directory()?.join(format!("{safe_id}.pdf"));
    fs::copy(source, &target).map_err(|error| error.to_string())?;
    Ok(target.to_string_lossy().to_string())
}

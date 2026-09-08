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

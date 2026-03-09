use sha2::{Digest, Sha256};
use std::path::PathBuf;

pub fn cache_dir() -> Result<PathBuf, String> {
    let appdata = std::env::var("APPDATA").map_err(|_| "%APPDATA% not set".to_string())?;
    Ok(PathBuf::from(appdata).join("gsp-scraper").join("cache"))
}

pub fn cache_path(url: &str) -> Result<PathBuf, String> {
    let mut h = Sha256::new();
    h.update(url.as_bytes());
    let hash: String = h.finalize().iter().map(|b| format!("{:02x}", b)).collect();

    // Strip query string before extracting extension
    let path_part = url.split('?').next().unwrap_or(url);
    let ext = path_part
        .rsplit('/')
        .next()
        .and_then(|seg| seg.rsplit_once('.'))
        .map(|(_, e)| e.to_ascii_lowercase())
        .filter(|e| matches!(e.as_str(), "png" | "jpg" | "jpeg" | "webp" | "gif"))
        .map(|e| format!(".{e}"))
        .unwrap_or_default();

    Ok(cache_dir()?.join(format!("{}{}", hash, ext)))
}

pub fn ensure_cache_dir() -> Result<(), String> {
    std::fs::create_dir_all(cache_dir()?)
        .map_err(|e| format!("Failed to create cache dir: {e}"))
}

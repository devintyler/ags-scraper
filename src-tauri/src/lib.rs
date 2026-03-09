#[cfg(not(target_os = "windows"))]
compile_error!(
    "gsp-scraper targets Windows only. \
     Building on other platforms is not supported. \
     See README for details."
);

mod cache;
mod commands;
mod config;
mod steamgriddb;

use commands::{clear_cache, download_and_cache, fetch_sgdb_images, load_config_cmd, save_config_cmd, search_game};

/// Shared HTTP client held in Tauri state so all commands reuse the connection pool.
pub struct AppClient(pub reqwest::Client);

pub fn run() {
    let http_client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .expect("Failed to build HTTP client");

    tauri::Builder::default()
        .manage(AppClient(http_client))
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            load_config_cmd,
            save_config_cmd,
            search_game,
            fetch_sgdb_images,
            download_and_cache,
            clear_cache,
        ])
        .run(tauri::generate_context!())
        .expect(
            "Failed to start application. \
             Ensure WebView2 Runtime is installed: \
             https://developer.microsoft.com/en-us/microsoft-edge/webview2/",
        );
}

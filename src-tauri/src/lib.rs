#[cfg(not(target_os = "windows"))]
compile_error!(
    "agsp-scraper targets Windows only. \
     Building on other platforms is not supported. \
     See README for details."
);

mod cache;
mod commands;
mod config;
mod image_processing;
mod screenscraper;
mod steamgriddb;

use commands::{
    auto_detect_rom_system, cleanup_temp_dir, clear_cache, clear_credentials, download_and_cache,
    export_images, fetch_sgdb_images, fetch_ss_images, get_cache_size, get_ss_user_quota,
    load_config_cmd, process_image, save_config_cmd, scan_rom_directory,
    scrape_and_export_single_game, search_game,
};

/// Shared HTTP client held in Tauri state so all commands reuse the connection pool.
pub struct AppClient(pub reqwest::Client);

pub fn run() {
    image_processing::cleanup_temp_dir();

    let http_client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .expect("Failed to build HTTP client");

    tauri::Builder::default()
        .manage(AppClient(http_client))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            load_config_cmd,
            save_config_cmd,
            clear_credentials,
            search_game,
            fetch_sgdb_images,
            fetch_ss_images,
            download_and_cache,
            get_cache_size,
            clear_cache,
            process_image,
            cleanup_temp_dir,
            export_images,
            auto_detect_rom_system,
            scan_rom_directory,
            scrape_and_export_single_game,
            get_ss_user_quota,
        ])
        .build(tauri::generate_context!())
        .expect(
            "Failed to start application. \
             Ensure WebView2 Runtime is installed: \
             https://developer.microsoft.com/en-us/microsoft-edge/webview2/",
        )
        .run(|_app, event| {
            if let tauri::RunEvent::Exit = event {
                image_processing::cleanup_temp_dir();
            }
        });
}

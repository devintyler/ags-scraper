#[cfg(not(target_os = "windows"))]
compile_error!(
    "gsp-scraper targets Windows only. \
     Building on other platforms is not supported. \
     See README for details."
);

mod commands;
mod config;

use commands::{load_config_cmd, save_config_cmd};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![load_config_cmd, save_config_cmd])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

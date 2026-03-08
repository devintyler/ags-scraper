use crate::config;
use secrecy::{ExposeSecret, SecretString};
use serde::Serialize;

#[derive(Serialize)]
pub struct ConfigView {
    pub screenscraper_user: String,
    /// True if a password is stored; the plaintext is never sent to the frontend.
    pub screenscraper_pass_set: bool,
    /// True if an API key is stored; the plaintext is never sent to the frontend.
    pub steamgriddb_key_set: bool,
}

#[tauri::command]
pub fn load_config_cmd() -> Result<ConfigView, String> {
    let cfg = config::load_config()?;
    Ok(ConfigView {
        screenscraper_user: cfg.screenscraper.username,
        screenscraper_pass_set: !cfg.screenscraper.password_enc.is_empty(),
        steamgriddb_key_set: !cfg.steamgriddb.api_key_enc.is_empty(),
    })
}

#[tauri::command]
pub fn save_config_cmd(
    screenscraper_user: String,
    screenscraper_pass: String,
    steamgriddb_key: String,
) -> Result<(), String> {
    // Wrap immediately so the plaintext bytes are zeroed when these drop.
    let pass_secret = SecretString::new(screenscraper_pass);
    let key_secret = SecretString::new(steamgriddb_key);

    // Load existing config to preserve last_output_dir and any credential blobs
    // the user left blank (empty field = keep existing, not clear).
    let existing = config::load_config().unwrap_or_default();

    let pass_enc = if pass_secret.expose_secret().is_empty() {
        existing.screenscraper.password_enc
    } else {
        config::encrypt(pass_secret.expose_secret())?
    };

    let key_enc = if key_secret.expose_secret().is_empty() {
        existing.steamgriddb.api_key_enc
    } else {
        config::encrypt(key_secret.expose_secret())?
    };

    config::save_config(&config::Config {
        screenscraper: config::ScreenScraperConfig {
            username: screenscraper_user,
            password_enc: pass_enc,
        },
        steamgriddb: config::SteamGridDbConfig {
            api_key_enc: key_enc,
        },
        ui: existing.ui,
    })
}

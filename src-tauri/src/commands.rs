use crate::config;
use crate::AppClient;
use secrecy::{ExposeSecret, SecretString};
use serde::Serialize;

#[derive(Serialize, Clone)]
pub struct ImageCandidate {
    pub url: String,
    pub source: String,
}

#[derive(serde::Deserialize, Serialize, Clone)]
pub struct GameCandidate {
    pub id: u64,
    pub name: String,
}

#[derive(Serialize, Clone)]
pub struct SsGameCandidate {
    pub id: String,
    pub name: String,
    pub system_id: String,
    pub system_name: String,
}

#[derive(Serialize)]
pub struct SearchResults {
    pub boxart: Vec<ImageCandidate>,
    pub screenshot: Vec<ImageCandidate>,
    pub title: Vec<ImageCandidate>,
    pub menu: Vec<ImageCandidate>,
    pub matched_game: Option<GameCandidate>,
    pub game_candidates: Vec<GameCandidate>, // SGDB alternative game matches
    pub ss_candidates: Vec<SsGameCandidate>, // SS alternative game matches
}

#[derive(Serialize)]
pub struct ClearCacheResult {
    pub files_deleted: u64,
    pub bytes_freed: u64,
}

#[derive(Serialize)]
pub struct ConfigView {
    pub screenscraper_user: String,
    /// True if a password is stored; the plaintext is never sent to the frontend.
    pub screenscraper_pass_set: bool,
    /// True if an API key is stored; the plaintext is never sent to the frontend.
    pub steamgriddb_key_set: bool,
}

/// Loads config from disk and decrypts the SteamGridDB API key.
/// Uses spawn_blocking to avoid blocking the async executor with file I/O and DPAPI calls.
async fn load_sgdb_api_key() -> Result<SecretString, String> {
    let cfg = tokio::task::spawn_blocking(config::load_config)
        .await
        .map_err(|e| e.to_string())??;
    if cfg.steamgriddb.api_key_enc.is_empty() {
        return Err("SteamGridDB API key not configured".to_string());
    }
    config::decrypt(&cfg.steamgriddb.api_key_enc)
}

/// Loads config from disk and decrypts ScreenScraper credentials.
async fn load_ss_credentials() -> Result<(String, SecretString), String> {
    let cfg = tokio::task::spawn_blocking(config::load_config)
        .await
        .map_err(|e| e.to_string())??;
    if cfg.screenscraper.username.is_empty() || cfg.screenscraper.password_enc.is_empty() {
        return Err("ScreenScraper credentials not configured".to_string());
    }
    let pass = config::decrypt(&cfg.screenscraper.password_enc)?;
    Ok((cfg.screenscraper.username, pass))
}

// load_config_cmd and save_config_cmd use spawn_blocking to avoid holding the
// async executor during file I/O and DPAPI calls (settings page open/save).

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
pub async fn save_config_cmd(
    screenscraper_user: String,
    screenscraper_pass: String,
    steamgriddb_key: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
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
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn search_game(
    http: tauri::State<'_, AppClient>,
    rom_path: String,
    rom_filename: String,
    search_term: String,
    system_id: Option<u32>,
    source: String,
) -> Result<SearchResults, String> {
    let client = &http.0;

    match source.as_str() {
        "ScreenScraper" => search_game_ss(client, &rom_path, &rom_filename, system_id, &search_term).await,
        _               => search_game_sgdb(client, &search_term).await,
    }
}

async fn search_game_ss(
    client: &reqwest::Client,
    rom_path: &str,
    rom_filename: &str,
    system_id: Option<u32>,
    search_term: &str,
) -> Result<SearchResults, String> {
    let (ss_user, ss_pass_secret) = load_ss_credentials().await?;
    let ss_pass = ss_pass_secret.expose_secret().to_owned();

    // Step 1: try exact hash lookup via jeuInfos when system ID is known.
    if let Some(sid) = system_id {
        if !rom_path.is_empty() {
            match crate::screenscraper::lookup_by_hash(
                client, rom_path, rom_filename, sid, &ss_user, &ss_pass,
            ).await {
                Ok(Some(ss)) => {
                    #[cfg(debug_assertions)]
                    eprintln!("[SS] hash lookup succeeded");
                    return Ok(SearchResults {
                        boxart: ss.boxart,
                        screenshot: ss.screenshot,
                        title: ss.title,
                        menu: ss.menu,
                        matched_game: ss.matched_name.map(|n| GameCandidate { id: 0, name: n }),
                        game_candidates: vec![],
                        ss_candidates: ss.candidates,
                    });
                }
                Ok(None) => { #[cfg(debug_assertions)] eprintln!("[SS] hash lookup: no match, falling through to jeuRecherche"); }
                Err(e)   => { #[cfg(debug_assertions)] eprintln!("[SS] hash lookup error (falling through): {e}"); }
            }
        }
    }

    // Step 2: fall back to text search (jeuRecherche).
    let ss = crate::screenscraper::search_game(client, search_term, system_id, &ss_user, &ss_pass).await?;
    Ok(SearchResults {
        boxart: ss.boxart,
        screenshot: ss.screenshot,
        title: ss.title,
        menu: ss.menu,
        matched_game: ss.matched_name.map(|n| GameCandidate { id: 0, name: n }),
        game_candidates: vec![],
        ss_candidates: ss.candidates,
    })
}

async fn search_game_sgdb(
    client: &reqwest::Client,
    search_term: &str,
) -> Result<SearchResults, String> {
    let api_key_secret = load_sgdb_api_key().await?;
    let api_key = api_key_secret.expose_secret();

    let games = crate::steamgriddb::search_game(client, search_term, api_key).await?;
    if games.is_empty() {
        return Ok(SearchResults {
            boxart: vec![],
            screenshot: vec![],
            title: vec![],
            menu: vec![],
            matched_game: None,
            game_candidates: vec![],
            ss_candidates: vec![],
        });
    }

    let all_candidates: Vec<GameCandidate> = games
        .iter()
        .map(|g| GameCandidate { id: g.id, name: g.name.clone() })
        .collect();

    // Try up to the first 3 candidates; use the first one that has images.
    let mut matched: Option<GameCandidate> = None;
    let mut grids: Vec<ImageCandidate> = vec![];
    let mut logos: Vec<ImageCandidate> = vec![];

    for game in games.iter().take(3) {
        let (g, l) = tokio::join!(
            crate::steamgriddb::fetch_grids(client, game.id, api_key),
            crate::steamgriddb::fetch_logos(client, game.id, api_key),
        );
        let g = g?;
        let l = l?;
        if !g.is_empty() || !l.is_empty() {
            matched = Some(GameCandidate { id: game.id, name: game.name.clone() });
            grids = g;
            logos = l;
            break;
        }
    }

    let game_candidates: Vec<GameCandidate> = all_candidates
        .into_iter()
        .filter(|c| matched.as_ref().map_or(true, |m| c.id != m.id))
        .collect();

    Ok(SearchResults {
        boxart: grids.clone(),
        screenshot: vec![],
        title: logos,
        menu: grids,
        matched_game: matched,
        game_candidates,
        ss_candidates: vec![],
    })
}

#[tauri::command]
pub async fn download_and_cache(
    http: tauri::State<'_, AppClient>,
    url: String,
) -> Result<String, String> {
    let path = crate::cache::cache_path(&url)?;
    if path.exists() {
        return Ok(path.to_string_lossy().into_owned());
    }
    crate::cache::ensure_cache_dir()?;
    let bytes = http
        .0
        .get(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .bytes()
        .await
        .map_err(|e| e.to_string())?;
    // A concurrent request may have written the file while we were downloading;
    // overwriting with identical bytes is safe, but skip the write if possible.
    if !path.exists() {
        tokio::fs::write(&path, &bytes)
            .await
            .map_err(|e| format!("Failed to write cache: {e}"))?;
    }
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn clear_cache() -> Result<ClearCacheResult, String> {
    let dir = crate::cache::cache_dir()?;
    if !dir.exists() {
        return Ok(ClearCacheResult { files_deleted: 0, bytes_freed: 0 });
    }
    let mut files_deleted = 0u64;
    let mut bytes_freed = 0u64;
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        if let Ok(meta) = entry.metadata() {
            if meta.is_file() && std::fs::remove_file(entry.path()).is_ok() {
                files_deleted += 1;
                bytes_freed += meta.len();
            }
        }
    }
    Ok(ClearCacheResult { files_deleted, bytes_freed })
}

#[tauri::command]
pub async fn process_image(
    cache_path: String,
    image_type: crate::image_processing::ImageType,
    crop_preset: Option<crate::image_processing::CropPreset>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        crate::image_processing::process_image(&cache_path, image_type, crop_preset)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn cleanup_temp_dir() {
    crate::image_processing::cleanup_temp_dir();
}

#[derive(serde::Deserialize)]
pub struct ExportSelections {
    boxart:     Option<String>,
    screenshot: Option<String>,
    title:      Option<String>,
    menu:       Option<String>,
}

struct ExportEntry {
    image_type: &'static str,
    src:        Option<String>,
    dest:       std::path::PathBuf,
}

#[derive(Serialize)]
pub struct ExportFileResult {
    pub image_type: String,
    pub dest_path:  String,
    pub success:    bool,
    pub error:      Option<String>,
}

#[derive(Serialize)]
pub struct ExportReport {
    pub results:   Vec<ExportFileResult>,
    pub conflicts: Vec<String>,
}

/// Two-phase export: call once with `overwrite: false` to detect conflicts (returns
/// `ExportReport { results: [], conflicts }` with no writes), then call again with
/// `overwrite: true` to perform the actual copy (returns `ExportReport { results, conflicts: [] }`).
#[tauri::command]
pub async fn export_images(
    selections: ExportSelections,
    rom_name: String,
    output_dir: String,
    overwrite: bool,
) -> Result<ExportReport, String> {
    let out = std::path::Path::new(&output_dir);
    if !out.is_dir() {
        return Err(format!("Output directory does not exist: {output_dir}"));
    }

    // Strip characters that could make the name escape the output directory.
    let safe_name: String = rom_name
        .chars()
        .filter(|c| !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        .collect();
    let safe_name = safe_name.trim_matches('.');
    if safe_name.is_empty() {
        return Err("ROM name is empty or invalid".to_string());
    }

    let entries = vec![
        ExportEntry { image_type: "boxart",     src: selections.boxart,     dest: out.join(format!("{safe_name}.png"))       },
        ExportEntry { image_type: "screenshot", src: selections.screenshot, dest: out.join(format!("{safe_name}.jpg"))       },
        ExportEntry { image_type: "title",      src: selections.title,      dest: out.join(format!("{safe_name}_title.png")) },
        ExportEntry { image_type: "menu",       src: selections.menu,       dest: out.join(format!("{safe_name}_menu.png"))  },
    ];

    if !overwrite {
        let conflicts: Vec<String> = entries.iter()
            .filter(|e| e.src.is_some() && e.dest.exists())
            .map(|e| e.dest.to_string_lossy().into_owned())
            .collect();
        return Ok(ExportReport { results: vec![], conflicts });
    }

    let mut results = Vec::new();
    for entry in &entries {
        let Some(src) = &entry.src else { continue };
        let dest_path = entry.dest.to_string_lossy().into_owned();
        match tokio::fs::copy(src, &entry.dest).await {
            Ok(bytes_written) => {
                results.push(ExportFileResult {
                    image_type: entry.image_type.to_string(),
                    dest_path,
                    success: bytes_written > 0,
                    error: if bytes_written > 0 { None } else { Some("Written file is empty".to_string()) },
                });
            }
            Err(e) => {
                results.push(ExportFileResult {
                    image_type: entry.image_type.to_string(),
                    dest_path,
                    success: false,
                    error: Some(e.to_string()),
                });
            }
        }
    }

    Ok(ExportReport { results, conflicts: vec![] })
}

#[tauri::command]
pub async fn fetch_sgdb_images(
    http: tauri::State<'_, AppClient>,
    game_id: u64,
    game_name: String,
) -> Result<SearchResults, String> {
    let api_key_secret = load_sgdb_api_key().await?;
    let api_key = api_key_secret.expose_secret();
    let client = &http.0;

    let (grids, logos) = tokio::join!(
        crate::steamgriddb::fetch_grids(client, game_id, api_key),
        crate::steamgriddb::fetch_logos(client, game_id, api_key),
    );
    let grids = grids?;
    let logos = logos?;

    Ok(SearchResults {
        boxart: grids.clone(),
        screenshot: vec![],
        title: logos,
        menu: grids,
        matched_game: Some(GameCandidate { id: game_id, name: game_name }),
        game_candidates: vec![], // frontend manages the full game list
        ss_candidates: vec![],
    })
}

#[tauri::command]
pub async fn fetch_ss_images(
    http: tauri::State<'_, AppClient>,
    game_id: String,
) -> Result<SearchResults, String> {
    let (ss_user, ss_pass_secret) = load_ss_credentials().await?;
    let ss_pass = ss_pass_secret.expose_secret().to_owned();
    let client = &http.0;

    let ss = crate::screenscraper::fetch_by_game_id(client, &game_id, &ss_user, &ss_pass).await?;
    Ok(SearchResults {
        boxart: ss.boxart,
        screenshot: ss.screenshot,
        title: ss.title,
        menu: ss.menu,
        matched_game: ss.matched_name.map(|n| GameCandidate { id: 0, name: n }),
        game_candidates: vec![],
        ss_candidates: vec![],
    })
}

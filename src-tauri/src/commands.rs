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
pub async fn load_config_cmd() -> Result<ConfigView, String> {
    let cfg = tokio::task::spawn_blocking(config::load_config)
        .await
        .map_err(|e| e.to_string())??;
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

        // Load existing config to preserve any credential blobs
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
        "ScreenScraper" => {
            search_game_ss(client, &rom_path, &rom_filename, system_id, &search_term).await
        }
        _ => search_game_sgdb(client, &search_term).await,
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
                client,
                rom_path,
                rom_filename,
                sid,
                &ss_user,
                &ss_pass,
            )
            .await
            {
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
                Ok(None) => {
                    #[cfg(debug_assertions)]
                    eprintln!("[SS] hash lookup: no match, falling through to jeuRecherche");
                }
                Err(e) => {
                    if e.contains("RATE_LIMIT")
                        || e.contains("DAILY_QUOTA_REACHED")
                        || e.contains("login failed")
                    {
                        return Err(e);
                    }
                    #[cfg(debug_assertions)]
                    eprintln!("[SS] hash lookup error (falling through): {e}");
                }
            }
        }
    }

    // Step 2: fall back to text search (jeuRecherche).
    let ss = crate::screenscraper::search_game(client, search_term, system_id, &ss_user, &ss_pass)
        .await?;
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
        .map(|g| GameCandidate {
            id: g.id,
            name: g.name.clone(),
        })
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
            matched = Some(GameCandidate {
                id: game.id,
                name: game.name.clone(),
            });
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

/// Validates that a URL is HTTPS and targets one of the two permitted image hosts.
/// Prevents the frontend from directing the app to make requests to arbitrary hosts.
fn validate_image_url(url: &str) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("Only HTTPS image URLs are allowed".to_string());
    }
    let after_scheme = &url["https://".len()..];
    let host_end = after_scheme
        .find(|c: char| c == '/' || c == '?' || c == '#')
        .unwrap_or(after_scheme.len());
    let host = after_scheme[..host_end].split(':').next().unwrap_or("");
    let allowed = ["screenscraper.fr", "steamgriddb.com"];
    if !allowed
        .iter()
        .any(|&d| host == d || host.ends_with(&format!(".{d}")))
    {
        return Err(format!("Image host '{host}' is not permitted"));
    }
    Ok(())
}

pub async fn download_and_cache_internal(
    client: &reqwest::Client,
    url: &str,
) -> Result<String, String> {
    validate_image_url(url)?;
    let path = crate::cache::cache_path(url)?;
    if path.exists() {
        return Ok(path.to_string_lossy().into_owned());
    }
    crate::cache::ensure_cache_dir()?;
    let bytes = client
        .get(url)
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
pub async fn download_and_cache(
    http: tauri::State<'_, AppClient>,
    url: String,
) -> Result<String, String> {
    download_and_cache_internal(&http.0, &url).await
}

#[tauri::command]
pub fn clear_credentials(target: String) -> Result<(), String> {
    let mut cfg = config::load_config().unwrap_or_default();
    match target.as_str() {
        "screenscraper" => {
            cfg.screenscraper.username = String::new();
            cfg.screenscraper.password_enc = String::new();
        }
        "steamgriddb" => {
            cfg.steamgriddb.api_key_enc = String::new();
        }
        _ => return Err(format!("Unknown credential target: {target}")),
    }
    config::save_config(&cfg)
}

#[tauri::command]
pub fn get_cache_size() -> Result<u64, String> {
    crate::cache::get_cache_size()
}

#[tauri::command]
pub fn clear_cache() -> Result<ClearCacheResult, String> {
    let dir = crate::cache::cache_dir()?;
    if !dir.exists() {
        return Ok(ClearCacheResult {
            files_deleted: 0,
            bytes_freed: 0,
        });
    }
    let mut files_deleted = 0u64;
    let mut bytes_freed = 0u64;
    for entry in std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .flatten()
    {
        if let Ok(meta) = entry.metadata() {
            if meta.is_file() && std::fs::remove_file(entry.path()).is_ok() {
                files_deleted += 1;
                bytes_freed += meta.len();
            }
        }
    }
    Ok(ClearCacheResult {
        files_deleted,
        bytes_freed,
    })
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
    boxart: Option<String>,
    screenshot: Option<String>,
    title: Option<String>,
    menu: Option<String>,
}

struct ExportEntry {
    image_type: &'static str,
    src: Option<String>,
    dest: std::path::PathBuf,
}

#[derive(Serialize)]
pub struct ExportFileResult {
    pub image_type: String,
    pub dest_path: String,
    pub success: bool,
    pub error: Option<String>,
}

#[derive(Serialize)]
pub struct ExportReport {
    pub results: Vec<ExportFileResult>,
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

    // Windows reserved device names (e.g. CON, NUL, COM1) silently redirect to
    // OS devices instead of creating files, so reject them explicitly.
    const WINDOWS_RESERVED: &[&str] = &[
        "CON", "PRN", "AUX", "NUL", "COM0", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
        "COM8", "COM9", "LPT0", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8",
        "LPT9",
    ];
    if WINDOWS_RESERVED
        .iter()
        .any(|&r| safe_name.eq_ignore_ascii_case(r))
    {
        return Err(format!("'{safe_name}' is a reserved Windows device name"));
    }

    let entries = vec![
        ExportEntry {
            image_type: "boxart",
            src: selections.boxart,
            dest: out.join(format!("{safe_name}.png")),
        },
        ExportEntry {
            image_type: "screenshot",
            src: selections.screenshot,
            dest: out.join(format!("{safe_name}.jpg")),
        },
        ExportEntry {
            image_type: "title",
            src: selections.title,
            dest: out.join(format!("{safe_name}_title.png")),
        },
        ExportEntry {
            image_type: "menu",
            src: selections.menu,
            dest: out.join(format!("{safe_name}_menu.png")),
        },
    ];

    if !overwrite {
        let conflicts: Vec<String> = entries
            .iter()
            .filter(|e| e.src.is_some() && e.dest.exists())
            .map(|e| e.dest.to_string_lossy().into_owned())
            .collect();
        return Ok(ExportReport {
            results: vec![],
            conflicts,
        });
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
                    error: if bytes_written > 0 {
                        None
                    } else {
                        Some("Written file is empty".to_string())
                    },
                });
            }
            Err(e) => {
                let msg = match e.kind() {
                    std::io::ErrorKind::PermissionDenied => {
                        "Permission denied — check directory is not read-only".to_string()
                    }
                    std::io::ErrorKind::StorageFull => {
                        "Disk is full — free up space and try again".to_string()
                    }
                    _ => e.to_string(),
                };
                results.push(ExportFileResult {
                    image_type: entry.image_type.to_string(),
                    dest_path,
                    success: false,
                    error: Some(msg),
                });
            }
        }
    }

    Ok(ExportReport {
        results,
        conflicts: vec![],
    })
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
        matched_game: Some(GameCandidate {
            id: game_id,
            name: game_name,
        }),
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

#[tauri::command]
pub async fn get_ss_user_quota(
    http: tauri::State<'_, AppClient>,
) -> Result<crate::screenscraper::SsUserQuota, String> {
    let (ss_user, ss_pass_secret) = load_ss_credentials().await?;
    let ss_pass = ss_pass_secret.expose_secret();
    crate::screenscraper::get_user_quota(&http.0, &ss_user, ss_pass).await
}

// ── Bulk & Auto-Detection Utilities ──────────────────────────────

/// Strips region and dump tags like `(USA)`, `[!]`, etc. and handles trailing `, The`
/// to optimize match rates on ScreenScraper and SteamGridDB.
pub fn clean_title(title: &str) -> String {
    let mut cleaned = String::new();
    let mut in_paren = 0;
    let mut in_bracket = 0;
    for c in title.chars() {
        match c {
            '(' => in_paren += 1,
            ')' => {
                if in_paren > 0 {
                    in_paren -= 1;
                }
            }
            '[' => in_bracket += 1,
            ']' => {
                if in_bracket > 0 {
                    in_bracket -= 1;
                }
            }
            _ if in_paren == 0 && in_bracket == 0 => cleaned.push(c),
            _ => {}
        }
    }
    let trimmed = cleaned.trim();
    let normalized = if let Some(prefix) = trimmed.strip_suffix(", The") {
        format!("The {}", prefix.trim())
    } else if let Some(prefix) = trimmed.strip_suffix(", A") {
        format!("A {}", prefix.trim())
    } else {
        trimmed.to_string()
    };

    if normalized.is_empty() {
        title.to_string()
    } else {
        normalized
    }
}

/// Returns true if `ext` is a known ROM file extension supported by AGSP consoles.
pub fn is_rom_extension(ext: &str) -> bool {
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "a26"
            | "a52"
            | "a78"
            | "nes"
            | "sfc"
            | "smc"
            | "fig"
            | "swc"
            | "bin"
            | "md"
            | "gen"
            | "smd"
            | "sms"
            | "gg"
            | "gb"
            | "gbc"
            | "gba"
            | "pce"
            | "sgx"
            | "zip"
            | "7z"
            | "rom"
            | "cue"
            | "iso"
            | "chd"
            | "lnx"
    )
}

/// Auto-detects ScreenScraper system ID and name based on file extension and folder context.
/// Unambiguous extensions are checked first, followed by folder names under the scan root.
pub fn detect_system_from_path(path: &std::path::Path) -> Option<(u32, &'static str)> {
    detect_system_from_path_with_root(path, None)
}

fn contains_token(text: &str, token: &str) -> bool {
    text.split(|c: char| !c.is_alphanumeric())
        .any(|part| part.eq_ignore_ascii_case(token))
}

pub fn detect_system_from_path_with_root(
    path: &std::path::Path,
    scan_root: Option<&std::path::Path>,
) -> Option<(u32, &'static str)> {
    // 1. Check unambiguous extensions first
    if let Some(ext) = path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
    {
        match ext.as_str() {
            "a26" => return Some((26, "Atari 2600")),
            "a52" => return Some((40, "Atari 5200")),
            "a78" => return Some((41, "Atari 7800")),
            "nes" => return Some((3, "NES")),
            "sfc" | "smc" | "fig" | "swc" => return Some((4, "Super Nintendo")),
            "sms" => return Some((2, "Sega Master System")),
            "gg" => return Some((21, "Game Gear")),
            "gb" => return Some((9, "Game Boy")),
            "gbc" => return Some((10, "Game Boy Color")),
            "gba" => return Some((12, "Game Boy Advance")),
            "pce" | "sgx" => return Some((31, "PC Engine")),
            "lnx" => return Some((28, "Atari Lynx")),
            _ => {}
        }
    }

    // 2. Check folder context (only check folder components under scan_root, or immediate parent)
    let folder_context: String = if let Some(root) = scan_root {
        path.parent()
            .and_then(|p| p.strip_prefix(root).ok())
            .map(|p| p.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default()
    } else {
        path.parent()
            .and_then(|p| p.file_name())
            .map(|f| f.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default()
    };

    if !folder_context.is_empty() {
        // Super Nintendo / Super Famicom MUST be checked before NES / Famicom
        if folder_context.contains("super nintendo")
            || folder_context.contains("supernintendo")
            || folder_context.contains("super famicom")
            || folder_context.contains("superfamicom")
            || folder_context.contains("super nes")
            || folder_context.contains("supernes")
            || contains_token(&folder_context, "snes")
            || contains_token(&folder_context, "sfc")
        {
            return Some((4, "Super Nintendo"));
        }
        if folder_context.contains("nes nintendo")
            || folder_context.contains("nesnintendo")
            || folder_context.contains("famicom")
            || contains_token(&folder_context, "nes")
        {
            return Some((3, "NES"));
        }

        // GBA / GBC before GB
        if folder_context.contains("game boy advance")
            || folder_context.contains("gameboy advance")
            || folder_context.contains("gameboyadvance")
            || contains_token(&folder_context, "gba")
        {
            return Some((12, "Game Boy Advance"));
        }
        if folder_context.contains("game boy color")
            || folder_context.contains("gameboy color")
            || folder_context.contains("gameboycolor")
            || contains_token(&folder_context, "gbc")
        {
            return Some((10, "Game Boy Color"));
        }
        if folder_context.contains("game boy")
            || folder_context.contains("gameboy")
            || contains_token(&folder_context, "gb")
        {
            return Some((9, "Game Boy"));
        }

        if folder_context.contains("game gear")
            || folder_context.contains("gamegear")
            || contains_token(&folder_context, "gg")
        {
            return Some((21, "Game Gear"));
        }

        // Atari models
        if folder_context.contains("7800") {
            return Some((41, "Atari 7800"));
        }
        if folder_context.contains("5200") {
            return Some((40, "Atari 5200"));
        }
        if folder_context.contains("2600") {
            return Some((26, "Atari 2600"));
        }

        // Sega consoles: Master System before Genesis
        if folder_context.contains("master system")
            || folder_context.contains("mastersystem")
            || contains_token(&folder_context, "sms")
        {
            return Some((2, "Sega Master System"));
        }
        if folder_context.contains("genesis")
            || folder_context.contains("mega drive")
            || folder_context.contains("megadrive")
            || contains_token(&folder_context, "smd")
            || contains_token(&folder_context, "md")
            || contains_token(&folder_context, "gen")
        {
            return Some((1, "Sega Genesis"));
        }

        if folder_context.contains("pc engine")
            || folder_context.contains("pcengine")
            || folder_context.contains("turbografx")
            || contains_token(&folder_context, "pce")
            || contains_token(&folder_context, "tg16")
        {
            return Some((31, "PC Engine"));
        }

        if folder_context.contains("arcade") || folder_context.contains("mame") {
            return Some((75, "MAME (Arcade)"));
        }

        if folder_context.contains("lynx") {
            return Some((28, "Atari Lynx"));
        }
    }

    // 3. Fallback for extensions that suggest a platform
    if let Some(ext) = path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
    {
        match ext.as_str() {
            "gen" | "smd" => Some((1, "Sega Genesis")),
            "pce" | "sgx" => Some((31, "PC Engine")),
            _ => None,
        }
    } else {
        None
    }
}

#[tauri::command]
pub fn auto_detect_rom_system(path: String) -> Option<u32> {
    detect_system_from_path(std::path::Path::new(&path)).map(|(id, _)| id)
}

fn sanitize_rom_stem(rom_name: &str) -> Result<String, String> {
    let safe_name: String = rom_name
        .chars()
        .filter(|c| !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        .collect();
    let safe_name = safe_name.trim_matches('.').to_string();
    if safe_name.is_empty() {
        return Err("ROM name is empty or invalid".to_string());
    }

    const WINDOWS_RESERVED: &[&str] = &[
        "CON", "PRN", "AUX", "NUL", "COM0", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
        "COM8", "COM9", "LPT0", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8",
        "LPT9",
    ];
    if WINDOWS_RESERVED
        .iter()
        .any(|&r| safe_name.eq_ignore_ascii_case(r))
    {
        return Err(format!("'{safe_name}' is a reserved Windows device name"));
    }

    Ok(safe_name)
}

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredRom {
    pub path: String,
    pub rel_path: String,
    pub dir_path: String,
    pub filename: String,
    pub stem: String,
    pub extension: String,
    pub system_id: Option<u32>,
    pub system_name: String,
    pub has_all_art: bool,
    pub existing_art_count: u32,
}

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub roms: Vec<DiscoveredRom>,
    pub total_roms: usize,
    pub already_complete: usize,
    pub needs_art: usize,
    pub systems_found: std::collections::HashMap<String, usize>,
}

#[tauri::command]
pub async fn scan_rom_directory(
    root_path: String,
    recursive: bool,
    custom_output_dir: Option<String>,
) -> Result<ScanResult, String> {
    tokio::task::spawn_blocking(move || {
        scan_rom_directory_sync(&root_path, recursive, custom_output_dir.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn ext_priority(ext: &str) -> u8 {
    match ext.to_ascii_lowercase().as_str() {
        "cue" => 10,
        "chd" => 9,
        "sfc" | "nes" | "sms" | "gg" | "gba" | "gbc" | "gb" | "pce" | "sgx" | "a26" | "a52"
        | "a78" | "lnx" => 8,
        "smc" | "fig" | "swc" | "gen" | "md" | "smd" => 7,
        "iso" => 6,
        "zip" | "7z" => 4,
        "bin" => 2,
        _ => 1,
    }
}

fn scan_rom_directory_sync(
    root_path: &str,
    recursive: bool,
    custom_output_dir: Option<&str>,
) -> Result<ScanResult, String> {
    let root = std::path::Path::new(root_path);
    if !root.is_dir() {
        return Err(format!("Directory does not exist: {root_path}"));
    }

    if let Some(custom) = custom_output_dir {
        let custom_path = std::path::Path::new(custom);
        if !custom_path.is_dir() {
            return Err(format!("Custom output directory does not exist: {custom}"));
        }
    }

    let mut roms: Vec<DiscoveredRom> = Vec::new();
    let mut systems_map: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();
    let mut already_complete: usize = 0;
    let mut needs_art: usize = 0;
    let mut stem_map: std::collections::HashMap<(String, String), usize> =
        std::collections::HashMap::new();

    let mut stack = vec![root.to_path_buf()];
    while let Some(current_dir) = stack.pop() {
        let entries = match std::fs::read_dir(&current_dir) {
            Ok(e) => e,
            Err(_) => continue,
        };

        for entry in entries.flatten() {
            // Never follow symlinks/junctions to prevent infinite loops
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_symlink() {
                continue;
            }

            let path = entry.path();
            if path.is_dir() {
                if recursive {
                    stack.push(path);
                }
            } else if path.is_file() {
                let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
                    continue;
                };
                if !is_rom_extension(ext) {
                    continue;
                }

                let Some(file_name) = path.file_name().and_then(|f| f.to_str()) else {
                    continue;
                };

                // Ignore documentation files like README.md, LICENSE.md
                let lower_name = file_name.to_ascii_lowercase();
                if lower_name.starts_with("readme")
                    || lower_name.starts_with("license")
                    || lower_name.starts_with("changelog")
                    || lower_name == "copying"
                {
                    continue;
                }

                let stem = path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or(file_name);

                let rel_path = path
                    .strip_prefix(root)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .into_owned();
                let dir_path = path.parent().unwrap_or(root).to_string_lossy().into_owned();

                let detected = detect_system_from_path_with_root(&path, Some(root));
                let (system_id, system_name) = match detected {
                    Some((id, name)) => (Some(id), name.to_string()),
                    None => (None, "Unknown System".to_string()),
                };

                // .md is also the markdown extension, so only treat it as a ROM when the
                // folders under the scan root say Genesis (same detection as everything else).
                if ext.eq_ignore_ascii_case("md") && system_id != Some(1) {
                    continue;
                }

                let target_dir = if let Some(custom) = custom_output_dir {
                    let rel_parent = path
                        .parent()
                        .and_then(|p| p.strip_prefix(root).ok())
                        .unwrap_or(std::path::Path::new(""));
                    std::path::Path::new(custom).join(rel_parent)
                } else {
                    path.parent().unwrap_or(root).to_path_buf()
                };

                let safe_stem = sanitize_rom_stem(stem).unwrap_or_else(|_| stem.to_string());

                let has_boxart = target_dir.join(format!("{safe_stem}.png")).exists();
                let has_screenshot = target_dir.join(format!("{safe_stem}.jpg")).exists();
                let has_title = target_dir.join(format!("{safe_stem}_title.png")).exists();
                let has_menu = target_dir.join(format!("{safe_stem}_menu.png")).exists();

                let mut existing_count = 0;
                if has_boxart {
                    existing_count += 1;
                }
                if has_screenshot {
                    existing_count += 1;
                }
                if has_title {
                    existing_count += 1;
                }
                if has_menu {
                    existing_count += 1;
                }

                let has_all_art = existing_count == 4;

                let discovered = DiscoveredRom {
                    path: path.to_string_lossy().into_owned(),
                    rel_path,
                    dir_path: dir_path.clone(),
                    filename: file_name.to_string(),
                    stem: stem.to_string(),
                    extension: ext.to_string(),
                    system_id,
                    system_name: system_name.clone(),
                    has_all_art,
                    existing_art_count: existing_count,
                };

                // Deduplicate by (dir_path, safe_stem) — e.g. Game.cue vs Game.bin, or .nes vs .zip
                let dedupe_key = (dir_path, safe_stem.to_ascii_lowercase());
                if let Some(&existing_idx) = stem_map.get(&dedupe_key) {
                    let existing_rom = &roms[existing_idx];
                    if ext_priority(ext) > ext_priority(&existing_rom.extension) {
                        // Replace lower-priority ROM
                        if existing_rom.has_all_art {
                            already_complete = already_complete.saturating_sub(1);
                        } else {
                            needs_art = needs_art.saturating_sub(1);
                        }
                        if let Some(c) = systems_map.get_mut(&existing_rom.system_name) {
                            *c = c.saturating_sub(1);
                        }

                        *systems_map.entry(system_name).or_insert(0) += 1;
                        if has_all_art {
                            already_complete += 1;
                        } else {
                            needs_art += 1;
                        }
                        roms[existing_idx] = discovered;
                    }
                    continue;
                }

                stem_map.insert(dedupe_key, roms.len());
                *systems_map.entry(system_name).or_insert(0) += 1;
                if has_all_art {
                    already_complete += 1;
                } else {
                    needs_art += 1;
                }
                roms.push(discovered);
            }
        }
    }

    roms.sort_by(|a, b| a.path.cmp(&b.path));

    let total_roms = roms.len();
    Ok(ScanResult {
        roms,
        total_roms,
        already_complete,
        needs_art,
        systems_found: systems_map,
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkScrapeRequest {
    pub rom_path: String,
    pub rom_filename: String,
    pub system_id: Option<u32>,
    pub source: String,
    pub output_dir: String,
    pub overwrite: bool,
    pub save_boxart: bool,
    pub save_screenshot: bool,
    pub save_title: bool,
    pub save_menu: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkScrapeResult {
    pub success: bool,
    pub skipped: bool,
    pub matched_name: Option<String>,
    pub saved_files: Vec<String>,
    pub error: Option<String>,
    pub error_kind: Option<String>,
}

fn classify_scrape_error(err: &str) -> &'static str {
    let s = err.to_ascii_lowercase();
    if s.contains("daily_quota_reached") || s.contains("quota journalier") {
        "DailyQuota"
    } else if s.contains("rate_limit")
        || s.contains("too many requests")
        || s.contains("trop de requêtes")
        || s.contains("maximum de threads")
    {
        "RateLimit"
    } else if s.contains("login failed") || s.contains("unauthorized") || s.contains("api key") {
        "Auth"
    } else if s.contains("timed out")
        || s.contains("timeout")
        || s.contains("error sending request")
        || s.contains("connection reset")
        || s.contains("connection refused")
        || s.contains("502 bad gateway")
        || s.contains("503 service unavailable")
        || s.contains("504 gateway timeout")
    {
        "Transient"
    } else if s.contains("no artwork") || s.contains("not found") {
        "NotFound"
    } else {
        "IO"
    }
}

async fn process_and_save_artwork(
    client: &reqwest::Client,
    candidate_url: &str,
    image_type: crate::image_processing::ImageType,
    crop: Option<crate::image_processing::CropPreset>,
    dest: &std::path::Path,
) -> Result<(), String> {
    let cached_path = download_and_cache_internal(client, candidate_url).await?;
    let cache_copy = cached_path.clone();
    let processed_temp = tokio::task::spawn_blocking(move || {
        crate::image_processing::process_image(&cache_copy, image_type, crop)
    })
    .await
    .map_err(|e| format!("Task panic: {e}"))??;

    let res = tokio::fs::copy(&processed_temp, dest)
        .await
        .map(|_| ())
        .map_err(|e| format!("Failed to copy to {}: {e}", dest.display()));

    let _ = tokio::fs::remove_file(&processed_temp).await;
    res
}

#[tauri::command]
pub async fn scrape_and_export_single_game(
    http: tauri::State<'_, AppClient>,
    req: BulkScrapeRequest,
) -> Result<BulkScrapeResult, String> {
    if req.output_dir.trim().is_empty() {
        return Err("Output directory path is empty".to_string());
    }
    let client = &http.0;
    let out_dir = std::path::Path::new(&req.output_dir);
    if !out_dir.exists() {
        tokio::fs::create_dir_all(out_dir)
            .await
            .map_err(|e| format!("Failed to create output directory {}: {e}", req.output_dir))?;
    }

    let stem = std::path::Path::new(&req.rom_filename)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(&req.rom_filename);

    let safe_name = sanitize_rom_stem(stem)?;

    let boxart_dest = out_dir.join(format!("{safe_name}.png"));
    let screenshot_dest = out_dir.join(format!("{safe_name}.jpg"));
    let title_dest = out_dir.join(format!("{safe_name}_title.png"));
    let menu_dest = out_dir.join(format!("{safe_name}_menu.png"));

    if !req.overwrite {
        let boxart_needed = req.save_boxart && !boxart_dest.exists();
        let screenshot_needed = req.save_screenshot && !screenshot_dest.exists();
        let title_needed = req.save_title && !title_dest.exists();
        let menu_needed = req.save_menu && !menu_dest.exists();

        if !boxart_needed && !screenshot_needed && !title_needed && !menu_needed {
            return Ok(BulkScrapeResult {
                success: true,
                skipped: true,
                matched_name: None,
                saved_files: vec![],
                error: None,
                error_kind: None,
            });
        }
    }

    // 1. Search for game
    let search_res = match if req.source == "ScreenScraper" {
        let clean_search = clean_title(stem);
        search_game_ss(
            client,
            &req.rom_path,
            &req.rom_filename,
            req.system_id,
            &clean_search,
        )
        .await
    } else {
        let clean_search = clean_title(stem);
        search_game_sgdb(client, &clean_search).await
    } {
        Ok(res) => res,
        Err(e) => {
            let kind = classify_scrape_error(&e);
            return Ok(BulkScrapeResult {
                success: false,
                skipped: false,
                matched_name: None,
                saved_files: vec![],
                error: Some(e),
                error_kind: Some(kind.to_string()),
            });
        }
    };

    let mut saved_files = Vec::new();
    let mut image_errors = Vec::new();

    // 2. Process Boxart
    if req.save_boxart && (req.overwrite || !boxart_dest.exists()) {
        if let Some(candidate) = search_res.boxart.first() {
            match process_and_save_artwork(
                client,
                &candidate.url,
                crate::image_processing::ImageType::Boxart,
                Some(crate::image_processing::CropPreset::Center),
                &boxart_dest,
            )
            .await
            {
                Ok(()) => saved_files.push("boxart".to_string()),
                Err(e) => image_errors.push(format!("boxart: {e}")),
            }
        }
    }

    // 3. Process Screenshot
    if req.save_screenshot && (req.overwrite || !screenshot_dest.exists()) {
        if let Some(candidate) = search_res.screenshot.first() {
            match process_and_save_artwork(
                client,
                &candidate.url,
                crate::image_processing::ImageType::Screenshot,
                None,
                &screenshot_dest,
            )
            .await
            {
                Ok(()) => saved_files.push("screenshot".to_string()),
                Err(e) => image_errors.push(format!("screenshot: {e}")),
            }
        }
    }

    // 4. Process Title
    if req.save_title && (req.overwrite || !title_dest.exists()) {
        if let Some(candidate) = search_res.title.first() {
            match process_and_save_artwork(
                client,
                &candidate.url,
                crate::image_processing::ImageType::Title,
                None,
                &title_dest,
            )
            .await
            {
                Ok(()) => saved_files.push("title".to_string()),
                Err(e) => image_errors.push(format!("title: {e}")),
            }
        }
    }

    // 5. Process Menu
    if req.save_menu && (req.overwrite || !menu_dest.exists()) {
        if let Some(candidate) = search_res.menu.first() {
            match process_and_save_artwork(
                client,
                &candidate.url,
                crate::image_processing::ImageType::Menu,
                Some(crate::image_processing::CropPreset::Center),
                &menu_dest,
            )
            .await
            {
                Ok(()) => saved_files.push("menu".to_string()),
                Err(e) => image_errors.push(format!("menu: {e}")),
            }
        }
    }

    let matched_name = search_res.matched_game.map(|g| g.name);
    if saved_files.is_empty() {
        let err_msg = if !image_errors.is_empty() {
            image_errors.join("; ")
        } else {
            "No artwork candidates available to download".to_string()
        };
        let kind = classify_scrape_error(&err_msg);
        Ok(BulkScrapeResult {
            success: false,
            skipped: false,
            matched_name,
            saved_files: vec![],
            error: Some(err_msg),
            error_kind: Some(kind.to_string()),
        })
    } else {
        Ok(BulkScrapeResult {
            success: true,
            skipped: false,
            matched_name,
            saved_files,
            error: None,
            error_kind: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_clean_title() {
        assert_eq!(clean_title("3-D WorldRunner (USA)"), "3-D WorldRunner");
        assert_eq!(
            clean_title("Activision Decathlon, The (USA)"),
            "The Activision Decathlon"
        );
        assert_eq!(
            clean_title("Action Fighter (USA, Europe, Brazil)"),
            "Action Fighter"
        );
        assert_eq!(clean_title("Ace of Aces (USA) [!]"), "Ace of Aces");
        assert_eq!(clean_title("Game (Beta) [b1]"), "Game");
    }

    #[test]
    fn test_is_rom_extension() {
        assert!(is_rom_extension("a26"));
        assert!(is_rom_extension("a52"));
        assert!(is_rom_extension("a78"));
        assert!(is_rom_extension("nes"));
        assert!(is_rom_extension("sfc"));
        assert!(is_rom_extension("bin"));
        assert!(is_rom_extension("sms"));
        assert!(is_rom_extension("gb"));
        assert!(is_rom_extension("gbc"));
        assert!(is_rom_extension("gba"));
        assert!(!is_rom_extension("png"));
        assert!(!is_rom_extension("jpg"));
        assert!(!is_rom_extension("txt"));
    }

    #[test]
    fn test_detect_system_from_path() {
        assert_eq!(
            detect_system_from_path(std::path::Path::new("I:\\Games\\Atari2600\\Game.a26")),
            Some((26, "Atari 2600"))
        );
        assert_eq!(
            detect_system_from_path(std::path::Path::new("I:\\Games\\NESNintendo\\Game.nes")),
            Some((3, "NES"))
        );
        assert_eq!(
            detect_system_from_path(std::path::Path::new("I:\\Games\\SegaGenesis\\Game.bin")),
            Some((1, "Sega Genesis"))
        );
        assert_eq!(
            detect_system_from_path(std::path::Path::new("I:\\Games\\GameBoyAdvance\\Game.gba")),
            Some((12, "Game Boy Advance"))
        );
    }

    #[test]
    fn test_detect_system_unambiguous_extensions() {
        assert_eq!(
            detect_system_from_path(std::path::Path::new("C:/games/Arcade Classics.a26")),
            Some((26, "Atari 2600"))
        );
        assert_eq!(
            detect_system_from_path(std::path::Path::new("C:/games/mame_fighter.nes")),
            Some((3, "NES"))
        );
        assert_eq!(
            detect_system_from_path(std::path::Path::new("C:/games/genesis_hero.sms")),
            Some((2, "Sega Master System"))
        );
        assert_eq!(
            detect_system_from_path(std::path::Path::new("C:/games/game.gba")),
            Some((12, "Game Boy Advance"))
        );
        assert_eq!(
            detect_system_from_path(std::path::Path::new("C:/games/game.pce")),
            Some((31, "PC Engine"))
        );
        assert_eq!(
            detect_system_from_path(std::path::Path::new("C:/games/game.gg")),
            Some((21, "Game Gear"))
        );
    }

    #[test]
    fn test_detect_system_super_famicom_before_famicom() {
        let sfc_path = std::path::Path::new("C:/roms/Super Famicom/game.bin");
        assert_eq!(
            detect_system_from_path(sfc_path),
            Some((4, "Super Nintendo"))
        );

        let nes_path = std::path::Path::new("C:/roms/Famicom/game.bin");
        assert_eq!(detect_system_from_path(nes_path), Some((3, "NES")));
    }

    #[test]
    fn test_detect_system_super_nes_folder() {
        let root = std::path::Path::new("C:/roms");
        let detect =
            |p: &str| detect_system_from_path_with_root(std::path::Path::new(p), Some(root));

        assert_eq!(
            detect("C:/roms/Super NES/game.bin"),
            Some((4, "Super Nintendo"))
        );
        assert_eq!(
            detect("C:/roms/SuperNES/game.bin"),
            Some((4, "Super Nintendo"))
        );
        assert_eq!(detect("C:/roms/SNES/game.bin"), Some((4, "Super Nintendo")));
        // Plain NES folders must still be NES.
        assert_eq!(detect("C:/roms/NES/game.bin"), Some((3, "NES")));
        assert_eq!(detect("C:/roms/Nintendo NES/game.bin"), Some((3, "NES")));
    }

    #[test]
    fn test_scan_md_only_counts_in_genesis_context() {
        let temp_dir = std::env::temp_dir().join(format!(
            "agsp_md_test_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        // The scan root itself has "genesis" in its name; that must not count.
        let root = temp_dir.join("genesis_backup");
        let md_dir = root.join("MD");
        let docs_dir = root.join("Docs");
        std::fs::create_dir_all(&md_dir).unwrap();
        std::fs::create_dir_all(&docs_dir).unwrap();

        std::fs::write(md_dir.join("Sonic.md"), b"dummy").unwrap();
        std::fs::write(docs_dir.join("notes.md"), b"# notes").unwrap();
        std::fs::write(root.join("todo.md"), b"# todo").unwrap();

        let scan = scan_rom_directory_sync(root.to_str().unwrap(), true, None)
            .expect("Scan should succeed");
        let _ = std::fs::remove_dir_all(&temp_dir);

        assert_eq!(scan.total_roms, 1);
        assert_eq!(scan.roms[0].filename, "Sonic.md");
        assert_eq!(scan.roms[0].system_id, Some(1));
    }

    #[test]
    fn test_json_keys_are_camel_case() {
        let rom = DiscoveredRom {
            path: String::new(),
            rel_path: String::new(),
            dir_path: String::new(),
            filename: String::new(),
            stem: String::new(),
            extension: String::new(),
            system_id: None,
            system_name: String::new(),
            has_all_art: false,
            existing_art_count: 0,
        };
        let scan = ScanResult {
            roms: vec![],
            total_roms: 0,
            already_complete: 0,
            needs_art: 0,
            systems_found: Default::default(),
        };
        let quota = crate::screenscraper::SsUserQuota {
            requests_today: 0,
            max_requests_per_day: 0,
            remaining: 0,
            max_threads: 0,
        };
        let result = BulkScrapeResult {
            success: true,
            skipped: false,
            matched_name: None,
            saved_files: vec![],
            error: None,
            error_kind: None,
        };

        // The frontend reads these exact keys; a rename here silently breaks the UI.
        let has = |v: serde_json::Value, keys: &[&str]| keys.iter().all(|k| v.get(*k).is_some());
        assert!(has(
            serde_json::to_value(&rom).unwrap(),
            &[
                "relPath",
                "dirPath",
                "systemId",
                "systemName",
                "hasAllArt",
                "existingArtCount"
            ]
        ));
        assert!(has(
            serde_json::to_value(&scan).unwrap(),
            &["totalRoms", "alreadyComplete", "needsArt", "systemsFound"]
        ));
        assert!(has(
            serde_json::to_value(&quota).unwrap(),
            &[
                "requestsToday",
                "maxRequestsPerDay",
                "remaining",
                "maxThreads"
            ]
        ));
        assert!(has(
            serde_json::to_value(&result).unwrap(),
            &["matchedName", "savedFiles", "errorKind"]
        ));
    }

    #[test]
    fn test_classify_scrape_error() {
        assert_eq!(
            classify_scrape_error("DAILY_QUOTA_REACHED: quota reached"),
            "DailyQuota"
        );
        assert_eq!(classify_scrape_error("RATE_LIMIT: too many"), "RateLimit");
        assert_eq!(
            classify_scrape_error("ScreenScraper login failed — check credentials in Settings"),
            "Auth"
        );
        assert_eq!(
            classify_scrape_error("HTTP status server error (503 Service Unavailable) for url"),
            "Transient"
        );
        assert_eq!(
            classify_scrape_error("No artwork candidates available to download"),
            "NotFound"
        );
        // Digits in a file path must not be mistaken for an HTTP status.
        assert_eq!(
            classify_scrape_error("boxart: Failed to copy to C:\\roms\\Game 502.png: disk error"),
            "IO"
        );
    }

    #[test]
    fn test_val_to_u64() {
        let num_val = serde_json::json!(19330);
        assert_eq!(crate::screenscraper::val_to_u64(Some(&num_val)), 19330);

        let str_val = serde_json::json!("20000");
        assert_eq!(crate::screenscraper::val_to_u64(Some(&str_val)), 20000);

        assert_eq!(crate::screenscraper::val_to_u64(None), 0);
    }

    #[test]
    fn test_scan_rom_directory_temp_fixture() {
        let temp_dir = std::env::temp_dir().join(format!(
            "agsp_test_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let snes_dir = temp_dir.join("Super Nintendo");
        let nes_dir = temp_dir.join("NES");
        let gen_dir = temp_dir.join("Genesis");
        std::fs::create_dir_all(&snes_dir).unwrap();
        std::fs::create_dir_all(&nes_dir).unwrap();
        std::fs::create_dir_all(&gen_dir).unwrap();

        // Add ROMs
        std::fs::write(snes_dir.join("Mario.sfc"), b"dummy").unwrap();
        std::fs::write(nes_dir.join("Zelda.nes"), b"dummy").unwrap();

        // Multi-file ROM deduplication test: Sonic.bin and Sonic.cue in same folder
        std::fs::write(gen_dir.join("Sonic.bin"), b"dummy").unwrap();
        std::fs::write(gen_dir.join("Sonic.cue"), b"dummy").unwrap();

        // Non-ROM doc test: README.md should be ignored
        std::fs::write(temp_dir.join("README.md"), b"# Notes").unwrap();

        let scan = scan_rom_directory_sync(temp_dir.to_str().unwrap(), true, None)
            .expect("Scan should succeed");

        // Cleanup temp dir
        let _ = std::fs::remove_dir_all(&temp_dir);

        // Sonic.bin and Sonic.cue deduplicated to 1 game, README.md ignored
        assert_eq!(scan.total_roms, 3);
        assert_eq!(scan.needs_art, 3);
        assert_eq!(scan.already_complete, 0);
        assert_eq!(*scan.systems_found.get("Super Nintendo").unwrap_or(&0), 1);
        assert_eq!(*scan.systems_found.get("NES").unwrap_or(&0), 1);
        assert_eq!(*scan.systems_found.get("Sega Genesis").unwrap_or(&0), 1);
    }

    #[test]
    fn test_bulk_scrape_request_deserialization() {
        let json = r#"{
            "romPath": "I:\\Games\\NESNintendo\\Super Mario Bros (USA).nes",
            "romFilename": "Super Mario Bros (USA).nes",
            "systemId": 3,
            "source": "ScreenScraper",
            "outputDir": "I:\\Games\\NESNintendo",
            "overwrite": false,
            "saveBoxart": true,
            "saveScreenshot": true,
            "saveTitle": true,
            "saveMenu": true
        }"#;
        let req: BulkScrapeRequest =
            serde_json::from_str(json).expect("BulkScrapeRequest should deserialize camelCase");
        assert_eq!(
            req.rom_path,
            "I:\\Games\\NESNintendo\\Super Mario Bros (USA).nes"
        );
        assert_eq!(req.rom_filename, "Super Mario Bros (USA).nes");
        assert_eq!(req.system_id, Some(3));
        assert_eq!(req.source, "ScreenScraper");
        assert_eq!(req.output_dir, "I:\\Games\\NESNintendo");
        assert!(!req.overwrite);
        assert!(req.save_boxart);
        assert!(req.save_screenshot);
        assert!(req.save_title);
        assert!(req.save_menu);
    }
}

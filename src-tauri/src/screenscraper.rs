use reqwest::Client;
use serde::Deserialize;
use crate::commands::{ImageCandidate, SsGameCandidate};

/// Logs to stderr in debug builds only. Compiled out entirely in release builds.
macro_rules! dev_log {
    ($($arg:tt)*) => {
        #[cfg(debug_assertions)]
        eprintln!($($arg)*)
    };
}

const DEV_ID: &str = env!("SCREENSCRAPER_DEV_ID");
const DEV_PASS: &str = env!("SCREENSCRAPER_DEV_PASSWORD");
const SEARCH_URL: &str = "https://api.screenscraper.fr/api2/jeuRecherche.php";
const INFO_URL: &str = "https://api.screenscraper.fr/api2/jeuInfos.php";
const SOFT_NAME: &str = "AGSScraper";

/// Replaces any credential values that appear in an error string with `***`.
/// reqwest errors include the full request URL (with credentials as query params)
/// in their Display output, so this must be applied before surfacing any error.
fn scrub(err: impl std::fmt::Display, ss_user: &str, ss_pass: &str) -> String {
    let mut s = err.to_string();
    for secret in [DEV_ID, DEV_PASS, ss_user, ss_pass] {
        if !secret.is_empty() {
            s = s.replace(secret, "***");
        }
    }
    s
}

// ── Deserialization: jeuRecherche (returns array `jeux`) ───────

#[derive(Deserialize)]
struct SsResponse {
    response: SsResponseInner,
}

#[derive(Deserialize)]
struct SsResponseInner {
    #[serde(default)]
    jeux: Vec<SsGame>,
}

// ── Deserialization: jeuInfos (returns single `jeu`) ───────────

#[derive(Deserialize)]
struct SsInfoResponse {
    response: SsInfoResponseInner,
}

#[derive(Deserialize)]
struct SsInfoResponseInner {
    jeu: Option<SsGame>,
}

// ── Shared game shape ──────────────────────────────────────────

#[derive(Deserialize)]
struct SsGame {
    // SS API returns id as a string in jeuRecherche but may vary; accept either.
    id: Option<serde_json::Value>,
    noms: Option<Vec<SsName>>,
    medias: Option<Vec<SsMedia>>,
    systeme: Option<SsSystemRef>,
}

#[derive(Deserialize)]
struct SsSystemRef {
    id: String,
    #[serde(default)]
    text: String,
}

#[derive(Deserialize)]
struct SsName {
    region: String,
    text: String,
}

#[derive(Deserialize)]
struct SsMedia {
    #[serde(rename = "type")]
    media_type: String,
    url: String,
}

// ── Public result types ────────────────────────────────────────

pub struct SsResults {
    pub matched_name: Option<String>,
    pub candidates: Vec<SsGameCandidate>,
    pub boxart: Vec<ImageCandidate>,
    pub screenshot: Vec<ImageCandidate>,
    pub title: Vec<ImageCandidate>,
    pub menu: Vec<ImageCandidate>,
}

impl SsResults {
    pub fn empty() -> Self {
        Self {
            matched_name: None,
            candidates: vec![],
            boxart: vec![],
            screenshot: vec![],
            title: vec![],
            menu: vec![],
        }
    }
}

// ── Internal helpers ───────────────────────────────────────────

fn game_display_name(game: &SsGame) -> Option<String> {
    game.noms.as_deref().and_then(|noms| {
        noms.iter()
            .find(|n| n.region == "ss")
            .or_else(|| noms.first())
            .map(|n| n.text.clone())
    })
}

fn game_id_str(game: &SsGame) -> String {
    match &game.id {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(serde_json::Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

/// Converts a parsed `SsGame` into `SsResults`. The `candidates` list is pre-built
/// by the caller (typically the other games from the same search response).
fn extract_results(game: SsGame, candidates: Vec<SsGameCandidate>) -> SsResults {
    let matched_name = game_display_name(&game);

    let mut boxart = Vec::new();
    let mut screenshot = Vec::new();
    let mut title = Vec::new();
    let mut menu = Vec::new();

    for media in game.medias.unwrap_or_default() {
        if media.url.is_empty() {
            continue;
        }
        let candidate = ImageCandidate {
            url: media.url,
            source: "ScreenScraper".into(),
        };
        match media.media_type.as_str() {
            "box-2D" => {
                menu.push(candidate.clone());
                boxart.push(candidate);
            }
            "ss" => screenshot.push(candidate),
            "wheel" => title.push(candidate),
            _ => {}
        }
    }

    dev_log!(
        "[SS] extracted: {:?} | boxart={} screenshot={} title={} menu={} candidates={}",
        matched_name,
        boxart.len(),
        screenshot.len(),
        title.len(),
        menu.len(),
        candidates.len(),
    );

    SsResults { matched_name, candidates, boxart, screenshot, title, menu }
}

/// Computes CRC32 and MD5 hashes of a file in streaming 64 KB chunks, along with
/// its size in bytes. Streaming avoids loading the entire ROM into RAM — important
/// for large images (GBA, PC Engine CD, ISO formats).
/// Synchronous blocking — only call from a blocking context.
fn hash_rom(path: &str) -> Result<(u32, String, u64), String> {
    use md5::{Digest, Md5};
    use std::io::Read;

    let mut file = std::fs::File::open(path).map_err(|e| format!("Failed to read ROM: {e}"))?;
    let size = file
        .metadata()
        .map_err(|e| format!("Failed to stat ROM: {e}"))?
        .len();

    let mut crc_hasher = crc32fast::Hasher::new();
    let mut md5_hasher = Md5::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("Failed to read ROM: {e}"))?;
        if n == 0 {
            break;
        }
        crc_hasher.update(&buf[..n]);
        md5_hasher.update(&buf[..n]);
    }

    let crc = crc_hasher.finalize();
    let md5_bytes = md5_hasher.finalize();
    let md5_hex: String = md5_bytes.iter().map(|b| format!("{b:02x}")).collect();
    Ok((crc, md5_hex, size))
}

// ── Public API ─────────────────────────────────────────────────

/// Tries to identify a ROM by hash (CRC32 + MD5) via jeuInfos.
/// Returns `None` if the ROM is not found in the SS database (caller should fall
/// through to `search_game`). Returns an error only for network/parse failures.
pub async fn lookup_by_hash(
    client: &Client,
    rom_path: &str,
    rom_filename: &str,
    system_id: u32,
    ss_user: &str,
    ss_pass: &str,
) -> Result<Option<SsResults>, String> {
    let (crc, md5, size) = hash_rom(rom_path)?;
    let crc_hex = format!("{:08x}", crc);
    let size_str = size.to_string();
    let sys_str = system_id.to_string();

    dev_log!(
        "[SS] lookup_by_hash: crc={crc_hex} md5={md5} size={size} file={rom_filename:?} system={system_id}"
    );

    let params: Vec<(&str, &str)> = vec![
        ("devid",       DEV_ID),
        ("devpassword", DEV_PASS),
        ("softname",    SOFT_NAME),
        ("output",      "json"),
        ("ssid",        ss_user),
        ("sspassword",  ss_pass),
        ("crc",         &crc_hex),
        ("md5",         &md5),
        ("romtaille",   &size_str),
        ("systemeid",   &sys_str),
        ("romtype",     "rom"),
        ("romnom",      rom_filename),
    ];

    let resp = client
        .get(INFO_URL)
        .query(&params)
        .send()
        .await
        .map_err(|e| scrub(e, ss_user, ss_pass))?;

    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err("ScreenScraper login failed — check credentials in Settings".to_string());
    }

    let body = resp
        .text()
        .await
        .map_err(|e| scrub(e, ss_user, ss_pass))?;

    // ScreenScraper returns HTTP 200 with a body sentinel instead of HTTP error codes
    // for "not found" and many error conditions. String matching is fragile but is the
    // only reliable detection method given the undocumented API.
    if body.contains("jeuNotTrouve") || body.contains("Erreur") {
        dev_log!("[SS] hash lookup: no match ({} bytes)", body.len());
        return Ok(None);
    }

    let parsed: SsInfoResponse = serde_json::from_str(&body)
        .map_err(|e| scrub(format!("ScreenScraper jeuInfos parse error: {e}"), ss_user, ss_pass))?;

    match parsed.response.jeu {
        Some(game) => Ok(Some(extract_results(game, vec![]))),
        None => Ok(None),
    }
}

/// Fetches full game info and media for a known SS game ID via jeuInfos.
/// Used when the user selects an alternative candidate game.
pub async fn fetch_by_game_id(
    client: &Client,
    game_id: &str,
    ss_user: &str,
    ss_pass: &str,
) -> Result<SsResults, String> {
    dev_log!("[SS] fetch_by_game_id: gameid={game_id}");

    let params: Vec<(&str, &str)> = vec![
        ("devid",       DEV_ID),
        ("devpassword", DEV_PASS),
        ("softname",    SOFT_NAME),
        ("output",      "json"),
        ("ssid",        ss_user),
        ("sspassword",  ss_pass),
        ("gameid",      game_id),
        ("romtype",     "rom"),
    ];

    let resp = client
        .get(INFO_URL)
        .query(&params)
        .send()
        .await
        .map_err(|e| scrub(e, ss_user, ss_pass))?;

    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err("ScreenScraper login failed — check credentials in Settings".to_string());
    }

    let body = resp
        .text()
        .await
        .map_err(|e| scrub(e, ss_user, ss_pass))?;

    if body.contains("jeuNotTrouve") || body.contains("Erreur") {
        return Ok(SsResults::empty());
    }

    let parsed: SsInfoResponse = serde_json::from_str(&body)
        .map_err(|e| scrub(format!("ScreenScraper jeuInfos parse error: {e}"), ss_user, ss_pass))?;

    match parsed.response.jeu {
        Some(game) => Ok(extract_results(game, vec![])),
        None => Ok(SsResults::empty()),
    }
}

/// Search ScreenScraper by search term. System ID is applied as a client-side
/// filter — it is NOT sent to jeuRecherche (sending it suppresses too many results).
/// Returns empty results (not an error) when no game is found.
pub async fn search_game(
    client: &Client,
    recherche: &str,
    system_id: Option<u32>,
    ss_user: &str,
    ss_pass: &str,
) -> Result<SsResults, String> {
    let params: Vec<(&str, &str)> = vec![
        ("devid",       DEV_ID),
        ("devpassword", DEV_PASS),
        ("softname",    SOFT_NAME),
        ("output",      "json"),
        ("ssid",        ss_user),
        ("sspassword",  ss_pass),
        ("recherche",   recherche),
    ];

    dev_log!(
        "[SS] search_game: recherche={:?} system={:?} (filter applied client-side)",
        recherche, system_id
    );

    let resp = client
        .get(SEARCH_URL)
        .query(&params)
        .send()
        .await
        .map_err(|e| scrub(e, ss_user, ss_pass))?;

    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err("ScreenScraper login failed — check credentials in Settings".to_string());
    }

    let body = resp
        .text()
        .await
        .map_err(|e| scrub(e, ss_user, ss_pass))?;

    if body.contains("jeuNotTrouve") || body.contains("Erreur") {
        dev_log!("[SS] search: no match ({} bytes)", body.len());
        return Ok(SsResults::empty());
    }

    let parsed: SsResponse = serde_json::from_str(&body)
        .map_err(|e| scrub(format!("ScreenScraper parse error: {e}"), ss_user, ss_pass))?;

    let jeux = parsed.response.jeux;

    // Log all candidates.
    dev_log!("[SS] {} candidate(s):", jeux.len());
    #[cfg(debug_assertions)]
    for (i, g) in jeux.iter().enumerate() {
        let name = game_display_name(g).unwrap_or_else(|| "?".into());
        let sys_id = g.systeme.as_ref().map(|s| s.id.as_str()).unwrap_or("?");
        let sys_name = g.systeme.as_ref().map(|s| s.text.as_str()).unwrap_or("?");
        eprintln!("[SS]   [{}] system={} ({}) name={:?}", i, sys_id, sys_name, name);
    }

    // When a system is specified, prefer the first result whose systeme.id matches.
    // Collect all games as SsGameCandidate for the alternatives list.
    let wanted_str = system_id.map(|id| id.to_string());

    // Find the index of the best match.
    let best_idx = if let Some(ref wanted) = wanted_str {
        jeux.iter().position(|g| {
            g.systeme.as_ref().map(|s| &s.id == wanted).unwrap_or(false)
        })
    } else {
        if jeux.is_empty() { None } else { Some(0) }
    };

    let Some(best_idx) = best_idx else {
        // No system match — return all as candidates, no auto-selected images.
        let candidates: Vec<SsGameCandidate> = jeux.into_iter().filter_map(|g| {
            let id = game_id_str(&g);
            if id.is_empty() { return None; }
            Some(SsGameCandidate {
                id,
                name: game_display_name(&g).unwrap_or_default(),
                system_id: g.systeme.as_ref().map(|s| s.id.clone()).unwrap_or_default(),
                system_name: g.systeme.as_ref().map(|s| s.text.clone()).unwrap_or_default(),
            })
        }).collect();
        dev_log!("[SS] no system match — returning {} candidates", candidates.len());
        return Ok(SsResults { candidates, ..SsResults::empty() });
    };

    // Build the candidates list from all OTHER games (not the auto-selected one).
    let candidates: Vec<SsGameCandidate> = jeux.iter().enumerate()
        .filter(|(i, _)| *i != best_idx)
        .filter_map(|(_, g)| {
            let id = game_id_str(g);
            if id.is_empty() { return None; }
            Some(SsGameCandidate {
                id,
                name: game_display_name(g).unwrap_or_default(),
                system_id: g.systeme.as_ref().map(|s| s.id.clone()).unwrap_or_default(),
                system_name: g.systeme.as_ref().map(|s| s.text.clone()).unwrap_or_default(),
            })
        })
        .collect();

    // Remove the best match from the vec and extract results from it.
    let mut jeux = jeux;
    let game = jeux.remove(best_idx);
    Ok(extract_results(game, candidates))
}


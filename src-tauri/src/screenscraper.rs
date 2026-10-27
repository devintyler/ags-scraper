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
const USER_INFO_URL: &str = "https://api.screenscraper.fr/api2/ssuserInfos.php";
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
/// Returns `Ok(None)` without reading the file if it is larger than `max_bytes`.
/// Synchronous blocking — only call from a blocking context.
fn hash_rom(path: &str, max_bytes: u64) -> Result<Option<(u32, String, u64)>, String> {
    use md5::{Digest, Md5};
    use std::io::Read;

    let mut file = std::fs::File::open(path).map_err(|e| format!("Failed to read ROM: {e}"))?;
    let size = file
        .metadata()
        .map_err(|e| format!("Failed to stat ROM: {e}"))?
        .len();
    if size > max_bytes {
        return Ok(None);
    }

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
    Ok(Some((crc, md5_hex, size)))
}

/// Files above this size are not hashed (large disc images, CHDs). The caller falls
/// back to the text search, same as for any hash miss.
const MAX_HASH_BYTES: u64 = 256 * 1024 * 1024;

// ── Public API ─────────────────────────────────────────────────

/// What an HTTP status from ScreenScraper means for the caller.
#[derive(Debug, PartialEq)]
pub(crate) enum SsStatus {
    Ok,
    NotFound,
    Fail(String),
}

/// Decides by HTTP status. The statuses are listed in the API docs
/// (`misc/ss-api-docs.html`) and, unlike the body text, don't depend on the
/// language the server answers in (the live API replies in French).
/// The error prefixes (`RATE_LIMIT:`, `DAILY_QUOTA_REACHED:`, `TRANSIENT:` and the
/// "login failed" wording) are what the command layer and the UI key on.
pub(crate) fn classify_ss_status(status: u16) -> SsStatus {
    match status {
        200..=299 => SsStatus::Ok,
        404 => SsStatus::NotFound,
        429 => SsStatus::Fail(
            "RATE_LIMIT: Too many requests — ScreenScraper thread limit reached.".to_string(),
        ),
        430 => SsStatus::Fail(
            "DAILY_QUOTA_REACHED: ScreenScraper daily request quota has been reached (resets at midnight GMT)."
                .to_string(),
        ),
        431 => SsStatus::Fail(
            "DAILY_QUOTA_REACHED: ScreenScraper daily limit for unrecognized ROMs has been reached (resets at midnight GMT)."
                .to_string(),
        ),
        // 403 is the app's developer login being rejected (not fixable in Settings).
        403 => SsStatus::Fail(format!(
            "ScreenScraper login failed — the app's developer credentials were rejected (HTTP {status})"
        )),
        // 401 means "API closed to non-members / server saturated" per the docs, but a
        // wrong user login may also land here. Retry, and let the consecutive-error
        // pause catch a persistent problem instead of aborting a long run.
        401 => SsStatus::Fail(format!(
            "TRANSIENT: ScreenScraper refused the request (HTTP {status}) — the login may be wrong or the server busy"
        )),
        423 | 426 => SsStatus::Fail(format!(
            "ScreenScraper API unavailable (HTTP {status}) — it is closed or this app version is blocked"
        )),
        500..=599 => SsStatus::Fail(format!("TRANSIENT: ScreenScraper server error (HTTP {status})")),
        _ => SsStatus::Fail(format!("ScreenScraper returned HTTP {status}")),
    }
}

/// Builds the error for a 2xx body that did not parse as the expected JSON.
/// Only the word "login" is looked for (same in French and English), and only in
/// a short plain-text body, so an HTML maintenance page with a "Login" link is not
/// mistaken for bad credentials. Anything else is reported as a plain parse error.
fn explain_unparsable_body(body: &str, detail: String) -> String {
    let trimmed = body.trim();
    let short_plain_text = trimmed.len() <= 300 && !trimmed.contains('<');
    if short_plain_text && !trimmed.starts_with('{') && trimmed.to_ascii_lowercase().contains("login")
    {
        return "ScreenScraper login failed — check credentials in Settings".to_string();
    }
    detail
}

enum SsBody {
    Found(String),
    NotFound,
}

/// Applies `classify_ss_status` and reads the body only for successful responses.
async fn read_ss_body(
    resp: reqwest::Response,
    ss_user: &str,
    ss_pass: &str,
) -> Result<SsBody, String> {
    match classify_ss_status(resp.status().as_u16()) {
        SsStatus::NotFound => Ok(SsBody::NotFound),
        SsStatus::Fail(msg) => Err(msg),
        SsStatus::Ok => resp
            .text()
            .await
            .map(SsBody::Found)
            .map_err(|e| scrub(e, ss_user, ss_pass)),
    }
}

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
    // Hashing reads the whole file, so keep it off the async runtime threads.
    let hash_path = rom_path.to_string();
    let hashed = tokio::task::spawn_blocking(move || hash_rom(&hash_path, MAX_HASH_BYTES))
        .await
        .map_err(|e| format!("Hash task failed: {e}"))??;
    let Some((crc, md5, size)) = hashed else {
        dev_log!("[SS] lookup_by_hash: {rom_filename:?} exceeds hash size limit, skipping");
        return Ok(None);
    };
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

    let body = match read_ss_body(resp, ss_user, ss_pass).await? {
        SsBody::Found(body) => body,
        SsBody::NotFound => {
            dev_log!("[SS] hash lookup: no match");
            return Ok(None);
        }
    };

    let parsed: SsInfoResponse = serde_json::from_str(&body).map_err(|e| {
        scrub(
            explain_unparsable_body(&body, format!("ScreenScraper jeuInfos parse error: {e}")),
            ss_user,
            ss_pass,
        )
    })?;
    Ok(parsed.response.jeu.map(|game| extract_results(game, vec![])))
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

    let body = match read_ss_body(resp, ss_user, ss_pass).await? {
        SsBody::Found(body) => body,
        SsBody::NotFound => return Ok(SsResults::empty()),
    };

    let parsed: SsInfoResponse = serde_json::from_str(&body).map_err(|e| {
        scrub(
            explain_unparsable_body(&body, format!("ScreenScraper jeuInfos parse error: {e}")),
            ss_user,
            ss_pass,
        )
    })?;
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

    let body = match read_ss_body(resp, ss_user, ss_pass).await? {
        SsBody::Found(body) => body,
        SsBody::NotFound => {
            dev_log!("[SS] search: no match");
            return Ok(SsResults::empty());
        }
    };

    let parsed: SsResponse = serde_json::from_str(&body).map_err(|e| {
        scrub(
            explain_unparsable_body(&body, format!("ScreenScraper parse error: {e}")),
            ss_user,
            ss_pass,
        )
    })?;

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

// ── ScreenScraper User Quota ───────────────────────────────────

#[derive(Deserialize)]
struct SsUserResponse {
    response: SsUserResponseInner,
}

#[derive(Deserialize)]
struct SsUserResponseInner {
    #[serde(default)]
    ssuser: Option<SsUserObj>,
}

#[derive(Deserialize)]
struct SsUserObj {
    #[serde(default)]
    requeststoday: Option<serde_json::Value>,
    #[serde(default)]
    maxrequestsperday: Option<serde_json::Value>,
    #[serde(default)]
    maxthreads: Option<serde_json::Value>,
}

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SsUserQuota {
    pub requests_today: u64,
    pub max_requests_per_day: u64,
    pub remaining: u64,
    pub max_threads: u32,
}

pub fn val_to_u64(val: Option<&serde_json::Value>) -> u64 {
    match val {
        Some(serde_json::Value::Number(n)) => n.as_u64().unwrap_or(0),
        Some(serde_json::Value::String(s)) => s.trim().parse::<u64>().unwrap_or(0),
        _ => 0,
    }
}

pub async fn get_user_quota(
    client: &Client,
    ss_user: &str,
    ss_pass: &str,
) -> Result<SsUserQuota, String> {
    let params: Vec<(&str, &str)> = vec![
        ("devid",       DEV_ID),
        ("devpassword", DEV_PASS),
        ("softname",    SOFT_NAME),
        ("output",      "json"),
        ("ssid",        ss_user),
        ("sspassword",  ss_pass),
    ];

    let resp = client
        .get(USER_INFO_URL)
        .query(&params)
        .send()
        .await
        .map_err(|e| scrub(e, ss_user, ss_pass))?;

    let body = match read_ss_body(resp, ss_user, ss_pass).await? {
        SsBody::Found(body) => body,
        SsBody::NotFound => return Err("No user profile returned from ScreenScraper".to_string()),
    };

    let parsed: SsUserResponse = serde_json::from_str(&body).map_err(|e| {
        scrub(
            explain_unparsable_body(&body, format!("ScreenScraper parse error: {e}")),
            ss_user,
            ss_pass,
        )
    })?;

    let Some(user) = parsed.response.ssuser else {
        return Err("No user profile returned from ScreenScraper".to_string());
    };

    let requests_today = val_to_u64(user.requeststoday.as_ref());
    let max_requests = val_to_u64(user.maxrequestsperday.as_ref());
    let max_threads = val_to_u64(user.maxthreads.as_ref()) as u32;
    let remaining = max_requests.saturating_sub(requests_today);

    Ok(SsUserQuota {
        requests_today,
        max_requests_per_day: max_requests,
        remaining,
        max_threads,
    })
}


#[cfg(test)]
mod tests {
    use super::*;

    fn temp_file(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "agsp_hash_{}_{}",
            std::process::id(),
            name
        ));
        std::fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn test_classify_ss_status() {
        assert_eq!(classify_ss_status(200), SsStatus::Ok);
        assert_eq!(classify_ss_status(404), SsStatus::NotFound);

        let fail = |status| match classify_ss_status(status) {
            SsStatus::Fail(msg) => msg,
            other => panic!("expected Fail for {status}, got {other:?}"),
        };
        assert!(fail(429).starts_with("RATE_LIMIT:"));
        assert!(fail(430).starts_with("DAILY_QUOTA_REACHED:"));
        assert!(fail(431).starts_with("DAILY_QUOTA_REACHED:"));
        assert!(fail(401).starts_with("TRANSIENT:"));
        assert!(fail(403).contains("login failed"));
        assert!(fail(403).contains("developer"));
        for status in [500, 502, 503, 504] {
            assert!(fail(status).starts_with("TRANSIENT:"), "status {status}");
        }
        assert!(fail(423).contains("unavailable"));
        assert!(fail(426).contains("unavailable"));
        // An unexpected status must never be mistaken for "not found".
        assert!(!matches!(classify_ss_status(418), SsStatus::NotFound));
    }

    #[test]
    fn test_explain_unparsable_body() {
        // Real response captured from the live API for a bad hash lookup.
        let not_found = "Erreur : Rom/Iso/Dossier non trouvée !";
        assert_eq!(
            explain_unparsable_body(not_found, "parse error".to_string()),
            "parse error"
        );
        // A login problem is recognised by the word "login" in a non-JSON body.
        assert!(
            explain_unparsable_body("Erreur de login : vérifiez", "x".to_string())
                .contains("login failed")
        );
        // An HTML page (maintenance, CDN) with a "Login" link is not a credentials error.
        assert_eq!(
            explain_unparsable_body(
                "<html><body><a href=\"/login\">Login</a> Maintenance</body></html>",
                "html".to_string()
            ),
            "html"
        );
        // A JSON body that merely mentions login is just a parse failure.
        assert_eq!(
            explain_unparsable_body("{\"login\": broken", "bad json".to_string()),
            "bad json"
        );
    }

    #[test]
    fn test_hash_rom_known_values() {
        let path = temp_file("abc.bin", b"abc");
        let result = hash_rom(path.to_str().unwrap(), 1024);
        let _ = std::fs::remove_file(&path);

        let (crc, md5, size) = result.unwrap().expect("small file should be hashed");
        assert_eq!(crc, 0x352441c2);
        assert_eq!(md5, "900150983cd24fb0d6963f7d28e17f72");
        assert_eq!(size, 3);
    }

    #[test]
    fn test_hash_rom_skips_files_over_limit() {
        let path = temp_file("big.bin", b"abc");
        let result = hash_rom(path.to_str().unwrap(), 2);
        let _ = std::fs::remove_file(&path);

        assert!(result.unwrap().is_none());
    }

    #[test]
    fn test_hash_rom_missing_file_is_error() {
        assert!(hash_rom("Z:/definitely/not/here.bin", 1024).is_err());
    }
}

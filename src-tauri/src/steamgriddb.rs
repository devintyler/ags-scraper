use reqwest::Client;
use serde::Deserialize;

use crate::commands::ImageCandidate;

const TIMEOUT_MSG: &str = "Request timed out. Check your connection.";

#[derive(Deserialize)]
struct SearchResponse {
    success: bool,
    #[serde(default)]
    data: Vec<SgdbGame>,
}

#[derive(Deserialize, Debug)]
pub struct SgdbGame {
    pub id: u64,
    pub name: String,
}

/// Shared response shape for both grids and logos endpoints.
#[derive(Deserialize)]
struct ItemsResponse {
    success: bool,
    #[serde(default)]
    data: Vec<UrlItem>,
}

#[derive(Deserialize)]
struct UrlItem {
    // SGDB can return null for url on some items (e.g. animated-only grids).
    url: Option<String>,
}

pub async fn search_game(client: &Client, term: &str, api_key: &str) -> Result<Vec<SgdbGame>, String> {
    let mut url = reqwest::Url::parse("https://www.steamgriddb.com/api/v2/search/autocomplete")
        .map_err(|e| e.to_string())?;
    // term is a path segment; reqwest percent-encodes it automatically.
    url.path_segments_mut()
        .map_err(|_| "URL error".to_string())?
        .push(term);

    let resp = client
        .get(url)
        .header("Authorization", format!("Bearer {}", api_key))
        .send()
        .await
        .map_err(|e| if e.is_timeout() { TIMEOUT_MSG.to_string() } else { e.to_string() })?;

    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err("SteamGridDB API key invalid — check key in Settings".to_string());
    }

    let resp = resp.error_for_status().map_err(|e| e.to_string())?;
    let body: SearchResponse = resp.json().await.map_err(|e| e.to_string())?;
    if !body.success {
        return Ok(vec![]);
    }
    Ok(body.data)
}

pub async fn fetch_grids(client: &Client, game_id: u64, api_key: &str) -> Result<Vec<ImageCandidate>, String> {
    // Filter to portrait formats only; widescreen grids (920x430 etc.) are unsuitable for boxart/menu.
    let url = format!(
        "https://www.steamgriddb.com/api/v2/grids/game/{}?dimensions=600x900,342x482",
        game_id
    );

    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .send()
        .await
        .map_err(|e| if e.is_timeout() { TIMEOUT_MSG.to_string() } else { e.to_string() })?;

    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err("SteamGridDB API key invalid — check key in Settings".to_string());
    }

    let resp = resp.error_for_status().map_err(|e| e.to_string())?;
    let body: ItemsResponse = resp.json().await.map_err(|e| e.to_string())?;
    if !body.success {
        return Ok(vec![]);
    }
    Ok(body
        .data
        .into_iter()
        .filter_map(|item| {
            item.url.map(|u| ImageCandidate {
                url: u,
                source: "SteamGridDB".into(),
            })
        })
        .collect())
}

pub async fn fetch_logos(client: &Client, game_id: u64, api_key: &str) -> Result<Vec<ImageCandidate>, String> {
    let url = format!(
        "https://www.steamgriddb.com/api/v2/logos/game/{}",
        game_id
    );

    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .send()
        .await
        .map_err(|e| if e.is_timeout() { TIMEOUT_MSG.to_string() } else { e.to_string() })?;

    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err("SteamGridDB API key invalid — check key in Settings".to_string());
    }

    let resp = resp.error_for_status().map_err(|e| e.to_string())?;
    let body: ItemsResponse = resp.json().await.map_err(|e| e.to_string())?;
    if !body.success {
        return Ok(vec![]);
    }
    Ok(body
        .data
        .into_iter()
        .filter_map(|item| {
            item.url.map(|u| ImageCandidate {
                url: u,
                source: "SteamGridDB".into(),
            })
        })
        .collect())
}

# Phase 6 — SteamGridDB Integration

## Goal
Add SteamGridDB as a second image source. Users can pull boxart and logo alternatives from SteamGridDB alongside ScreenScraper results. Each image type in the picker shows results from both sources, labeled by origin.

## Context
- Phases 1–5 must be complete (full end-to-end flow working).
- SteamGridDB API docs: https://www.steamgriddb.com/api/v2
- Auth: `Authorization: Bearer {api_key}` header
- SteamGridDB is strongest for boxart (grids) and logos. Screenshot coverage is weak — do not use SteamGridDB for screenshots (ScreenScraper only).
- MAME/arcade coverage on SteamGridDB is lower than console games. Results may be sparse; this is expected.

## SteamGridDB API Endpoints Used
| Purpose | Endpoint |
|---|---|
| Search for game | `GET /search/autocomplete/{term}` |
| Fetch grid images (boxart) | `GET /grids/game/{game_id}?dimensions=600x900` |
| Fetch logo images (title) | `GET /logos/game/{game_id}` |

Note: Filter grids by `dimensions=600x900` (or `342x482`) to get portrait boxart rather than landscape hero images.

## Work Items

1. **Implement SteamGridDB API client (`src/steamgriddb.rs`)**
   - `fn search_game(term: &str, api_key: &str) -> Result<Vec<SgdbGame>>`
     - Calls `/search/autocomplete/{term}`
     - Returns list of `SgdbGame { id, name }`
   - `fn fetch_grids(game_id: u64, api_key: &str) -> Result<Vec<ImageCandidate>>`
     - Calls `/grids/game/{game_id}?dimensions=600x900,342x482`
     - Maps results to `ImageCandidate { url, source: "SteamGridDB", width, height }`
   - `fn fetch_logos(game_id: u64, api_key: &str) -> Result<Vec<ImageCandidate>>`
     - Calls `/logos/game/{game_id}`
     - Maps results to `ImageCandidate`

2. **Update `search_game` Tauri command**
   - Accept a `sources: Vec<Source>` parameter (`Source` enum: `ScreenScraper`, `SteamGridDB`, `Both`)
   - When SteamGridDB is included: call SteamGridDB search in parallel with ScreenScraper (use `tokio::join!`)
   - Merge results per image type — SteamGridDB appends to ScreenScraper results (or vice versa)
   - If SteamGridDB search returns multiple game matches, use the first result (closest name match)
   - SteamGridDB is only queried for `boxart`, `menu`, and `title` — not `screenshot`

3. **Add source labels to Image Picker grid (frontend)**
   - Each image thumbnail in the picker grid shows a small source badge: "SS" (ScreenScraper) or "SGDB" (SteamGridDB)
   - No other UI changes required — the grid already handles multiple candidates

4. **Add source selector to Main view**
   - Replace the Phase 2 placeholder source toggle with a proper multi-select: checkboxes for ScreenScraper and SteamGridDB
   - Both enabled by default
   - If SteamGridDB is checked but no API key is configured, show an inline warning and link to Settings

5. **Add SteamGridDB API key to Settings view**
   - Add "SteamGridDB API key" field (masked input) below the ScreenScraper fields
   - Link to https://www.steamgriddb.com/profile/preferences/api for key generation instructions
   - Save/load via existing `save_config` / `load_config` commands (already has `steamgriddb.api_key_enc` field)

## Acceptance Criteria
- [ ] With both sources enabled, the boxart picker shows results from both ScreenScraper and SteamGridDB, each with a source badge
- [ ] With only ScreenScraper enabled, behavior is identical to Phase 5
- [ ] SteamGridDB source disabled if API key not configured, with a clear message
- [ ] Screenshot tab always shows only ScreenScraper results regardless of source settings
- [ ] No increase in scrape time when SteamGridDB is disabled

## Notes
- Run ScreenScraper and SteamGridDB requests concurrently (`tokio::join!`) to avoid adding latency.
- SteamGridDB logo images are typically transparent PNGs — good fit for the title/wheel slot.
- If SteamGridDB search returns zero results for a MAME short name, try searching by the full game name from the ScreenScraper result (if available). This is optional — log a warning and move on if it also fails.

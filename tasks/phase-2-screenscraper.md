# Phase 2 — ScreenScraper API Client & Main View

## Goal
End-to-end scrape of a single ROM via ScreenScraper, returning image candidate URLs displayed in the UI. After this phase you can enter a ROM filename, click Scrape, and see real results.

## Context
- Phase 1 must be complete (config, credentials, Settings view).
- ScreenScraper API docs: https://www.screenscraper.fr/webapi2.php (French, use browser translate)
- MAME is the primary use case — system ID 75, ROM short names (e.g. `mspacman` from `mspacman.zip`)
- Auth: username + password passed as query params `devid`, `devpassword`, `ssid`, `sspassword`
  - For open-source use: `devid` and `devpassword` should be a registered developer account (the user's own, or a shared project dev ID stored as a build-time env var — do NOT hardcode credentials)
  - `ssid` / `sspassword` are the end user's ScreenScraper account credentials from config

## Work Items

1. **Register a ScreenScraper developer ID**
   - Go to https://www.screenscraper.fr and register a dev account
   - Store `SCREENSCRAPER_DEV_ID` and `SCREENSCRAPER_DEV_PASSWORD` as environment variables read at build time, or as non-sensitive build constants (dev credentials are separate from user credentials and lower-risk)
   - Document this requirement in a `CONTRIBUTING.md` or README note

2. **Implement ScreenScraper API client (`src/screenscraper.rs`)**
   - Base URL: `https://www.screenscraper.fr/api2/`
   - Key endpoint: `jeuRecherche.php` — search by game name
     - Params: `devid`, `devpassword`, `ssid`, `sspassword`, `softname=gsp-scraper`, `output=json`, `recherche={term}`, `systemeid={id}`
   - Response parsing: extract image entries of types `box-2D`, `ss`, `wheel` from the `jeu.medias` array
   - Each image entry has: `type`, `region`, `url`, `format`
   - Return a structured `SearchResult` with candidate lists per image type

3. **Implement `search_game` Tauri command**
   - Signature: `search_game(rom_filename: String, system_id: Option<u32>) -> Result<SearchResults, String>`
   - Strip file extension from `rom_filename` to get search term
   - If `system_id` is None, omit the `systemeid` param (search all systems)
   - Return `SearchResults { boxart: Vec<ImageCandidate>, screenshot: Vec<ImageCandidate>, title: Vec<ImageCandidate>, menu: Vec<ImageCandidate> }`
   - Note: `menu` returns the same candidates as `boxart` (same `box-2D` results, user picks independently)

4. **Build Main view (frontend)**
   - ROM file picker (opens Windows file dialog via Tauri dialog plugin)
   - Output directory picker (opens folder dialog)
   - Search field — auto-populated from ROM filename (extension stripped), fully editable
   - System ID field — optional number input, placeholder "Leave blank to search all systems" with a note linking to https://www.screenscraper.fr/systemesListe.php for ID lookup
   - Scrape button — disabled until ROM filename and output dir are both set
   - Source toggle — for now just ScreenScraper (SteamGridDB added in Phase 6)
   - Results area — after scraping, show count of candidates found per image type

5. **Wire up scrape flow**
   - Scrape button click → call `search_game` → on success, navigate to Image Picker view (Phase 3 placeholder for now)
   - On error: display inline error message (auth failure, no results, network error)
   - Show loading spinner during scrape

6. **Persist last-used output directory**
   - On successful scrape, save `last_output_dir` to config via `save_config`
   - Repopulate output directory field on app load from config

## Acceptance Criteria
- [ ] Entering `mspacman.zip` and clicking Scrape returns image candidates from ScreenScraper
- [ ] Search field is pre-filled with `mspacman` but can be edited before scraping
- [ ] Auth errors surface a readable message (not a raw API error)
- [ ] Zero results shows a clear message with the search term used
- [ ] Last-used output directory persists across sessions

## Notes
- ScreenScraper returns images with region tags (us, eu, jp, ss, etc.). Don't filter by region in v1 — return all and let the user choose.
- The `wheel` type covers what we call "title" throughout this project. Use `wheel` when querying the API; map to `title` internally.
- The API is rate-limited. For single-ROM mode this is not a concern, but add a reasonable timeout (30s) on requests.
- If ScreenScraper returns a `jeuNotTrouve` response, treat as zero results.

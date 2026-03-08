# Phase 3 — Image Download, Cache & Picker Grid

## Goal
After scraping, the user can browse a grid of candidate images per type, click to select one per type, and have their selections held in memory while they navigate between tabs. Downloaded images are cached locally.

## Context
- Phase 2 must be complete (scrape returns `SearchResults` with candidate URL lists).
- Selections must survive tab switching — all four types should be selectable before moving to Preview.
- The Image Picker is the most visually complex view in the app. Keep the grid clean and functional; polish comes in Phase 7.

## Work Items

1. **Implement image cache (`src/cache.rs`)**
   - Cache directory: `%APPDATA%\gsp-scraper\cache\`
   - Cache key: SHA-256 hash of the image URL, used as filename (with original extension)
   - `fn cache_path(url: &str) -> PathBuf` — returns expected cache path for a URL
   - `fn is_cached(url: &str) -> bool`
   - Create cache directory on first use if it doesn't exist

2. **Implement `download_and_cache` Tauri command**
   - Signature: `download_and_cache(url: String) -> Result<String, String>`
   - Check cache first — if hit, return existing path immediately
   - On miss: download via `reqwest`, write to cache path, return path
   - Pass ScreenScraper credentials as auth headers/params where required for image downloads
   - Return the local filesystem path (Tauri will serve local files to the WebView via asset protocol)

3. **Build Image Picker view (frontend)**
   - Four tabs: Boxart | Screenshot | Title | Menu
   - Each tab shows a grid of candidate images (thumbnails)
   - On tab open: trigger `download_and_cache` for each candidate URL in that tab's list
   - Show a loading placeholder per image slot while downloading; replace with image when ready
   - Click on any image to select it — highlight selected with a border/overlay
   - Only one selection allowed per tab
   - Tab label shows a checkmark (✓) once a selection has been made for that type
   - "Next →" button enabled only when all four tabs have a selection

4. **Selection state management (frontend)**
   - Hold selections in a JS object: `{ boxart: url|null, screenshot: url|null, title: url|null, menu: url|null }`
   - Selections persist while navigating between tabs within the same scrape session
   - Boxart and Menu tabs both draw from the same candidate list but maintain independent selections

5. **Navigation flow**
   - Main view → (after scrape) → Image Picker
   - Image Picker → (all four selected) → Preview (Phase 5 placeholder for now)
   - Image Picker → (back button) → Main view (clears session state)

6. **Add `clear_cache` Tauri command**
   - Deletes all files in `%APPDATA%\gsp-scraper\cache\`
   - Returns count of files deleted and total bytes freed
   - Expose in Settings view (wired up in Phase 7; just implement the command now)

## Acceptance Criteria
- [ ] Scraping a MAME ROM and opening the picker shows real thumbnails in each tab
- [ ] Images load progressively — placeholder shown while downloading, replaced on completion
- [ ] Selecting an image in one tab does not affect selections in other tabs
- [ ] Navigating back to a tab preserves the previous selection
- [ ] Boxart and Menu tabs each have independent selections despite sharing the same source images
- [ ] "Next" button only enables after all four tabs have a selection
- [ ] Cache directory is populated after scraping; re-scraping the same game loads from cache

## Notes
- Tauri's asset protocol (`asset://`) allows the WebView to load local files. Use `convertFileSrc()` from `@tauri-apps/api` to convert cache file paths to loadable URLs in the frontend.
- Downloading all candidates eagerly (on tab open) is fine for single-ROM mode. Lazy-load per image if performance becomes an issue.
- Don't worry about candidate count limits for now — show everything ScreenScraper returns.

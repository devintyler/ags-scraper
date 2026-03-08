# Phase 7 — Polish, Error Handling & Release Prep

## Goal
Production-quality robustness, full error coverage, cache management UI, README, and a clean portable .exe build ready to share.

## Context
- Phases 1–6 must be complete.
- This phase has no new features — it's about making everything that exists reliable and presentable.

## Work Items

### Error Handling

1. **Zero results state**
   - If scrape returns no candidates for any image type, stay on Main view
   - Show a clear message: "No results found for '{search_term}'. Try editing the search term above."
   - Search field remains editable; user can modify and re-scrape without re-picking the ROM file

2. **Auth failure**
   - ScreenScraper: detect HTTP 401 / API-level auth error response and surface "ScreenScraper login failed — check your credentials in Settings"
   - SteamGridDB: detect 401 and surface "SteamGridDB API key invalid — check your key in Settings"
   - Include a direct link to the Settings tab in both messages

3. **Network errors**
   - Timeout (set 30s on all requests): "Request timed out. Check your internet connection and try again."
   - DNS / connection failure: "Could not reach {service}. Check your internet connection."
   - Distinguish timeout from connection failure where possible

4. **Partial scrape results**
   - If ScreenScraper returns candidates for some types but not others (e.g. no wheel/logo found), allow the user to proceed with what was found
   - Tabs with no results show "No images found for this type" and are skipped in the "all selected" check
   - Still require the user to acknowledge empty tabs before proceeding to Preview

5. **Export errors**
   - Output directory not found: "Output directory does not exist. Please check the path in the main screen."
   - Permission denied: "Cannot write to {path}. Check that the directory is not read-only."
   - Disk full: detect and surface with a clear message

### UX Polish

6. **No-Intro naming hint**
   - Add a small "?" icon or "Need help with ROM names?" link next to the search field
   - Links to https://no-intro.org in the default browser via Tauri's `shell::open`
   - Add tooltip: "ROM filenames should follow No-Intro naming conventions for best results. For MAME, use the short ROM name (e.g. mspacman)."

7. **Cache management in Settings**
   - Show current cache size (sum of all files in `%APPDATA%\gsp-scraper\cache\`) in human-readable format (e.g. "42 MB")
   - "Clear Cache" button — calls `clear_cache` command, updates size display to "0 MB"
   - Cache size updates on Settings view open

8. **Window sizing**
   - Set a sensible default window size (e.g. 1000×700) in `tauri.conf.json`
   - Set minimum window size (800×600) to prevent layout breakage
   - Image Picker and Preview views should be usable at minimum size

9. **Temp file cleanup**
   - On app startup: delete all files in `%APPDATA%\gsp-scraper\temp\`
   - On "Scrape Another ROM": delete current session's temp files

10. **Loading states audit**
    - Ensure every async operation has a loading indicator (scraping, downloading, processing, exporting)
    - Ensure all buttons are disabled while their operation is in progress to prevent double-submission

### Release Prep

11. **README.md**
    - What the app does and who it's for (GSP users adding custom ROMs)
    - Download and run instructions (portable .exe, no install)
    - First-run setup: how to get ScreenScraper and SteamGridDB credentials
    - Brief usage walkthrough (pick ROM → scrape → select images → export)
    - Note on No-Intro naming for best results
    - Note on MAME short names
    - Link to ScreenScraper registration and SteamGridDB API key setup
    - Build-from-source instructions (Rust + Node prerequisites, `cargo tauri build`)
    - License

12. **License file**
    - Add `LICENSE` file — MIT recommended (permissive, compatible with open-source scraper community norms)

13. **`.gitignore`**
    - Ensure `config.toml`, `*.env`, and any file containing dev credentials is gitignored
    - Add `target/`, `node_modules/`, `dist/`

14. **Final build verification**
    - Clean build on Windows 10 (if available) and Windows 11
    - Verify portable .exe runs without installation on a machine without Rust/Node installed
    - Verify WebView2 check — Tauri should gracefully handle the rare case where WebView2 is not installed (prompt user to install it)
    - Smoke test full flow: scrape a MAME ROM, select images, export, verify files on disk

## Acceptance Criteria
- [ ] All error states from items 1–5 surface readable messages (no raw panics or API JSON shown to user)
- [ ] Zero results allows re-search without re-picking the ROM file
- [ ] Cache size shown in Settings; Clear Cache works
- [ ] No-Intro link present near search field
- [ ] Temp files cleaned on startup and session reset
- [ ] README covers setup, usage, and build-from-source
- [ ] MIT license file present
- [ ] Portable .exe runs on a clean Windows machine (no Rust/Node installed)

## Notes
- This phase is intentionally unglamorous. Resist adding new features — the goal is reliability.
- If any Phase 1–6 items have known rough edges, document them as GitHub issues rather than fixing everything here. Ship a working v1, then iterate.

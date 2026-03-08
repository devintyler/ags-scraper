# Phase 6 — ScreenScraper Integration

> **Note:** This phase was originally planned as the SteamGridDB integration. SteamGridDB was
> implemented early (Phase 2) because SS dev credentials were pending. This phase now covers
> adding ScreenScraper as a parallel source alongside the existing SteamGridDB client.

## Goal

Add ScreenScraper as a second image source. Users get boxart, screenshots, title wheels, and menu
art from ScreenScraper merged with existing SteamGridDB results. ScreenScraper is the primary
source for screenshots (SteamGridDB is never used for screenshots).

## Context

- Phases 1–5 must be complete.
- ScreenScraper API docs: https://www.screenscraper.fr/webapi2.php
- Auth: `devid` + `devpassword` (build-time env vars `SCREENSCRAPER_DEV_ID` /
  `SCREENSCRAPER_DEV_PASSWORD`) + `ssid` + `sspassword` (user credentials from config)
- MAME is the primary use case — system ID 75. SS accepts ROM shortnames (e.g. `mspacman` from
  `mspacman.zip`) and can also match by CRC hash.
- SS has much stronger arcade/MAME coverage than SteamGridDB.

## Work Items

1. **Register a ScreenScraper developer ID**
   - Register a dev account at https://www.screenscraper.fr
   - Store `SCREENSCRAPER_DEV_ID` and `SCREENSCRAPER_DEV_PASSWORD` as build-time env vars
   - Document in README

2. **Implement ScreenScraper API client (`src/screenscraper.rs`)**
   - Base URL: `https://www.screenscraper.fr/api2/`
   - Endpoint: `jeuRecherche.php`
     - Params: `devid`, `devpassword`, `ssid`, `sspassword`, `softname=gsp-scraper`,
       `output=json`, `recherche={term}`, `systemeid={id}` (omit if None)
   - Parse `jeu.medias` array; map media types:
     - `box-2D` → boxart + menu candidates
     - `ss` → screenshot candidates
     - `wheel` → title candidates
   - Each entry has `type`, `region`, `url`, `format` — return all regions, let user choose
   - `jeuNotTrouve` response → treat as zero results (not an error)

3. **Update `search_game` command**
   - Run ScreenScraper and SteamGridDB in parallel via `tokio::join!`
   - Merge per image type: SS results first, SGDB appended
   - Pass `rom_filename` (with extension) to SS; pass `search_term` to SGDB
   - Source selector on the frontend controls which APIs are called

4. **Add source selector to Main view**
   - Checkboxes: ScreenScraper / SteamGridDB (both on by default)
   - If SS checked but no credentials configured → inline warning + link to Settings
   - If SGDB checked but no API key → inline warning + link to Settings

5. **Add system selector back to Main view**
   - Now that we have a proper system list context, add a dropdown populated from a
     hardcoded list (or fetched from SS `systemesListe.php` if credentials are set)
   - Default: MAME (75)

6. **Add ScreenScraper credentials to Settings view**
   - Username + password fields already exist in the UI — ensure they are wired correctly

## Acceptance Criteria

- [ ] With both sources enabled, all four image types show merged SS + SGDB results with source badges
- [ ] Screenshots are only sourced from ScreenScraper
- [ ] `mspacman.zip` returns real boxart, screenshot, title wheel, and menu art from SS
- [ ] Auth errors for either source surface a readable message
- [ ] Disabling a source skips its API call entirely (no latency added)
- [ ] System selector defaults to MAME and persists the user's last selection

## Notes

- Run SS and SGDB requests concurrently to avoid latency stacking.
- SS returns images with region tags (us, eu, jp, ss, etc.). Don't filter by region — return all.
- SS logo images (`wheel`) map to our `title` slot throughout the codebase.
- If SS returns no results for a MAME shortname, try the search term as a fallback.

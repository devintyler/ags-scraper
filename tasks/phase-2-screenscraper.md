# Phase 2 — SteamGridDB Client & Main View

> **Note:** This phase was originally planned as the ScreenScraper client. ScreenScraper dev
> credentials were pending at the time, so SteamGridDB (which requires only a user API key) was
> implemented instead. ScreenScraper integration is now tracked in phase-6.

## What Was Built

- `src/steamgriddb.rs` — SteamGridDB API client (search, grids, logos)
- `src/commands.rs` — `search_game`, `fetch_sgdb_images` Tauri commands; `ImageCandidate`, `SearchResults`, `GameCandidate` types
- Main view UI — ROM file picker, output dir picker, editable search term, Scrape button
- `tauri-plugin-dialog` — ROM file and folder picker dialogs
- Alternative game match picker — search returns all candidates; user can click any to re-fetch images

## Key Decisions Made During Implementation

- **No dimension filter on grids** — SGDB's `?dimensions=600x900,342x482` filter produced too many
  empty results (games that exist but only have artwork in other sizes). We fetch all grids and
  resize/crop in Phase 4.
- **`rom_filename` kept separate from `search_term`** — `rom_filename` (with extension) is passed
  through for ScreenScraper and output naming; `search_term` is the user-editable API query string
  (defaults to the filename stem).
- **Output dir persistence removed** — originally planned, removed in favour of auto-filling from
  the selected ROM's directory on each session.
- **System ID field removed** — deferred until ScreenScraper integration; no one will know the
  numeric ID without a UI to look it up.

## Acceptance Criteria (met)

- [x] Picking a ROM and clicking Scrape (or pressing Enter) returns image candidates from SteamGridDB
- [x] Search field pre-fills from ROM filename stem, fully editable
- [x] Matched game name is shown; alternative matches are listed and clickable to re-fetch
- [x] Auth errors and zero-result cases surface readable messages
- [x] Output dir auto-fills from the ROM's directory

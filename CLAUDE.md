# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**GSP Scraper** — an art scraping tool for the Atari Gamestation Pro (GSP). Built with Tauri 2.x (Rust backend + vanilla HTML/CSS/TypeScript frontend). Produces a portable Windows `.exe` with no installer. Targets x86_64-pc-windows-msvc.

## Commands

All commands run from the **project root** (`ags-scraper/`), except raw `cargo` commands which run from `src-tauri/`.

```
# Run in development mode (project root)
cargo tauri dev

# Build portable .exe (project root)
cargo tauri build

# Run Rust tests only (from src-tauri/)
cd src-tauri
cargo test

# Check Rust without building
cargo check
```

> Requires: Rust (stable), Node.js (for Tauri CLI), and WebView2 on the target machine.

## Architecture

### Rust Backend (`src/`)

| File | Responsibility |
|---|---|
| `main.rs` | Tauri app entry point, command registration |
| `config.rs` | Load/save `%APPDATA%\gsp-scraper\config.toml`; DPAPI encrypt/decrypt credentials |
| `commands.rs` | All `#[tauri::command]` definitions exposed to the frontend |
| `screenscraper.rs` | ScreenScraper.fr API client (`jeuRecherche.php`, system ID 75 for MAME) |
| `steamgriddb.rs` | SteamGridDB API client (grids + logos; never screenshots) |
| `cache.rs` | Image cache at `%APPDATA%\gsp-scraper\cache\`; SHA-256 URL hash as filename |
| `image_processing.rs` | All resize/crop/pad/convert logic using the `image` crate only |

### Frontend (`ui/`)

Single-page app with four views navigated in sequence:

1. **Settings** — ScreenScraper credentials + SteamGridDB API key (saved encrypted via DPAPI)
2. **Main** — ROM file picker, output directory, search term, system ID, source selector (ScreenScraper / SteamGridDB / Both)
3. **Image Picker** — Four tabs (Boxart | Screenshot | Title | Menu), thumbnail grid, crop preset selector (Boxart/Menu only), source badges ("SS" / "SGDB")
4. **Preview** — Four columns with processed images and output filenames; Confirm & Save writes files

### Data Flow

```
ROM file selected → strip extension → search_game (Tauri command)
  → ScreenScraper jeuRecherche.php + SteamGridDB (parallel, tokio::join!)
  → SearchResults { boxart, screenshot, title, menu: Vec<ImageCandidate> }
  → Image Picker: download_and_cache per candidate URL
  → User selects image + crop preset → process_image (temp file)
  → Preview → export_images writes to output dir
```

### Config Schema (`%APPDATA%\gsp-scraper\config.toml`)

```toml
[screenscraper]
username = ""
password_enc = ""   # DPAPI blob, base64

[steamgriddb]
api_key_enc = ""    # DPAPI blob, base64

[ui]
last_output_dir = ""
```

### Image Output Rules

| Type | Size | Format | Filename |
|---|---|---|---|
| Boxart | 236×322 | PNG | `{rom}.png` |
| Screenshot | max 362×278 | JPEG q90 | `{rom}.jpg` |
| Title/Logo | 960×186 (transparent pad) | PNG | `{rom}_title.png` |
| Menu | 236×322 | PNG | `{rom}_menu.png` |

- Never scale up. Scale down only, preserving aspect ratio.
- Boxart/Menu: use Lanczos3, then apply crop preset (Top/Center/Bottom).
- Title/Logo: fit within canvas, composite centered on transparent RGBA canvas.
- Screenshots: scale down using the smaller scale factor so neither dimension exceeds the max; never crop.
- Output filenames always use the ROM filename (extension stripped), never the search term.

### Key Implementation Details

- **DPAPI**: `windows` crate — `CryptProtectData` / `CryptUnprotectData`. Gate all DPAPI code behind `#[cfg(target_os = "windows")]`. Required features: `Win32_Security_Cryptography`, `Win32_Foundation`, `Win32_System_Memory`.
- **ScreenScraper auth**: `devid` + `devpassword` (developer account, read from env vars `SCREENSCRAPER_DEV_ID` / `SCREENSCRAPER_DEV_PASSWORD` at build time) + `ssid` + `sspassword` (user's account from config). Never hardcode.
- **ScreenScraper API mapping**: `box-2D` → Boxart and Menu; `ss` → Screenshot; `wheel` → Title/Logo.
- **Cache key**: SHA-256 hash of the image URL, used as the cache filename with original extension.
- **Temp files**: Written to `%APPDATA%\gsp-scraper\temp\{hash}_{type}_{preset}.{ext}`. Cleaned on app startup and on "Scrape Another ROM".
- **Frontend asset loading**: Use `convertFileSrc()` from `@tauri-apps/api` to convert local cache/temp paths to `asset://` URLs for the WebView.
- **Overwrite check**: Before exporting, check if any of the four output files already exist and warn the user. Do not create the output directory if it doesn't exist.
- **SteamGridDB**: Grids (`dimensions=600x900,342x482`, portrait format) populate both boxart and menu (both output at 236×322); logos populate title. Never used for screenshots. Run in parallel with ScreenScraper via `tokio::join!`.

## Development Phases

Work is organized into sequential phases in `tasks/`. Each phase produces a testable deliverable:

| Phase | Task file | Status |
|---|---|---|
| 1 | `tasks/phase-1-scaffold.md` | Scaffold, config, DPAPI, Settings view |
| 2 | `tasks/phase-2-screenscraper.md` | ScreenScraper client + Main view |
| 3 | `tasks/phase-3-image-picker.md` | Image download, cache, picker UI |
| 4 | `tasks/phase-4-image-processing.md` | Resize, crop, pad, convert |
| 5 | `tasks/phase-5-preview-export.md` | Preview screen + file export |
| 6 | `tasks/phase-6-steamgriddb.md` | SteamGridDB integration |
| 7 | `tasks/phase-7-polish.md` | Error handling, polish, release |

Complete phases in order. Do not start a phase until the previous phase's acceptance criteria are met.

# GSP Scraper — Project Plan

Atari Gamestation Pro art scraping tool. Tauri 2.x (Rust backend + HTML/TS frontend), portable Windows .exe, no installer required.

## Full Reference
See `gsp-scraper-project-plan.docx` for complete architecture, data source details, image processing rules, and all technical decisions.

---

## Stack
- **Framework:** Tauri 2.x
- **Backend:** Rust (stable)
- **Frontend:** HTML / CSS / TypeScript (vanilla)
- **Image processing:** Rust `image` crate only (no ImageMagick)
- **HTTP:** Rust `reqwest` (async)
- **Config/credentials:** TOML file + Windows DPAPI encryption via `windows` crate
- **Cache:** `%APPDATA%\gsp-scraper\cache\`

## Data Sources
- **ScreenScraper.fr** (primary) — username + password auth; covers all 4 image types
  - Boxart → `box-2D`, Screenshot → `ss`, Title/Logo → `wheel`, Menu → `box-2D`
  - MAME system ID: 75; use ROM short name (extension stripped) as search term
- **SteamGridDB** (secondary, Phase 6) — API key auth; strong boxart/logo alternatives
- **LaunchBox** — deferred to v2 (no public API)

## Image Output Rules
| Type | Size | Format | Filename |
|---|---|---|---|
| Boxart | 236×322 | PNG | `{rom}.png` |
| Screenshot | max 362×278 | JPEG | `{rom}.jpg` |
| Title/Logo | 960×186 (padded) | PNG | `{rom}_title.png` |
| Menu | 236×322 | PNG | `{rom}_menu.png` |

- **Never scale up.** Scale down only, preserving aspect ratio.
- **Screenshots:** never crop, only ensure under max size.
- **Boxart/Menu:** crop preset (Top / Center / Bottom) after resize if needed.
- **Title/Logo:** fit within 960×186, composite centered on transparent canvas.

## Phases
| Phase | Goal | Task file |
|---|---|---|
| 1 | Project scaffold + config + DPAPI + Settings view | `tasks/phase-1-scaffold.md` |
| 2 | ScreenScraper API client + Main view + scrape flow | `tasks/phase-2-screenscraper.md` |
| 3 | Image download, cache, and picker grid UI | `tasks/phase-3-image-picker.md` |
| 4 | Image processing (resize, crop, convert, pad) | `tasks/phase-4-image-processing.md` |
| 5 | Preview screen + file export | `tasks/phase-5-preview-export.md` |
| 6 | SteamGridDB integration | `tasks/phase-6-steamgriddb.md` |
| 7 | Polish, error handling, README | `tasks/phase-7-polish.md` |

Work one phase at a time. Each phase builds a testable deliverable before the next begins.

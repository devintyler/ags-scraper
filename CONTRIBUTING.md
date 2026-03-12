# Contributing to AGS Scraper

## Prerequisites

- **Rust** (stable toolchain) — install via [rustup.rs](https://rustup.rs)
- **Node.js** — required for the Tauri CLI (`cargo tauri`)
- **WebView2 Runtime** — pre-installed on Windows 11; download from [Microsoft](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) if needed

## ScreenScraper Developer Credentials

The ScreenScraper integration requires a developer API account, separate from a regular user account. Reach out to the maintainer if you have any questions.

**Steps:**

1. Create a regular ScreenScraper account at [screenscraper.fr](https://www.screenscraper.fr)
2. Request developer API access via the ScreenScraper developer forum
3. Once approved, create the file `src-tauri/.cargo/config.toml` with your credentials:

```toml
# Local developer credentials for ScreenScraper API.
# Never commit this file.
[env]
SCREENSCRAPER_DEV_ID = "your-dev-id-here"
SCREENSCRAPER_DEV_PASSWORD = "your-dev-password-here"
```

4. This file is listed in `.gitignore` — **never commit it**
5. Without these env vars, `cargo check` will fail with a compile error (intentional — prevents accidental builds without credentials)

## Build Commands

Run from the **project root** (`ags-scraper/`):

```sh
# Development mode (hot-reload frontend)
cargo tauri dev

# Production build — produces a portable .exe
cargo tauri build
```

Raw Rust commands run from `src-tauri/`:

```sh
cd src-tauri

# Type-check without building
cargo check

# Run unit tests
cargo test
```

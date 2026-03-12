# AGSP Scraper

A ROM art scraping tool for the **Atari Gamestation Pro (GSP)**. Searches [ScreenScraper.fr](https://www.screenscraper.fr) and [SteamGridDB](https://www.steamgriddb.com) for boxart, screenshots, title logos, and menu art, then resizes and exports the images in the exact formats expected by the GSP.

Distributed as a single portable Windows `.exe` — no installer required.

> For end-user setup and usage, see the project wiki on GitHub.

---

## Architecture

| Layer            | Technology                         |
| ---------------- | ---------------------------------- |
| Backend          | Rust (Tauri 2.x)                   |
| Frontend         | Vanilla HTML / CSS / JavaScript    |
| HTTP             | `reqwest` (async, rustls)          |
| Image processing | `image` crate (no external tools)  |
| Credentials      | Windows DPAPI (`CryptProtectData`) |

See [CLAUDE.md](CLAUDE.md) for a detailed architecture reference, file-by-file breakdown, and image output rules.

---

## Build from Source

### Prerequisites

- **Rust** (stable) — install via [rustup.rs](https://rustup.rs)
- **Node.js** — required for the Tauri CLI (`cargo tauri`)
- **WebView2 Runtime** — pre-installed on Windows 11; download from [Microsoft](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) if needed
- **ScreenScraper developer credentials** — see [CONTRIBUTING.md](CONTRIBUTING.md) for setup

### Development mode

```sh
# From the project root (ags-scraper/)
cargo tauri dev
```

The app launches with hot-reload for frontend changes. Rust changes trigger a recompile.

### Production build

```sh
# From the project root (ags-scraper/)
cargo tauri build
```

The portable `.exe` is written to `src-tauri/target/release/agsp-scraper.exe`.

---

## License

GPL v3 — see [LICENSE](LICENSE).

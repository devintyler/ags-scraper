# Phase 1 — Project Scaffold, Config & Settings View

## Goal
A runnable Tauri 2.x app skeleton with a working Settings page that saves and loads encrypted credentials. This is the foundation every other phase builds on.

## Context
- See `PLAN.md` for stack overview and full project context.
- No scraping or image logic in this phase — config and UI shell only.
- Credentials must never be stored in plaintext. Use Windows DPAPI via the `windows` crate.

## Work Items

1. **Initialize Tauri 2.x project**
   - Run `cargo tauri init` to scaffold the project
   - Confirm target is Windows (x86_64-pc-windows-msvc)
   - Verify `cargo tauri build` produces a portable `.exe` with no installer

2. **Set up project structure**
   ```
   src/           # Rust backend
     main.rs
     config.rs    # Config load/save + DPAPI encryption
     commands.rs  # Tauri command definitions
   ui/            # Frontend
     index.html
     style.css
     app.ts       # or app.js if skipping TS build step
   tasks/
   PLAN.md
   gsp-scraper-project-plan.docx
   ```

3. **Implement config module (`src/config.rs`)**
   - Config file location: `%APPDATA%\gsp-scraper\config.toml`
   - Schema:
     ```toml
     [screenscraper]
     username = ""
     password_enc = ""   # DPAPI-encrypted blob, base64-encoded

     [steamgriddb]
     api_key_enc = ""    # DPAPI-encrypted blob, base64-encoded

     [ui]
     last_output_dir = ""
     ```
   - Functions: `load_config() -> Config`, `save_config(config: Config) -> Result<()>`
   - Create `%APPDATA%\gsp-scraper\` directory if it doesn't exist

4. **Implement DPAPI encryption helpers**
   - Use the `windows` crate (`windows::Win32::Security::Cryptography::CryptProtectData` / `CryptUnprotectData`)
   - Functions: `encrypt(plaintext: &str) -> Result<String>` (returns base64), `decrypt(blob: &str) -> Result<String>`
   - These are Windows-only — gate behind `#[cfg(target_os = "windows")]`

5. **Implement Tauri commands (`src/commands.rs`)**
   - `load_config() -> Result<ConfigView, String>` — returns config with credentials decrypted for display
   - `save_config(screenscraper_user, screenscraper_pass, steamgriddb_key, last_output_dir) -> Result<(), String>` — encrypts credentials before writing

6. **Build Settings view (frontend)**
   - Fields: ScreenScraper username, ScreenScraper password (masked), SteamGridDB API key (masked)
   - Save button — calls `save_config`, shows success/failure feedback inline
   - On load — calls `load_config` and pre-fills fields with saved values
   - Basic navigation shell: Settings tab visible (other tabs can be placeholders for now)

7. **Smoke test**
   - Enter credentials in Settings, save, close app, reopen — credentials should repopulate
   - Verify `config.toml` in `%APPDATA%\gsp-scraper\` exists and `password_enc` is not plaintext

## Acceptance Criteria
- [ ] `cargo tauri build` succeeds and produces a portable `.exe`
- [ ] Settings page loads with empty fields on first run
- [ ] Saving credentials writes an encrypted blob to `config.toml` (not plaintext)
- [ ] Reopening the app repopulates credential fields correctly
- [ ] No credentials appear in plaintext anywhere on disk

## Notes
- Keep the frontend simple in this phase — plain HTML/CSS, no framework needed.
- Don't worry about polished styling yet; functional layout is enough.
- The `windows` crate feature flags needed: `Win32_Security_Cryptography`, `Win32_Foundation`, `Win32_System_Memory`.

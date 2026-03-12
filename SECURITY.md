# Security Policy

## Supported Versions

Only the latest commit on `main` is supported. No backport fixes are made to older releases.

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Report via [GitHub Security Advisories](../../security/advisories/new) so the report stays private until a fix is available.

Include as much detail as possible: steps to reproduce, impact, and any suggested remediation.

## Scope

Issues of primary concern:

- **Credential handling** — ScreenScraper and SteamGridDB credentials are stored using Windows DPAPI. Any bypass or leak of these credentials is in scope.
- **Network requests** — outbound requests to ScreenScraper and SteamGridDB APIs. Unexpected requests to third parties or request forgery are in scope.
- **Local file access** — the Tauri asset protocol is scoped to `"**"` (all local files) to allow the WebView to display cached images. Any path that allows arbitrary local file exfiltration through the WebView is in scope.

## Known Limitations

- **ScreenScraper developer credentials** are baked into the compiled binary at build time (via `env!()` macros). They are not user credentials and are visible with a binary strings dump. The credential scrubber in `screenscraper.rs` prevents them from appearing in error messages sent to the frontend.

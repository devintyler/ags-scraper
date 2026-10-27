const { invoke, convertFileSrc } = window.__TAURI__.core;
const { open: openDialog } = window.__TAURI__.dialog;
const { openUrl } = window.__TAURI__.opener;

// ── Constants ──────────────────────────────────────────────────
// Source identifiers — must match the values sent to the Rust backend.
const SOURCE_STEAMGRIDDB = "SteamGridDB";
const SOURCE_SCREENSCRAPER = "ScreenScraper";
// Sentinel stored in pickerSession.selections when the user skips a tab.
const SELECTION_SKIP = "skip";
const SAVED_PLACEHOLDER = "Saved — paste to overwrite";
const TAB_NAMES = {
  boxart: "Boxart",
  screenshot: "Screenshot",
  title: "Title",
  menu: "Menu",
};
const TABS = ["boxart", "screenshot", "title", "menu"];

// ── Cached DOM elements ────────────────────────────────────────
const settingsBtn = document.getElementById("settings-btn");
const settingsPanel = document.getElementById("settings-panel");
const flow = document.getElementById("flow");
const romPathInput = document.getElementById("rom-path");
const outputDirInput = document.getElementById("output-dir");
const scrapeBtn = document.getElementById("scrape-btn");
const scrapeStatus = document.getElementById("scrape-status");
const scrapeResult = document.getElementById("scrape-result");
const previewActionsEl = document.querySelector(".preview-actions");

// ── Window controls ────────────────────────────────────────────
const appWindow = window.__TAURI__.window.getCurrentWindow();
const winMaxBtn = document.getElementById("win-maximize-btn");

async function syncMaxBtn() {
  winMaxBtn.title = (await appWindow.isMaximized()) ? "Restore" : "Maximize";
}

document.getElementById("win-minimize-btn").addEventListener("click", () => appWindow.minimize());
document.getElementById("win-close-btn").addEventListener("click", () => appWindow.close());
winMaxBtn.addEventListener("click", async () => {
  await appWindow.toggleMaximize();
  await syncMaxBtn();
});
document.querySelector(".app-header").addEventListener("dblclick", async (e) => {
  if (e.target.closest("button")) return;
  await appWindow.toggleMaximize();
  await syncMaxBtn();
});
syncMaxBtn();

// ── Config state (credential presence, used for inline warnings) ──
const configState = { ssCredSet: false, sgdbKeySet: false };

// ── Source toggle helpers ──────────────────────────────────────
function getSelectedSource() {
  const el = document.querySelector('input[name="source"]:checked');
  return el ? el.value : SOURCE_SCREENSCRAPER;
}

function updateSourceUI(sourceChanged = false) {
  const source = getSelectedSource();
  const isSS = source === SOURCE_SCREENSCRAPER;
  document.getElementById("system-row").style.display = isSS ? "" : "none";
  document.getElementById("search-term-row").style.display = isSS ? "none" : "";
  const ssWarn = document.getElementById("ss-cred-warning");
  const sgdbWarn = document.getElementById("sgdb-cred-warning");
  ssWarn.hidden = !(isSS && !configState.ssCredSet);
  sgdbWarn.hidden = !(!isSS && !configState.sgdbKeySet);

  const bulkWarn = document.getElementById("bulk-cred-warning");
  if (bulkWarn) {
    bulkWarn.hidden = configState.ssCredSet;
  }

  // When switching to SS, clear the search term — it's hidden in SS mode and a
  // stale value from a previous SGDB session should not silently influence SS searches.
  if (sourceChanged && isSS) {
    const termEl = document.getElementById("search-term");
    termEl.value = "";
    delete termEl.dataset.userEdited;
  }

  // When the user switches to SGDB, auto-fill the search term if it's still empty.
  if (sourceChanged && !isSS && scrapeSession.romStem) {
    const termEl = document.getElementById("search-term");
    if (!termEl.dataset.userEdited) termEl.value = scrapeSession.romStem;
  }

  if (typeof currentAppMode !== "undefined" && currentAppMode === "bulk") {
    loadScreenScraperQuota();
  }
}

function setSourceDisabled(disabled) {
  document.querySelectorAll('input[name="source"]').forEach((r) => {
    r.disabled = disabled;
  });
}

document.querySelectorAll('input[name="source"]').forEach((radio) => {
  radio.addEventListener("change", () => updateSourceUI(true));
});

document.getElementById("ss-warning-link").addEventListener("click", (e) => {
  e.preventDefault();
  openSettings();
});

document.getElementById("sgdb-warning-link").addEventListener("click", (e) => {
  e.preventDefault();
  openSettings();
});

document.getElementById("bulk-warning-link")?.addEventListener("click", (e) => {
  e.preventDefault();
  openSettings();
});

document.getElementById("no-intro-link").addEventListener("click", async (e) => {
  e.preventDefault();
  await openUrl("https://no-intro.org");
});

// Persist + restore system selection
const systemSelect = document.getElementById("system-select");
systemSelect.addEventListener("change", () => {
  localStorage.setItem("lastSystemId", systemSelect.value);
});

// Read palette colours from CSS variables so they stay in sync with the stylesheet.
const ATARI_BRIGHT = ["--atari-sky", "--atari-yellow", "--atari-pink", "--atari-red", "--atari-orange"]
  .map((v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim());
systemSelect.addEventListener("mouseenter", () => {
  const hex = ATARI_BRIGHT[Math.floor(Math.random() * ATARI_BRIGHT.length)];
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  systemSelect.style.borderColor = hex;
  systemSelect.style.boxShadow = `0 0 0 2px rgba(${r}, ${g}, ${b}, 0.2)`;
});
systemSelect.addEventListener("mouseleave", () => {
  systemSelect.style.borderColor = "";
  systemSelect.style.boxShadow = "";
});

// ── Modal Alert Dialog ─────────────────────────────────────────
function showModalAlert(title, message, confirmText = "Open Settings", onConfirm = null) {
  const modalOverlay = document.getElementById("modal-overlay");
  const titleEl = document.getElementById("modal-title");
  const msgEl = document.getElementById("modal-message");
  const confirmBtn = document.getElementById("modal-confirm-btn");
  const cancelBtn = document.getElementById("modal-cancel-btn");
  const closeBtn = document.getElementById("modal-close-x");

  titleEl.textContent = title;
  msgEl.textContent = message;
  confirmBtn.textContent = confirmText;

  function closeModal() {
    modalOverlay.classList.add("hidden");
    confirmBtn.onclick = null;
    cancelBtn.onclick = null;
    closeBtn.onclick = null;
  }

  confirmBtn.onclick = () => {
    closeModal();
    if (onConfirm) onConfirm();
  };
  cancelBtn.onclick = closeModal;
  closeBtn.onclick = closeModal;

  modalOverlay.classList.remove("hidden");
}

// ── Settings toggle ───────────────────────────────────────────
function openSettings() {
  loadCacheSize();
  settingsPanel.classList.remove("hidden");
  flow.classList.add("hidden");
  document.getElementById("mode-toggle-container")?.classList.add("hidden");
  settingsBtn.classList.add("active");
  settingsBtn.setAttribute("aria-expanded", "true");
  clearCacheStatus();
  if (!configState.ssCredSet) {
    setTimeout(() => {
      document.getElementById("ss-user")?.focus();
    }, 50);
  }
}

function closeSettings() {
  settingsPanel.classList.add("hidden");
  flow.classList.remove("hidden");
  document.getElementById("mode-toggle-container")?.classList.remove("hidden");
  settingsBtn.classList.remove("active");
  settingsBtn.setAttribute("aria-expanded", "false");
  clearCacheStatus();
  if (typeof currentAppMode !== "undefined" && currentAppMode === "bulk") {
    loadScreenScraperQuota();
  }
}

settingsBtn.addEventListener("click", () => {
  settingsPanel.classList.contains("hidden") ? openSettings() : closeSettings();
});

document
  .getElementById("settings-close-btn")
  .addEventListener("click", closeSettings);

// ── Scrape error helper ────────────────────────────────────────
function friendlyScrapeError(rawErr) {
  const s = String(rawErr);
  if (s.includes("ScreenScraper credentials not configured"))
    return 'ScreenScraper credentials not set — <a href="#" class="err-settings-link">go to Settings</a>';
  if (s.includes("SteamGridDB API key not configured"))
    return 'SteamGridDB API key not set — <a href="#" class="err-settings-link">go to Settings</a>';
  if (s.includes("ScreenScraper login failed"))
    return 'ScreenScraper login failed — <a href="#" class="err-settings-link">check credentials in Settings</a>';
  if (s.includes("SteamGridDB API key invalid"))
    return 'SteamGridDB API key invalid — <a href="#" class="err-settings-link">check key in Settings</a>';
  // Any network/HTTP error (timeout, DNS, connection refused, etc.)
  if (
    s.includes("error sending request") ||
    s.includes("timed out") ||
    s.includes("timeout")
  )
    return "Could not reach the server. Check your connection and try again.";
  return "Something went wrong. Please try again.";
}

// ── Status helper ─────────────────────────────────────────────
let statusTimer = null;
function setStatus(msg, isError) {
  const el = document.getElementById("status-msg");
  el.textContent = msg;
  el.className = isError ? "error" : "success";
  if (statusTimer) clearTimeout(statusTimer);
  if (msg) {
    statusTimer = setTimeout(() => {
      el.textContent = "";
      el.className = "";
      statusTimer = null;
    }, 4000);
  }
}

// ── Credential field helpers ──────────────────────────────────
// Credential fields never hold the real value — they're either empty (waiting
// for input) or show a placeholder indicating something is already saved.
// Saved state is tracked via data-is-saved, not the placeholder text itself.
function setCredentialField(inputEl, isSaved) {
  inputEl.value = "";
  inputEl.placeholder = isSaved
    ? SAVED_PLACEHOLDER
    : inputEl.dataset.defaultPlaceholder;
  inputEl.dataset.isSaved = isSaved ? "1" : "";
}

function credentialIsSaved(inputEl) {
  return inputEl.dataset.isSaved === "1";
}

// ── Load config on startup ────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  // Stash default placeholder text before we potentially replace it.
  for (const id of ["ss-pass", "sgdb-key"]) {
    const el = document.getElementById(id);
    el.dataset.defaultPlaceholder = el.placeholder;
  }

  // Restore retro effects preferences.
  const scanlinesToggle = document.getElementById("scanlines-toggle");
  const scanlinesEnabled = localStorage.getItem("scanlinesEnabled") !== "false";
  scanlinesToggle.checked = scanlinesEnabled;
  document.body.classList.toggle("scanlines-disabled", !scanlinesEnabled);
  scanlinesToggle.addEventListener("change", () => {
    const on = scanlinesToggle.checked;
    document.body.classList.toggle("scanlines-disabled", !on);
    localStorage.setItem("scanlinesEnabled", on);
  });

  // Restore last system selection.
  const savedSystem = localStorage.getItem("lastSystemId");
  if (savedSystem !== null) {
    const opt = systemSelect.querySelector(
      `option[value="${CSS.escape(savedSystem)}"]`,
    );
    if (opt) systemSelect.value = savedSystem;
  }

  try {
    const cfg = await invoke("load_config_cmd");
    document.getElementById("ss-user").value = cfg.screenscraper_user;
    setCredentialField(
      document.getElementById("ss-pass"),
      cfg.screenscraper_pass_set,
    );
    setCredentialField(
      document.getElementById("sgdb-key"),
      cfg.steamgriddb_key_set,
    );
    configState.ssCredSet =
      cfg.screenscraper_pass_set && cfg.screenscraper_user !== "";
    configState.sgdbKeySet = cfg.steamgriddb_key_set;
    updateClearCredBtns();
  } catch (err) {
    setStatus("Failed to load settings: " + err, true);
  }
  updateSourceUI();
  updateScrapeBtn();
  loadCacheSize();

  try {
    const version = await window.__TAURI__.app.getVersion();
    document.getElementById("app-version").textContent = "v" + version;
  } catch {
    // non-critical — leave blank if unavailable
  }
});

// ── Scrape session state ───────────────────────────────────────
// allGames:        full SGDB game list from last search (matched + alternatives)
// currentId:       SGDB game ID currently displayed
// seq:             monotonic counter — responses from stale in-flight requests are discarded
// romPath:         full path to selected ROM file
// romFilename:     full filename with extension, e.g. "asteroid.zip"
// romStem:         filename without extension, e.g. "asteroid"
// displayedResults: results object currently shown in scrapeResult (used by delegated click handlers)
const scrapeSession = {
  allGames: [],
  currentId: null,
  ssCandidates: [],
  currentSsId: null,
  exactResults: null,
  displayedResults: null,
  seq: 0,
  romPath: "",
  romFilename: "",
  romStem: "",
  ssSearchTerm: "",
};

// ── Main view — file / folder pickers ─────────────────────────
function updateScrapeBtn() {
  scrapeBtn.disabled =
    romPathInput.value.trim() === "" || outputDirInput.value.trim() === "";
}

document
  .getElementById("rom-browse-btn")
  .addEventListener("click", async () => {
    const selected = await openDialog({
      title: "Select ROM",
      multiple: false,
      filters: [
        {
          name: "Retro Game ROMs",
          extensions: [
            "a26", "a52", "a78", "nes", "sfc", "smc", "fig", "swc",
            "bin", "md", "gen", "smd", "sms", "gg", "gb", "gbc", "gba",
            "pce", "sgx", "zip", "7z", "rom", "cue", "iso", "chd", "lnx"
          ],
        },
        { name: "All Files", extensions: ["*"] },
      ],
    });
    if (!selected) return;
    const filePath = typeof selected === "string" ? selected : selected[0];
    romPathInput.value = filePath;

    // Auto-detect system from path and extension
    try {
      const detectedSystem = await invoke("auto_detect_rom_system", { path: filePath });
      if (detectedSystem !== null && detectedSystem !== undefined) {
        systemSelect.value = detectedSystem.toString();
        localStorage.setItem("lastSystemId", systemSelect.value);
      }
    } catch (_) {}

    // Auto-populate search term from filename (strip extension and dump tags).
    const basename = filePath.split(/[\\/]/).pop();
    const stem = basename.replace(/\.[^.]+$/, "");
    scrapeSession.romPath = filePath;
    scrapeSession.romFilename = basename;
    scrapeSession.romStem = stem;
    const termEl = document.getElementById("search-term");
    delete termEl.dataset.userEdited;

    // Clean tags like (USA) or [!] for search, while preserving exact filename for export
    let cleanTerm = stem.replace(/\([^)]*\)/g, "").replace(/\[[^\]]*\]/g, "").trim();
    if (cleanTerm.endsWith(", The")) {
      cleanTerm = "The " + cleanTerm.slice(0, -5).trim();
    } else if (cleanTerm.endsWith(", A")) {
      cleanTerm = "A " + cleanTerm.slice(0, -3).trim();
    }
    termEl.value = cleanTerm || stem;

    // Auto-fill output dir from the ROM's directory only if not already chosen.
    const dir = filePath.substring(0, filePath.search(/[\\/][^\\/]*$/));
    if (dir && !outputDirInput.value) outputDirInput.value = dir;

    updateScrapeBtn();
  });

document
  .getElementById("output-browse-btn")
  .addEventListener("click", async () => {
    const selected = await openDialog({ directory: true });
    if (!selected) return;
    outputDirInput.value =
      typeof selected === "string" ? selected : selected[0];
    updateScrapeBtn();
  });

// If the user manually edits the search term, mark it so auto-fill stops overwriting.
// Clearing the field does not reset the flag — pick a new ROM to re-enable auto-fill.
document.getElementById("search-term").addEventListener("input", function () {
  if (this.value !== "") this.dataset.userEdited = "1";
});

// ── Scrape result renderer ─────────────────────────────────────
function buildSsNameSearchHtml(hasMatch) {
  const heading = hasMatch
    ? "Optional: find more matches (very slow)"
    : "Search by name instead (very slow)";
  const term = escapeHtml(scrapeSession.ssSearchTerm || scrapeSession.romStem);
  return `<div class="ss-name-search">
    <div class="ss-name-search-header">${heading}</div>
    <div class="ss-name-search-row">
      <input type="text" class="ss-name-search-input" value="${term}" placeholder="Game title…" />
      <button type="button" class="ss-name-search-btn alt-match-btn">Search by name</button>
    </div>
    <div class="ss-name-search-hint">Uses one additional ScreenScraper scrape · Edit term for better results</div>
  </div>`;
}

function renderScrapeResult(results) {
  scrapeSession.displayedResults = results;
  const matched = results.matched_game;
  const source = getSelectedSource();
  const isSS = source === SOURCE_SCREENSCRAPER;
  const totalImages =
    results.boxart.length +
    results.screenshot.length +
    results.title.length +
    results.menu.length;

  const sourceLabel = isSS ? "SS" : "SGDB";

  // SGDB alternative game matches
  const sgdbAlts = scrapeSession.allGames.filter(
    (g) => g.id !== scrapeSession.currentId,
  );
  const sgdbAltHtml =
    sgdbAlts.length > 0
      ? `<div class="alt-matches">
        <span class="label-muted">Alternative matches (SGDB):</span>
        ${sgdbAlts
          .map(
            (g) =>
              `<button type="button" class="alt-match-btn" data-id="${g.id}" data-name="${escapeHtml(g.name)}">${escapeHtml(g.name)}</button>`,
          )
          .join("")}
       </div>`
      : "";

  // SS alternative game candidates — read from session so they persist across alternative selections
  const ssCandidates = scrapeSession.ssCandidates.filter(
    (c) => c.id !== scrapeSession.currentSsId,
  );
  const ssCandHtml =
    ssCandidates.length > 0
      ? `<div class="alt-matches">
        <span class="label-muted">Other matches (SS):</span>
        ${ssCandidates
          .map((g) => {
            const label = g.system_name
              ? `${escapeHtml(g.name)} [${escapeHtml(g.system_name)}]`
              : escapeHtml(g.name);
            return `<button type="button" class="alt-match-btn ss-cand-btn" data-ss-id="${escapeHtml(g.id)}" data-name="${escapeHtml(g.name)}" data-system-name="${escapeHtml(g.system_name || "")}">${label}</button>`;
          })
          .join("")}
       </div>`
      : "";

  const ssNameSearchHtml = isSS ? buildSsNameSearchHtml(!!matched) : "";

  // Previous exact match block — floats above new results when a name search or candidate pick replaced it
  const exact = scrapeSession.exactResults;
  const exactDiffers =
    exact && exact.matched_game && exact.matched_game.name !== matched?.name;
  const exactImages = exactDiffers
    ? exact.boxart.length +
      exact.screenshot.length +
      exact.title.length +
      exact.menu.length
    : 0;
  // Only show for SS — SS uses hash lookup so "exact match" has a meaningful distinction
  // from a name-search or candidate result. For SGDB, the initial result is just the
  // top-ranked guess, not an authoritative match, so there's nothing special to preserve.
  const exactBlockHtml =
    isSS && exactDiffers && exactImages > 0
      ? `<div class="exact-match-block">
        <div class="exact-match-block-label">Previous exact match</div>
        <div class="exact-match-block-body">
          <div><strong>${escapeHtml(exact.matched_game.name)}</strong> &nbsp;—&nbsp; ` +
        `Boxart: ${exact.boxart.length} &nbsp;|&nbsp; Screenshot: ${exact.screenshot.length} &nbsp;|&nbsp; ` +
        `Title: ${exact.title.length} &nbsp;|&nbsp; Menu: ${exact.menu.length}</div>
          <button type="button" class="exact-pick-btn">Pick Images →</button>
        </div>
      </div>
      <div class="new-results-label">Name search results</div>`
      : "";

  // No match — show candidates or name-search fallback
  if (!matched) {
    if (ssCandidates.length > 0) {
      scrapeResult.innerHTML =
        exactBlockHtml +
        `<div class="match-label">No exact system match — select a game:</div>` +
        ssCandHtml +
        ssNameSearchHtml;
    } else {
      const currentTerm = escapeHtml(
        document.getElementById("search-term").value.trim() || scrapeSession.romStem
      );
      scrapeResult.innerHTML =
        exactBlockHtml +
        `<div class="match-label">No results found for '${currentTerm}'. Try editing the search term above.</div>` +
        ssNameSearchHtml;
    }
    scrapeResult.className = exactBlockHtml
      ? "scrape-result"
      : "scrape-result error";
    scrapeResult.classList.remove("hidden");
    return;
  }

  if (totalImages === 0) {
    scrapeResult.innerHTML =
      exactBlockHtml +
      `<div class="match-label">Matched (${sourceLabel}): <strong>${escapeHtml(matched.name)}</strong> — no images found</div>` +
      sgdbAltHtml +
      ssCandHtml +
      ssNameSearchHtml;
    scrapeResult.className = "scrape-result error";
  } else {
    scrapeResult.innerHTML =
      exactBlockHtml +
      `<div class="match-label">Matched (${sourceLabel}): <strong>${escapeHtml(matched.name)}</strong></div>` +
      `<div>Boxart: ${results.boxart.length} &nbsp;|&nbsp; ` +
      `Screenshot: ${results.screenshot.length} &nbsp;|&nbsp; ` +
      `Title: ${results.title.length} &nbsp;|&nbsp; ` +
      `Menu: ${results.menu.length}</div>` +
      `<div class="pick-images-row"><button type="button" id="pick-images-btn">Pick Images →</button></div>` +
      sgdbAltHtml +
      ssCandHtml +
      ssNameSearchHtml;
    scrapeResult.className = "scrape-result success";
  }
  scrapeResult.classList.remove("hidden");
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── Scrape result area — single delegated handler ──────────────
// Handles: Pick Images button, exact-match pick, alt-match candidates, SS name search.
scrapeResult.addEventListener("click", async (e) => {
  // "Pick Images →" button — open picker with currently displayed results
  if (e.target.closest("#pick-images-btn")) {
    if (scrapeSession.displayedResults) openPicker(scrapeSession.displayedResults);
    return;
  }

  // "Pick Images →" button on the previous exact-match block
  if (e.target.closest(".exact-pick-btn")) {
    if (scrapeSession.exactResults) openPicker(scrapeSession.exactResults);
    return;
  }

  // Alternative game candidate buttons (SGDB or SS)
  const altBtn = e.target.closest(".alt-match-btn");
  if (altBtn) {
    // dataset.name is decoded by the HTML parser, so it holds the raw game name.
    const gameName = altBtn.dataset.name;
    const originalLabel = altBtn.textContent;
    altBtn.disabled = true;
    altBtn.textContent = "Loading…";

    try {
      if (altBtn.classList.contains("ss-cand-btn")) {
        // ScreenScraper candidate — fetch by SS game ID
        const gameId = altBtn.dataset.ssId;
        const results = await invoke("fetch_ss_images", { gameId });
        scrapeSession.currentSsId = gameId;
        if (results.matched_game && altBtn.dataset.systemName) {
          results.matched_game.name += ` [${altBtn.dataset.systemName}]`;
        }
        renderScrapeResult(results);
      } else {
        // SGDB candidate — fetch by SGDB numeric ID
        const gameId = parseInt(altBtn.dataset.id, 10);
        if (Number.isNaN(gameId)) {
          altBtn.disabled = false;
          altBtn.textContent = originalLabel;
          return;
        }
        const results = await invoke("fetch_sgdb_images", { gameId, gameName });
        scrapeSession.currentId = gameId;
        renderScrapeResult(results);
      }
    } catch (err) {
      altBtn.disabled = false;
      altBtn.textContent = originalLabel;
      setStatus("Failed to load images: " + err, true);
    }
    return;
  }

  // SS name-search button
  const nameSearchBtn = e.target.closest(".ss-name-search-btn");
  if (nameSearchBtn) {
    const container = nameSearchBtn.closest(".ss-name-search");
    const input = container?.querySelector(".ss-name-search-input");
    const searchTerm = input?.value.trim() || scrapeSession.romStem;
    if (!searchTerm) return;
    scrapeSession.ssSearchTerm = searchTerm;

    const originalLabel = nameSearchBtn.textContent;
    nameSearchBtn.disabled = true;
    nameSearchBtn.textContent = "Searching…";

    try {
      const rawSystemId = parseInt(systemSelect.value, 10);
      const results = await invoke("search_game", {
        romPath: "", // skip hash lookup — name search only
        romFilename: scrapeSession.romFilename,
        searchTerm,
        systemId: !Number.isNaN(rawSystemId) ? rawSystemId : null,
        source: SOURCE_SCREENSCRAPER,
      });
      if (results.matched_game) {
        scrapeSession.allGames = [];
        scrapeSession.currentId = null;
      }
      scrapeSession.ssCandidates = results.ss_candidates || [];
      scrapeSession.currentSsId = null;
      renderScrapeResult(results);
    } catch (err) {
      nameSearchBtn.disabled = false;
      nameSearchBtn.textContent = originalLabel;
      const msg = friendlyScrapeError(err);
      scrapeResult.innerHTML = msg;
      scrapeResult.className = "scrape-result error";
      scrapeResult.classList.remove("hidden");
    }
  }
});

// Delegated handler for settings links inside scrape error messages.
scrapeResult.addEventListener("click", (e) => {
  if (e.target.closest(".err-settings-link")) {
    e.preventDefault();
    openSettings();
  }
});

// ── Enter key triggers scrape (or SS name-search if that input is focused) ──
document.getElementById("step-0").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  if (e.target.classList.contains("ss-name-search-input")) {
    e.target
      .closest(".ss-name-search")
      ?.querySelector(".ss-name-search-btn")
      ?.click();
  } else if (!scrapeBtn.disabled) {
    scrapeBtn.click();
  }
});

// ── Main view — scrape ─────────────────────────────────────────
scrapeBtn.addEventListener("click", async () => {
  const source = getSelectedSource();
  if (source === SOURCE_SCREENSCRAPER && !configState.ssCredSet) {
    showModalAlert(
      "ScreenScraper Credentials Required",
      "ScreenScraper requires an active account to match ROMs and download box art, screenshots, and title screens. Please enter your ScreenScraper username and password in Settings to proceed.",
      "Open Settings",
      () => openSettings()
    );
    return;
  }
  if (source === SOURCE_STEAMGRIDDB && !configState.sgdbKeySet) {
    showModalAlert(
      "SteamGridDB API Key Required",
      "SteamGridDB requires an API key to scrape artwork. Please enter your SteamGridDB API key in Settings to proceed.",
      "Open Settings",
      () => openSettings()
    );
    return;
  }

  const romPath = romPathInput.value.trim();
  const termEl = document.getElementById("search-term");

  const seq = ++scrapeSession.seq;

  scrapeBtn.disabled = true;
  setSourceDisabled(true);
  scrapeStatus.textContent = "Scraping…";
  scrapeStatus.className = "scrape-spinner";
  scrapeResult.classList.add("hidden");
  scrapeResult.textContent = "";

  try {
    const romFilename = romPath.split(/[\\/]/).pop();
    const searchTerm =
      termEl.value.trim() || romFilename.replace(/\.[^.]+$/, "");
    const source = getSelectedSource();
    const rawSystemId = parseInt(systemSelect.value, 10);
    const results = await invoke("search_game", {
      romPath: scrapeSession.romPath,
      romFilename,
      searchTerm,
      systemId:
        source === SOURCE_SCREENSCRAPER && !Number.isNaN(rawSystemId)
          ? rawSystemId
          : null,
      source,
    });

    if (scrapeSession.seq !== seq) return; // stale — a newer scrape superseded this one

    if (results.matched_game) {
      scrapeSession.allGames = [
        results.matched_game,
        ...results.game_candidates,
      ];
      scrapeSession.currentId = results.matched_game.id;
    } else {
      scrapeSession.allGames = [];
      scrapeSession.currentId = null;
    }
    scrapeSession.ssCandidates = results.ss_candidates || [];
    scrapeSession.currentSsId = null;
    scrapeSession.exactResults = results.matched_game ? results : null;
    renderScrapeResult(results);

    scrapeStatus.textContent = "";
    scrapeStatus.className = "";
  } catch (err) {
    if (scrapeSession.seq !== seq) return;

    const msg = friendlyScrapeError(err);
    scrapeStatus.textContent = "";
    scrapeStatus.className = "";
    scrapeResult.innerHTML = msg;
    scrapeResult.className = "scrape-result error";
    scrapeResult.classList.remove("hidden");
  } finally {
    if (scrapeSession.seq === seq) {
      scrapeBtn.disabled = false;
      setSourceDisabled(false);
    }
  }
});

// ── Picker State ───────────────────────────────────────────────
const pickerSession = {
  results: null,
  selections: { boxart: null, screenshot: null, title: null, menu: null },
  activeTab: "boxart",
  processedPaths: { boxart: null, screenshot: null, title: null, menu: null },
  cropPresets: { boxart: "Center", menu: "Center" },
  // Per-tab monotonic counter — incremented on each process_image call so
  // stale in-flight responses (e.g. from rapid preset switching) are discarded.
  processSeq: { boxart: 0, screenshot: 0, title: 0, menu: 0 },
};

// ── Navigate helper ────────────────────────────────────────────
function navigate(step) {
  document
    .querySelectorAll(".step-content")
    .forEach((s) => s.classList.remove("active"));
  document.querySelectorAll(".step[data-step]").forEach((s) => {
    const n = parseInt(s.dataset.step, 10);
    s.classList.remove("active", "done");
    if (n < step) s.classList.add("done");
    else if (n === step) s.classList.add("active");
  });
  document.getElementById(`step-${step}`).classList.add("active");
  document.getElementById("restart-btn").classList.toggle("hidden", step === 0);
  document.getElementById("mode-toggle-container")?.classList.toggle("hidden", step !== 0);
}

async function restartApp() {
  // Invalidate any in-flight scrape so its finally block won't re-enable the button.
  scrapeSession.seq++;
  setSourceDisabled(false);
  scrapeStatus.textContent = "";
  scrapeStatus.className = "";

  await invoke("cleanup_temp_dir").catch(() => {});
  resetPickerUI();
  resetExportState();
  romPathInput.value = "";
  const termEl = document.getElementById("search-term");
  termEl.value = "";
  delete termEl.dataset.userEdited;
  scrapeResult.classList.add("hidden");
  scrapeResult.textContent = "";
  scrapeSession.allGames = [];
  scrapeSession.currentId = null;
  scrapeSession.ssCandidates = [];
  scrapeSession.currentSsId = null;
  scrapeSession.exactResults = null;
  scrapeSession.displayedResults = null;
  scrapeSession.romPath = "";
  scrapeSession.romFilename = "";
  scrapeSession.romStem = "";
  scrapeSession.ssSearchTerm = "";
  // Output dir is intentionally kept across resets — users typically scrape
  // multiple ROMs to the same folder and shouldn't have to re-select it.
  updateScrapeBtn();
  navigate(0);
}

// ── Picker functions ───────────────────────────────────────────
function resetPickerUI() {
  pickerSession.selections = {
    boxart: null,
    screenshot: null,
    title: null,
    menu: null,
  };
  pickerSession.processedPaths = {
    boxart: null,
    screenshot: null,
    title: null,
    menu: null,
  };
  pickerSession.cropPresets = { boxart: "Center", menu: "Center" };
  pickerSession.processSeq = { boxart: 0, screenshot: 0, title: 0, menu: 0 };
  pickerSession.activeTab = "boxart";
  for (const tab of TABS) {
    const grid = document.getElementById(`grid-${tab}`);
    if (grid) grid.innerHTML = "";
    const countEl = document.getElementById(`tab-count-${tab}`);
    if (countEl) countEl.textContent = "";
  }
}

function openPicker(results) {
  pickerSession.results = results;
  resetPickerUI();
  // Auto-skip tabs with no candidates
  for (const tab of TABS) {
    if (!results[tab] || results[tab].length === 0)
      pickerSession.selections[tab] = SELECTION_SKIP;
  }
  renderPickerTabs();
  navigate(1);
  activatePickerTab("boxart");
}

function renderPickerTabs() {
  let allResolved = true;
  for (const tab of TABS) {
    const isResolved = pickerSession.selections[tab] !== null;
    const isSkipped = pickerSession.selections[tab] === SELECTION_SKIP;
    if (!isResolved) allResolved = false;
    const btn = document.querySelector(`.picker-tab[data-tab="${tab}"]`);
    if (btn) {
      if (isSkipped) {
        btn.textContent = TAB_NAMES[tab] + " ⊘";
        btn.classList.remove("resolved");
        btn.classList.add("skipped");
      } else if (isResolved) {
        btn.textContent = TAB_NAMES[tab] + " ✓";
        btn.classList.add("resolved");
        btn.classList.remove("skipped");
      } else {
        btn.textContent = TAB_NAMES[tab];
        btn.classList.remove("resolved", "skipped");
      }
    }
  }
  const label = allResolved ? "Preview" : "Next Selection";
  const currentResolved =
    pickerSession.selections[pickerSession.activeTab] !== null;
  document.querySelectorAll(".picker-next-sel-btn").forEach((btn) => {
    btn.textContent = label;
    btn.disabled = !currentResolved;
  });
}

function activatePickerTab(tab) {
  pickerSession.activeTab = tab;
  renderPickerTabs();
  document.querySelectorAll(".picker-tab").forEach((b) => {
    const isActive = b.dataset.tab === tab;
    b.classList.toggle("active", isActive);
    b.setAttribute("aria-selected", isActive ? "true" : "false");
  });
  document.querySelectorAll(".tab-panel").forEach((p) => {
    p.classList.toggle("active", p.id === `tab-panel-${tab}`);
  });
  populateGrid(tab);
}

function populateGrid(tab) {
  const grid = document.getElementById(`grid-${tab}`);
  if (!grid || grid.children.length > 0) return;

  const candidates = pickerSession.results ? pickerSession.results[tab] : [];
  const countEl = document.getElementById(`tab-count-${tab}`);

  if (!candidates || candidates.length === 0) {
    grid.innerHTML =
      '<p class="grid-empty">No images available for this tab.</p>';
    if (countEl) countEl.textContent = "";
    return;
  }

  if (countEl) {
    const sources = [...new Set(candidates.map((c) => c.source))];
    const sourceLabel =
      sources.length === 1
        ? sources[0] === SOURCE_STEAMGRIDDB
          ? "SteamGridDB"
          : sources[0] === SOURCE_SCREENSCRAPER
            ? "ScreenScraper"
            : null
        : null;
    const countText = `${candidates.length} image${candidates.length !== 1 ? "s" : ""}`;
    countEl.textContent = sourceLabel ? `${countText} · ${sourceLabel}` : countText;
  }

  for (const candidate of candidates) {
    const cell = document.createElement("div");
    cell.className = "grid-cell loading";
    grid.appendChild(cell);
    downloadAndShowImage(cell, candidate.url, tab);
  }
}

async function downloadAndShowImage(cell, url, tab) {
  try {
    const localPath = await invoke("download_and_cache", { url });
    const assetUrl = convertFileSrc(localPath);
    const img = document.createElement("img");
    img.alt = "";
    img.onload = () => {
      cell.classList.remove("loading");
      cell.appendChild(img);
    };
    img.onerror = () => {
      cell.classList.remove("loading");
      cell.classList.add("load-error");
    };
    img.src = assetUrl;
    cell.addEventListener("click", () =>
      selectImage(tab, url, localPath, cell),
    );
  } catch {
    cell.classList.remove("loading");
    cell.classList.add("load-error");
  }
}

function selectImage(tab, url, localPath, cell) {
  const grid = document.getElementById(`grid-${tab}`);
  if (grid)
    grid
      .querySelectorAll(".grid-cell.selected")
      .forEach((c) => c.classList.remove("selected"));
  cell.classList.add("selected");
  pickerSession.selections[tab] = { url, localPath };
  renderPickerTabs();
}

// ── Picker tab buttons — use delegation so textContent updates don't matter ──
document.querySelector(".picker-tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".picker-tab");
  if (btn) activatePickerTab(btn.dataset.tab);
});

// ── Shared helper: jump to the next tab that hasn't been resolved ─
function advanceToNextUnresolved(fromTab) {
  const tabs = TABS;
  const start = (tabs.indexOf(fromTab) + 1) % tabs.length;
  for (let i = 0; i < tabs.length; i++) {
    const next = tabs[(start + i) % tabs.length];
    if (pickerSession.selections[next] === null) {
      activatePickerTab(next);
      return;
    }
  }
}

// ── Skip + Next Selection — delegate from step-1 section ───────
document.getElementById("step-1").addEventListener("click", (e) => {
  const skipBtn = e.target.closest(".picker-skip-btn");
  if (skipBtn) {
    const tab = skipBtn.dataset.tab;
    const grid = document.getElementById(`grid-${tab}`);
    if (grid)
      grid
        .querySelectorAll(".grid-cell.selected")
        .forEach((c) => c.classList.remove("selected"));
    pickerSession.selections[tab] = SELECTION_SKIP;
    renderPickerTabs();
    advanceToNextUnresolved(tab);
    return;
  }

  const nextSelBtn = e.target.closest(".picker-next-sel-btn");
  if (nextSelBtn) {
    const allResolved = TABS.every((t) => pickerSession.selections[t] !== null);
    if (allResolved) {
      navigate(2);
      renderPreview();
    } else {
      advanceToNextUnresolved(pickerSession.activeTab);
    }
  }
});

// ── Preview rendering ──────────────────────────────────────────
const IMAGE_TYPE_MAP = {
  boxart: "Boxart",
  screenshot: "Screenshot",
  title: "Title",
  menu: "Menu",
};
// Output pixel dimensions per type — used to size the preview container so its
// shape always matches the file that will be written.
// Note: screenshot is a maximum bounding box (output may be smaller if the
// source image was already within bounds), so the container is an upper bound.
const OUTPUT_DIMS = {
  boxart: { w: 236, h: 322 },
  screenshot: { w: 362, h: 278 },
  title: { w: 960, h: 186 },
  menu: { w: 236, h: 322 },
};

function buildPreviewCol(tab) {
  const selection = pickerSession.selections[tab];
  const isSkipped = !selection || selection === SELECTION_SKIP;
  const isPresetTab = tab === "boxart" || tab === "menu";

  const col = document.createElement("div");
  col.className = "preview-col";
  col.dataset.tab = tab;

  const label = document.createElement("div");
  label.className = "preview-col-label";
  label.textContent = TAB_NAMES[tab];
  col.appendChild(label);

  if (isSkipped) {
    const skip = document.createElement("div");
    skip.className = "preview-col-skip";
    skip.textContent = "Skipped";
    col.appendChild(skip);
    return col;
  }

  const imgWrap = document.createElement("div");
  imgWrap.className = "preview-col-img-wrap";
  const { w, h } = OUTPUT_DIMS[tab];
  imgWrap.style.width = `${w}px`;
  imgWrap.style.aspectRatio = `${w} / ${h}`;

  const spinner = document.createElement("div");
  spinner.className = "preview-col-spinner hidden";
  imgWrap.appendChild(spinner);

  const img = document.createElement("img");
  img.className = "preview-col-img hidden";
  img.id = `preview-col-img-${tab}`;
  img.alt = TAB_NAMES[tab];
  imgWrap.appendChild(img);
  col.appendChild(imgWrap);

  const dims = document.createElement("div");
  dims.id = `preview-col-dims-${tab}`;
  if (tab === "screenshot") {
    dims.className = "preview-col-dims hidden";
  } else {
    dims.className = "preview-col-dims";
    const { w, h } = OUTPUT_DIMS[tab];
    dims.textContent = `${w} × ${h}`;
  }
  col.appendChild(dims);

  if (isPresetTab) {
    const presets = document.createElement("div");
    presets.className = "preview-col-presets";
    for (const preset of ["Top", "Center", "Bottom"]) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className =
        "crop-preset-btn" +
        (preset === pickerSession.cropPresets[tab] ? " active" : "");
      btn.dataset.tab = tab;
      btn.dataset.preset = preset;
      btn.textContent = preset;
      presets.appendChild(btn);
    }
    col.appendChild(presets);
  }

  return col;
}

function renderPreview() {
  updateConfirmBtn(); // reset to disabled before processing starts
  const container = document.getElementById("preview-columns");
  container.innerHTML = "";
  for (const tab of TABS) {
    container.appendChild(buildPreviewCol(tab));
  }
  for (const tab of TABS) {
    const sel = pickerSession.selections[tab];
    if (!sel || sel === SELECTION_SKIP) continue;
    if (pickerSession.processedPaths[tab]) {
      // Re-navigating to preview — restore the already-processed image.
      restorePreviewImage(tab, pickerSession.processedPaths[tab]);
    } else {
      triggerPreviewProcess(tab);
    }
  }
}

function restorePreviewImage(tab, tempPath) {
  const imgEl = document.getElementById(`preview-col-img-${tab}`);
  const dimsEl = document.getElementById(`preview-col-dims-${tab}`);
  if (!imgEl) return;
  imgEl.onload = () => {
    imgEl.classList.remove("hidden");
    if (dimsEl && tab === "screenshot") {
      dimsEl.textContent = `${imgEl.naturalWidth} × ${imgEl.naturalHeight}`;
      dimsEl.classList.remove("hidden");
    }
  };
  imgEl.src = convertFileSrc(tempPath) + "?t=" + Date.now();
}

async function triggerPreviewProcess(tab) {
  const selection = pickerSession.selections[tab];
  if (!selection || selection === SELECTION_SKIP) return;

  const cropPreset =
    tab === "boxart" || tab === "menu" ? pickerSession.cropPresets[tab] : null;
  const col = document.querySelector(`.preview-col[data-tab="${tab}"]`);
  if (!col) return;

  const seq = ++pickerSession.processSeq[tab];
  pickerSession.processedPaths[tab] = null; // clear stale path; button disabled until new one arrives
  updateConfirmBtn();

  const spinnerEl = col.querySelector(".preview-col-spinner");
  const imgEl = document.getElementById(`preview-col-img-${tab}`);
  const dimsEl = document.getElementById(`preview-col-dims-${tab}`);
  const imgWrap = col.querySelector(".preview-col-img-wrap");

  if (spinnerEl) spinnerEl.classList.remove("hidden");
  if (imgEl) imgEl.classList.add("dimmed");
  if (dimsEl && tab === "screenshot") dimsEl.classList.add("hidden");
  imgWrap?.querySelector(".preview-col-error")?.remove();

  try {
    const tempPath = await invoke("process_image", {
      cachePath: selection.localPath,
      imageType: IMAGE_TYPE_MAP[tab],
      cropPreset,
    });
    if (pickerSession.processSeq[tab] !== seq) return; // stale — a newer call superseded this one

    pickerSession.processedPaths[tab] = tempPath;
    updateConfirmBtn();
    if (imgEl) {
      imgEl.onload = () => {
        if (spinnerEl) spinnerEl.classList.add("hidden");
        imgEl.classList.remove("hidden", "dimmed");
        if (dimsEl && tab === "screenshot") {
          dimsEl.textContent = `${imgEl.naturalWidth} × ${imgEl.naturalHeight}`;
          dimsEl.classList.remove("hidden");
        }
      };
      imgEl.onerror = () => {
        if (spinnerEl) spinnerEl.classList.add("hidden");
        imgEl.classList.add("hidden");
        imgEl.classList.remove("dimmed");
        if (imgWrap) {
          const errEl = document.createElement("span");
          errEl.className = "preview-col-error";
          errEl.textContent = "Failed to display";
          imgWrap.appendChild(errEl);
        }
      };
      imgEl.src = convertFileSrc(tempPath) + "?t=" + Date.now();
    }
  } catch (err) {
    if (pickerSession.processSeq[tab] !== seq) return;
    if (spinnerEl) spinnerEl.classList.add("hidden");
    if (imgEl) {
      imgEl.classList.add("hidden");
      imgEl.classList.remove("dimmed");
    }
    if (imgWrap) {
      const errEl = document.createElement("span");
      errEl.className = "preview-col-error";
      errEl.textContent = "Processing failed";
      imgWrap.appendChild(errEl);
    }
    updateConfirmBtn();
    console.error("[dev] process_image error detail:", err); // full error visible in DevTools; user sees generic "Processing failed" above
  }
}

// ── Preview crop preset delegation ────────────────────────────
document.getElementById("preview-columns").addEventListener("click", (e) => {
  const presetBtn = e.target.closest(".crop-preset-btn");
  if (!presetBtn) return;
  const { tab, preset } = presetBtn.dataset;
  document
    .querySelectorAll(`.preview-col[data-tab="${tab}"] .crop-preset-btn`)
    .forEach((b) => b.classList.toggle("active", b.dataset.preset === preset));
  pickerSession.cropPresets[tab] = preset;
  resetExportState();
  triggerPreviewProcess(tab);
});

// ── Export helpers ─────────────────────────────────────────────
// Captures the export payload when an overwrite conflict is detected, so the
// overwrite-confirm handler uses the same paths as the conflict check.
let pendingExport = null;

function getRomName() {
  return scrapeSession.romStem;
}

function buildExportPaths() {
  const p = pickerSession.processedPaths;
  return {
    boxart: p.boxart ?? null,
    screenshot: p.screenshot ?? null,
    title: p.title ?? null,
    menu: p.menu ?? null,
  };
}

function updateConfirmBtn() {
  const btn = document.getElementById("confirm-save-btn");
  const allReady = TABS.every((tab) => {
    const sel = pickerSession.selections[tab];
    if (!sel || sel === SELECTION_SKIP) return true; // skipped tabs don't need a path
    return pickerSession.processedPaths[tab] !== null;
  });
  btn.disabled = !allReady;
}

function showExportError(msg) {
  document.getElementById("export-status").textContent = msg;
}

function clearExportStatus() {
  document.getElementById("export-status").textContent = "";
}

function resetExportState() {
  pendingExport = null;
  document.getElementById("overwrite-warning").classList.add("hidden");
  document.getElementById("export-success").classList.add("hidden");
  previewActionsEl.classList.remove("hidden");
  clearExportStatus();
  updateConfirmBtn();
}

function showExportSuccess(outputDir) {
  document.getElementById("export-success-dir").textContent = outputDir;
  document.getElementById("export-success").classList.remove("hidden");
  previewActionsEl.classList.add("hidden");
}

async function doExport(selections, romName, outputDir) {
  try {
    const report = await invoke("export_images", {
      selections,
      romName,
      outputDir,
      overwrite: true,
    });
    const failed = report.results.filter((r) => !r.success);
    if (failed.length > 0) {
      const msgs = failed.map((r) => `${r.image_type}: ${r.error}`).join("; ");
      showExportError("Some files failed to save: " + msgs);
      previewActionsEl.classList.remove("hidden");
      updateConfirmBtn();
    } else {
      showExportSuccess(outputDir);
    }
  } catch (err) {
    showExportError("Export failed: " + err);
    previewActionsEl.classList.remove("hidden");
    updateConfirmBtn();
  }
}

// ── Preview back button ────────────────────────────────────────
document.getElementById("preview-back-btn").addEventListener("click", () => {
  invoke("cleanup_temp_dir").catch(() => {});
  pickerSession.processedPaths = {
    boxart: null,
    screenshot: null,
    title: null,
    menu: null,
  };
  pickerSession.processSeq = { boxart: 0, screenshot: 0, title: 0, menu: 0 };
  resetExportState();
  navigate(1);
  activatePickerTab(pickerSession.activeTab);
});

// ── Export — confirm & save ────────────────────────────────────
document
  .getElementById("confirm-save-btn")
  .addEventListener("click", async () => {
    const confirmBtn = document.getElementById("confirm-save-btn");
    confirmBtn.disabled = true;
    clearExportStatus();

    const romName = getRomName();
    const outputDir = outputDirInput.value.trim();
    if (!romName) {
      showExportError("No ROM file selected.");
      updateConfirmBtn();
      return;
    }
    if (!outputDir) {
      showExportError("No output directory selected.");
      updateConfirmBtn();
      return;
    }

    const selections = buildExportPaths();
    try {
      const report = await invoke("export_images", {
        selections,
        romName,
        outputDir,
        overwrite: false,
      });
      if (report.conflicts.length > 0) {
        pendingExport = { selections, romName, outputDir };
        const list = document.getElementById("overwrite-conflict-list");
        list.innerHTML = report.conflicts
          .map((p) => `<li>${escapeHtml(p)}</li>`)
          .join("");
        document.getElementById("overwrite-warning").classList.remove("hidden");
        previewActionsEl.classList.add("hidden");
      } else {
        await doExport(selections, romName, outputDir);
      }
    } catch (err) {
      showExportError("Export failed: " + err);
      updateConfirmBtn();
    }
  });

document
  .getElementById("overwrite-cancel-btn")
  .addEventListener("click", () => {
    resetExportState(); // clears pendingExport, restores .preview-actions, re-enables button
  });

document
  .getElementById("overwrite-confirm-btn")
  .addEventListener("click", async () => {
    if (!pendingExport) return;
    const { selections, romName, outputDir } = pendingExport;
    pendingExport = null;
    const overwriteBtn = document.getElementById("overwrite-confirm-btn");
    const cancelBtn = document.getElementById("overwrite-cancel-btn");
    overwriteBtn.disabled = true;
    cancelBtn.disabled = true;
    document.getElementById("overwrite-warning").classList.add("hidden");
    await doExport(selections, romName, outputDir);
    overwriteBtn.disabled = false;
    cancelBtn.disabled = false;
  });

document
  .getElementById("scrape-another-btn")
  .addEventListener("click", () => restartApp());

document
  .getElementById("restart-btn")
  .addEventListener("click", () => restartApp());

// ── Picker back button ─────────────────────────────────────────
// No temp cleanup needed here — process_image only runs from the preview step.
document.getElementById("picker-back-btn").addEventListener("click", () => {
  pickerSession.results = null;
  resetPickerUI();
  renderPickerTabs();
  navigate(0);
});

// ── Cache management ───────────────────────────────────────────
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function setCacheStatus(msg, isError) {
  const el = document.getElementById("cache-status");
  el.textContent = msg;
  el.className = msg ? (isError ? "error" : "success") : "";
}

function clearCacheStatus() {
  setCacheStatus("", false);
}

async function loadCacheSize() {
  const display = document.getElementById("cache-size-display");
  if (display) display.textContent = "…";
  try {
    const bytes = await invoke("get_cache_size");
    if (display) display.textContent = bytes === 0 ? "empty" : formatBytes(bytes);
  } catch {
    if (display) display.textContent = "";
  }
}

function setClearBtnsDisabled(disabled) {
  document.getElementById("clear-cache-btn").disabled = disabled;
  document.getElementById("clear-temp-btn").disabled = disabled;
}

document
  .getElementById("clear-cache-btn")
  .addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    setClearBtnsDisabled(true);
    try {
      const result = await invoke("clear_cache");
      const msg =
        result.files_deleted === 0
          ? "Downloaded image cache is already empty"
          : `Cleared ${result.files_deleted} file${result.files_deleted !== 1 ? "s" : ""} (${formatBytes(result.bytes_freed)} freed)`;
      setCacheStatus(msg, false);
      const sizeDisplay = document.getElementById("cache-size-display");
      if (sizeDisplay) sizeDisplay.textContent = "empty";
    } catch (err) {
      setCacheStatus("Failed to clear cache: " + err, true);
    } finally {
      setClearBtnsDisabled(false);
    }
  });

document
  .getElementById("clear-temp-btn")
  .addEventListener("click", async () => {
    setClearBtnsDisabled(true);
    // cleanup_temp_dir returns no value and silently ignores errors on the Rust
    // side, so this invoke always resolves — there is no catch path to handle.
    await invoke("cleanup_temp_dir");
    setCacheStatus("Preview temp files cleared", false);
    setClearBtnsDisabled(false);
  });

// ── Clear credentials ──────────────────────────────────────────
function updateClearCredBtns() {
  document.getElementById("clear-credentials-btn").hidden =
    !configState.ssCredSet && !configState.sgdbKeySet;
}

document.getElementById("clear-credentials-btn").addEventListener("click", async () => {
  const btn = document.getElementById("clear-credentials-btn");
  btn.disabled = true;
  try {
    if (configState.ssCredSet) {
      await invoke("clear_credentials", { target: "screenscraper" });
      document.getElementById("ss-user").value = "";
      setCredentialField(document.getElementById("ss-pass"), false);
      configState.ssCredSet = false;
    }
    if (configState.sgdbKeySet) {
      await invoke("clear_credentials", { target: "steamgriddb" });
      setCredentialField(document.getElementById("sgdb-key"), false);
      configState.sgdbKeySet = false;
    }
    updateClearCredBtns();
    updateSourceUI();
    setStatus("Credentials cleared.", false);
  } catch (err) {
    setStatus("Error: " + err, true);
  } finally {
    btn.disabled = false;
  }
});

// ── Save settings ─────────────────────────────────────────────
document.getElementById("save-btn").addEventListener("click", async () => {
  const btn = document.getElementById("save-btn");
  const passInput = document.getElementById("ss-pass");
  const keyInput = document.getElementById("sgdb-key");

  // Capture whether a new value was typed before we clear the fields.
  const passWillBeSaved =
    passInput.value !== "" || credentialIsSaved(passInput);
  const keyWillBeSaved = keyInput.value !== "" || credentialIsSaved(keyInput);

  btn.disabled = true;
  try {
    await invoke("save_config_cmd", {
      screenscraperUser: document.getElementById("ss-user").value,
      screenscraperPass: passInput.value,
      steamgriddbKey: keyInput.value,
    });
    // Clear fields immediately — plaintext should not linger in the DOM.
    setCredentialField(passInput, passWillBeSaved);
    setCredentialField(keyInput, keyWillBeSaved);
    configState.ssCredSet =
      passWillBeSaved && document.getElementById("ss-user").value !== "";
    configState.sgdbKeySet = keyWillBeSaved;
    updateClearCredBtns();
    updateSourceUI();
    setStatus("Settings saved.", false);
  } catch (err) {
    setStatus("Error: " + err, true);
  } finally {
    btn.disabled = false;
  }
});

// ── Mode Switcher & Bulk Scraping Engine ──────────────────────
const modeSingleBtn = document.getElementById("mode-single-btn");
const modeBulkBtn = document.getElementById("mode-bulk-btn");
const singleModeView = document.getElementById("single-mode-view");
const bulkModeView = document.getElementById("bulk-mode-view");
const singleStepNav = document.getElementById("single-step-nav");

let currentAppMode = "single"; // "single" | "bulk"

function setAppMode(mode) {
  if (bulkState && bulkState.isRunning) return;
  currentAppMode = mode;
  if (mode === "single") {
    modeSingleBtn.classList.add("active");
    modeBulkBtn.classList.remove("active");
    singleModeView.classList.remove("hidden");
    bulkModeView.classList.add("hidden");
    singleStepNav.classList.remove("hidden");
  } else {
    modeBulkBtn.classList.add("active");
    modeSingleBtn.classList.remove("active");
    singleModeView.classList.add("hidden");
    bulkModeView.classList.remove("hidden");
    singleStepNav.classList.add("hidden");
    loadScreenScraperQuota();
  }
}

modeSingleBtn?.addEventListener("click", () => setAppMode("single"));
modeBulkBtn?.addEventListener("click", () => setAppMode("bulk"));

// Destination radio toggle
const destAlongsideRadio = document.getElementById("dest-alongside");
const destCustomRadio = document.getElementById("dest-custom");
const bulkCustomDestRow = document.getElementById("bulk-custom-dest-row");
const bulkCustomOutputDir = document.getElementById("bulk-custom-output-dir");

function updateDestUI() {
  const isCustom = destCustomRadio.checked;
  bulkCustomDestRow.classList.toggle("hidden", !isCustom);
  if (isCustom && !bulkCustomOutputDir.value.trim()) {
    bulkStartBtn.disabled = true;
    bulkStartBtn.title = "Select output directory first";
  } else {
    bulkStartBtn.title = "";
    filterScannedRoms();
  }
}
destAlongsideRadio?.addEventListener("change", updateDestUI);
destCustomRadio?.addEventListener("change", updateDestUI);
bulkCustomOutputDir?.addEventListener("input", updateDestUI);

// Bulk scan state
const bulkState = {
  rootFolder: "",
  scannedResult: null,
  filteredRoms: [],
  isRunning: false,
  isPaused: false,
  shouldCancel: false,
  maxRequestsPerDay: 0,
  stats: { saved: 0, skipped: 0, error: 0 },
};

const bulkFolderPath = document.getElementById("bulk-folder-path");
const bulkBrowseBtn = document.getElementById("bulk-browse-btn");
const bulkRecursive = document.getElementById("bulk-recursive");
const bulkSkipExisting = document.getElementById("bulk-skip-existing");
const bulkOutputBrowseBtn = document.getElementById("bulk-output-browse-btn");
const bulkSystemFilter = document.getElementById("bulk-system-filter");
const bulkArtBoxart = document.getElementById("bulk-art-boxart");
const bulkArtScreenshot = document.getElementById("bulk-art-screenshot");
const bulkArtTitle = document.getElementById("bulk-art-title");
const bulkArtMenu = document.getElementById("bulk-art-menu");

const bulkScanSummary = document.getElementById("bulk-scan-summary");
const bulkSummaryCount = document.getElementById("bulk-summary-count");
const bulkSummaryStatus = document.getElementById("bulk-summary-status");
const bulkSystemsBadges = document.getElementById("bulk-systems-badges");

const bulkStartBtn = document.getElementById("bulk-start-btn");
const bulkPauseBtn = document.getElementById("bulk-pause-btn");
const bulkCancelBtn = document.getElementById("bulk-cancel-btn");
const bulkStatusIndicator = document.getElementById("bulk-status-indicator");

const bulkProgressSection = document.getElementById("bulk-progress-section");
const bulkProgressBar = document.getElementById("bulk-progress-bar");
const bulkCurrentItem = document.getElementById("bulk-current-item");
const bulkProgressPct = document.getElementById("bulk-progress-pct");
const statSavedCount = document.getElementById("stat-saved-count");
const statSkippedCount = document.getElementById("stat-skipped-count");
const statErrorCount = document.getElementById("stat-error-count");
const bulkLogEntries = document.getElementById("bulk-log-entries");
const bulkQuotaCard = document.getElementById("bulk-quota-card");
const bulkQuotaText = document.getElementById("bulk-quota-text");
const bulkRefreshQuotaBtn = document.getElementById("bulk-refresh-quota-btn");

function setBulkControlsDisabled(disabled) {
  if (settingsBtn) settingsBtn.disabled = disabled;
  if (modeSingleBtn) modeSingleBtn.disabled = disabled;
  if (modeBulkBtn) modeBulkBtn.disabled = disabled;
  if (bulkBrowseBtn) bulkBrowseBtn.disabled = disabled;
  if (bulkRecursive) bulkRecursive.disabled = disabled;
  if (bulkSystemFilter) bulkSystemFilter.disabled = disabled;
  if (destAlongsideRadio) destAlongsideRadio.disabled = disabled;
  if (destCustomRadio) destCustomRadio.disabled = disabled;
  if (bulkCustomOutputDir) bulkCustomOutputDir.disabled = disabled;
  if (bulkOutputBrowseBtn) bulkOutputBrowseBtn.disabled = disabled;
  if (bulkSkipExisting) bulkSkipExisting.disabled = disabled;
  if (bulkArtBoxart) bulkArtBoxart.disabled = disabled;
  if (bulkArtScreenshot) bulkArtScreenshot.disabled = disabled;
  if (bulkArtTitle) bulkArtTitle.disabled = disabled;
  if (bulkArtMenu) bulkArtMenu.disabled = disabled;
}

async function loadScreenScraperQuota() {
  if (typeof currentAppMode !== "undefined" && currentAppMode !== "bulk") return;
  const source = getSelectedSource();
  if (source !== SOURCE_SCREENSCRAPER || !configState.ssCredSet) {
    bulkQuotaCard?.classList.add("hidden");
    return;
  }
  bulkQuotaCard?.classList.remove("hidden");
  if (bulkQuotaText) {
    bulkQuotaText.textContent = "Checking quota…";
    bulkQuotaText.style.color = "var(--color-text-muted)";
  }

  try {
    const quota = await invoke("get_ss_user_quota");
    const maxRequests = Number(quota.maxRequestsPerDay ?? 0);
    const requestsToday = Number(quota.requestsToday ?? 0);
    const remaining = Number(quota.remaining ?? Math.max(0, maxRequests - requestsToday));
    const maxThreads = Number(quota.maxThreads ?? 1);
    bulkState.maxRequestsPerDay = maxRequests;

    if (maxRequests > 0) {
      bulkQuotaText.textContent = `${remaining.toLocaleString()} / ${maxRequests.toLocaleString()} requests remaining (${requestsToday.toLocaleString()} used today, max ${maxThreads} threads)`;
      if (remaining <= 0) {
        bulkQuotaText.style.color = "var(--atari-red)";
      } else if (remaining < 500) {
        bulkQuotaText.style.color = "var(--atari-yellow)";
      } else {
        bulkQuotaText.style.color = "#7ee0b8";
      }
    } else {
      bulkQuotaText.textContent = `${requestsToday.toLocaleString()} requests used today`;
      bulkQuotaText.style.color = "var(--color-text)";
    }
  } catch (err) {
    if (bulkQuotaText) {
      bulkQuotaText.textContent = `Unavailable (${err.toString()})`;
      bulkQuotaText.style.color = "var(--color-text-muted)";
    }
  }
}

bulkRefreshQuotaBtn?.addEventListener("click", () => {
  loadScreenScraperQuota();
});

function isTransientError(errStr) {
  if (!errStr) return false;
  const s = String(errStr).toLowerCase();
  return (
    s.includes("rate_limit") ||
    s.includes("transient:") ||
    s.includes("too many requests") ||
    s.includes("timed out") ||
    s.includes("timeout") ||
    s.includes("error sending request") ||
    s.includes("connection reset") ||
    s.includes("connection refused") ||
    s.includes("502 bad gateway") ||
    s.includes("503 service unavailable") ||
    s.includes("504 gateway timeout")
  );
}

// Browse bulk root folder
bulkBrowseBtn?.addEventListener("click", async () => {
  const selected = await openDialog({
    title: "Select Games Directory",
    directory: true,
  });
  if (!selected) return;
  const folder = typeof selected === "string" ? selected : selected[0];
  bulkFolderPath.value = folder;
  bulkState.rootFolder = folder;
  await triggerBulkScan();
});

// Browse custom output folder
bulkOutputBrowseBtn?.addEventListener("click", async () => {
  const selected = await openDialog({
    title: "Select Artwork Output Directory",
    directory: true,
  });
  if (!selected) return;
  bulkCustomOutputDir.value = typeof selected === "string" ? selected : selected[0];
  updateDestUI();
  if (bulkState.rootFolder) {
    await triggerBulkScan();
  }
});

bulkRecursive?.addEventListener("change", async () => {
  if (bulkState.rootFolder) await triggerBulkScan();
});

bulkSystemFilter?.addEventListener("change", () => {
  filterScannedRoms();
});

async function triggerBulkScan() {
  if (!bulkState.rootFolder) return;
  bulkStartBtn.disabled = true;
  bulkStatusIndicator.textContent = "Scanning directory…";
  bulkStatusIndicator.className = "scrape-spinner";

  try {
    const customDir = destCustomRadio.checked && bulkCustomOutputDir.value.trim() ? bulkCustomOutputDir.value.trim() : null;
    const res = await invoke("scan_rom_directory", {
      rootPath: bulkState.rootFolder,
      recursive: bulkRecursive.checked,
      customOutputDir: customDir,
    });
    bulkState.scannedResult = res;
    renderScanSummary(res);
    filterScannedRoms();
  } catch (err) {
    bulkSummaryCount.textContent = "Scan Error";
    bulkSummaryStatus.textContent = err.toString();
    bulkScanSummary.classList.remove("hidden");
  } finally {
    bulkStatusIndicator.textContent = "";
    bulkStatusIndicator.className = "";
  }
}

function renderScanSummary(res) {
  bulkScanSummary.classList.remove("hidden");
  const total = res.totalRoms ?? 0;
  const needsArt = res.needsArt ?? 0;
  const alreadyComplete = res.alreadyComplete ?? 0;
  const systemsFound = res.systemsFound ?? {};

  bulkSummaryCount.textContent = `${total.toLocaleString()} ROMs found`;
  bulkSummaryStatus.textContent = `${needsArt.toLocaleString()} needing artwork, ${alreadyComplete.toLocaleString()} complete`;

  while (bulkSystemsBadges.firstChild) {
    bulkSystemsBadges.removeChild(bulkSystemsBadges.firstChild);
  }
  for (const [sysName, count] of Object.entries(systemsFound)) {
    const pill = document.createElement("span");
    pill.className = "system-pill";
    pill.textContent = `${sysName} `;
    const countSpan = document.createElement("span");
    countSpan.className = "system-pill-count";
    countSpan.textContent = count;
    pill.appendChild(countSpan);
    bulkSystemsBadges.appendChild(pill);
  }
}

function filterScannedRoms() {
  if (!bulkState.scannedResult) {
    bulkStartBtn.disabled = true;
    return;
  }
  const allRoms = bulkState.scannedResult.roms || [];
  const selectedFilter = bulkSystemFilter.value;
  const isCustomMissing = destCustomRadio.checked && !bulkCustomOutputDir.value.trim();

  // A picked system only applies to ROMs whose system couldn't be detected;
  // detected ROMs always keep their own system.
  const overrideId = selectedFilter === "auto" ? null : parseInt(selectedFilter, 10);
  const detected = allRoms.filter((r) => r.systemId !== null && r.systemId !== undefined);
  const unknownCount = allRoms.length - detected.length;
  const roms = overrideId === null ? detected : allRoms;

  bulkState.filteredRoms = roms;
  bulkStartBtn.disabled = roms.length === 0 || isCustomMissing;

  let label = `Start Bulk Scrape (${roms.length.toLocaleString()} games`;
  if (unknownCount > 0) {
    if (overrideId === null) {
      label += `, ${unknownCount.toLocaleString()} unknown skipped`;
    } else {
      const opt = bulkSystemFilter.options[bulkSystemFilter.selectedIndex];
      label += `, ${unknownCount.toLocaleString()} unknown as ${opt ? opt.text : selectedFilter}`;
    }
  }
  bulkStartBtn.textContent = label + ")";

  if (isCustomMissing) {
    bulkStartBtn.title = "Select output directory first";
  } else {
    bulkStartBtn.title = "";
  }
}

// Logging helper
function appendBulkLog(title, badgeText, detail, badgeClass) {
  const entry = document.createElement("div");
  entry.className = "log-entry";

  const badge = document.createElement("span");
  badge.className = `log-badge ${badgeClass}`;
  badge.textContent = badgeText;

  const bodySpan = document.createElement("div");
  bodySpan.className = "log-body";

  const titleSpan = document.createElement("span");
  titleSpan.className = "log-title";
  titleSpan.textContent = title;
  bodySpan.appendChild(titleSpan);

  if (detail) {
    const detailSpan = document.createElement("span");
    detailSpan.className = "log-detail";
    detailSpan.textContent = ` \u2014 ${detail}`;
    bodySpan.appendChild(detailSpan);
  }

  entry.appendChild(badge);
  entry.appendChild(bodySpan);

  bulkLogEntries.appendChild(entry);
  bulkLogEntries.scrollTop = bulkLogEntries.scrollHeight;
}

// Bulk scrape execution
bulkStartBtn?.addEventListener("click", async () => {
  if (bulkState.isRunning) return;

  const source = getSelectedSource();
  if (source === SOURCE_SCREENSCRAPER && !configState.ssCredSet) {
    showModalAlert(
      "ScreenScraper Credentials Required",
      "ScreenScraper requires an active account to match ROMs and download box art, screenshots, and title screens. Please enter your ScreenScraper username and password in Settings to proceed.",
      "Open Settings",
      () => openSettings()
    );
    return;
  }
  if (source === SOURCE_STEAMGRIDDB && !configState.sgdbKeySet) {
    showModalAlert(
      "SteamGridDB API Key Required",
      "SteamGridDB requires an API key to scrape artwork. Please enter your SteamGridDB API key in Settings to proceed.",
      "Open Settings",
      () => openSettings()
    );
    return;
  }

  if (destCustomRadio.checked && !bulkCustomOutputDir.value.trim()) {
    showModalAlert(
      "Output Directory Required",
      "Please select an artwork output directory before starting the bulk scrape.",
      "Close",
      () => {}
    );
    return;
  }

  const roms = bulkState.filteredRoms;
  if (!roms || roms.length === 0) return;

  if (!bulkSkipExisting.checked) {
    showModalAlert(
      "Overwrite Existing Artwork?",
      "You have unchecked 'Skip existing artwork'. Any existing artwork files in the destination directories will be overwritten. Are you sure you want to proceed?",
      "Overwrite & Start",
      () => {
        runBulkScrape();
      }
    );
    return;
  }

  await runBulkScrape();
});

async function runBulkScrape() {
  const source = getSelectedSource();
  const sourceName = source === SOURCE_SCREENSCRAPER ? "ScreenScraper" : "SteamGridDB";
  const credName = source === SOURCE_SCREENSCRAPER ? "your username and password" : "your API key";
  const roms = bulkState.filteredRoms;
  if (!roms || roms.length === 0) return;

  bulkState.isRunning = true;
  bulkState.isPaused = false;
  bulkState.shouldCancel = false;
  bulkState.stats = { saved: 0, skipped: 0, error: 0 };

  statSavedCount.textContent = "0";
  statSkippedCount.textContent = "0";
  statErrorCount.textContent = "0";
  while (bulkLogEntries.firstChild) {
    bulkLogEntries.removeChild(bulkLogEntries.firstChild);
  }

  bulkProgressSection.classList.remove("hidden");
  bulkStartBtn.classList.add("hidden");
  bulkPauseBtn.classList.remove("hidden");
  bulkPauseBtn.textContent = "Pause";
  bulkCancelBtn.classList.remove("hidden");
  setBulkControlsDisabled(true);

  const useAlongside = destAlongsideRadio.checked;
  const customOut = bulkCustomOutputDir.value.trim();
  const skipExisting = bulkSkipExisting.checked;
  const saveBoxart = bulkArtBoxart.checked;
  const saveScreenshot = bulkArtScreenshot.checked;
  const saveTitle = bulkArtTitle.checked;
  const saveMenu = bulkArtMenu.checked;
  const systemOverrideVal = bulkSystemFilter.value;
  const systemOverride = systemOverrideVal !== "auto" ? parseInt(systemOverrideVal, 10) : null;

  let consecutiveErrors = 0;

  for (let i = 0; i < roms.length; i++) {
    if (bulkState.shouldCancel) break;

    while (bulkState.isPaused && !bulkState.shouldCancel) {
      bulkStatusIndicator.textContent = "Paused";
      await new Promise((r) => setTimeout(r, 200));
    }
    if (bulkState.shouldCancel) break;

    const rom = roms[i];
    const pct = Math.round(((i + 1) / roms.length) * 100);
    bulkProgressBar.style.width = `${pct}%`;
    bulkProgressPct.textContent = `${pct}%`;
    bulkCurrentItem.textContent = `[${i + 1}/${roms.length}] ${rom.filename}`;
    bulkStatusIndicator.textContent = `Processing…`;

    let outputDir = "";
    const romDirPath = rom.dirPath || "";
    const romRelPath = rom.relPath || "";
    if (useAlongside) {
      outputDir = romDirPath;
    } else {
      const relParent = romRelPath.includes("\\")
        ? romRelPath.substring(0, romRelPath.lastIndexOf("\\"))
        : (romRelPath.includes("/") ? romRelPath.substring(0, romRelPath.lastIndexOf("/")) : "");
      outputDir = relParent ? `${customOut}\\${relParent}` : customOut;
    }

    const effectiveSystemId = rom.systemId ?? systemOverride;

    const MAX_RETRIES = 3;
    let res = null;
    let finalError = null;
    let quotaHit = false;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      if (bulkState.shouldCancel) break;

      while (bulkState.isPaused && !bulkState.shouldCancel) {
        bulkStatusIndicator.textContent = "Paused";
        await new Promise((r) => setTimeout(r, 200));
      }
      if (bulkState.shouldCancel) break;

      try {
        res = await invoke("scrape_and_export_single_game", {
          req: {
            romPath: rom.path,
            romFilename: rom.filename,
            systemId: effectiveSystemId,
            source,
            outputDir,
            overwrite: !skipExisting,
            saveBoxart,
            saveScreenshot,
            saveTitle,
            saveMenu,
          },
        });

        const errorKind = res ? res.errorKind : null;
        const errText = res && res.error ? res.error : "";

        // Check if ScreenScraper daily request quota was reached
        if (errorKind === "DailyQuota" || errText.includes("DAILY_QUOTA_REACHED")) {
          quotaHit = true;
          break;
        }

        // Check if ScreenScraper auth failed
        if (errorKind === "Auth" || errText.toLowerCase().includes("login failed")) {
          break;
        }

        // Check for transient rate limit or network glitch in res.error
        if (res && !res.success && !res.skipped && (errorKind === "RateLimit" || errorKind === "Transient" || isTransientError(errText))) {
          if (attempt < MAX_RETRIES && !bulkState.shouldCancel) {
            const delaySec = attempt * 5;
            appendBulkLog(rom.filename, "RETRYING", `Transient error: ${errText || errorKind}. Retrying in ${delaySec}s (${attempt}/${MAX_RETRIES})…`, "status-retrying");
            bulkStatusIndicator.textContent = `Retrying in ${delaySec}s…`;
            await new Promise((r) => setTimeout(r, delaySec * 1000));
            continue;
          }
        }

        finalError = null;
        break;
      } catch (err) {
        finalError = err;
        const errStr = err.toString();

        if (errStr.includes("DAILY_QUOTA_REACHED")) {
          quotaHit = true;
          break;
        }

        if (errStr.toLowerCase().includes("login failed")) {
          break;
        }

        if (isTransientError(errStr) && attempt < MAX_RETRIES && !bulkState.shouldCancel) {
          const delaySec = attempt * 5;
          appendBulkLog(rom.filename, "RETRYING", `Network error: ${errStr}. Retrying in ${delaySec}s (${attempt}/${MAX_RETRIES})…`, "status-retrying");
          bulkStatusIndicator.textContent = `Retrying in ${delaySec}s…`;
          await new Promise((r) => setTimeout(r, delaySec * 1000));
          continue;
        }
        break;
      }
    }

    if (quotaHit) {
      appendBulkLog(rom.filename, "QUOTA LIMIT", "Daily request limit reached (resets 00:00 GMT). Scraping paused.", "status-quota");
      bulkState.isPaused = true;
      bulkPauseBtn.textContent = "Resume";
      bulkStatusIndicator.textContent = "Daily Quota Reached — Paused";
      loadScreenScraperQuota();
      const maxReq = bulkState.maxRequestsPerDay || 20000;
      showModalAlert(
        "ScreenScraper Daily Limit Reached",
        `ScreenScraper's daily limit has been reached. Your account allows ${maxReq.toLocaleString()} requests per day, and there is also a daily cap on ROMs it doesn't recognize. The limit resets at midnight GMT (00:00 GMT). Bulk scraping has been automatically paused. You can keep the app open and click 'Resume' tomorrow to continue right where you left off.`,
        "Got It",
        () => {}
      );
      i--;
      continue;
    }

    const isAuth = (res && (res.errorKind === "Auth" || (res.error && res.error.toLowerCase().includes("login failed")))) ||
                   (finalError && finalError.toString().toLowerCase().includes("login failed"));

    if (isAuth) {
      appendBulkLog(rom.filename, "AUTH FAILED", `${sourceName} authentication failed. Bulk scrape stopped. Check ${credName} in Settings.`, "status-error");
      bulkStatusIndicator.textContent = "Authentication Failed — Stopped";
      bulkState.shouldCancel = true;
      showModalAlert(
        "Authentication Failed",
        `${sourceName} authentication failed. Please verify ${credName} in Settings.`,
        "Open Settings",
        () => openSettings()
      );
      break;
    }

    if (res) {
      if (res.skipped) {
        consecutiveErrors = 0;
        bulkState.stats.skipped++;
        statSkippedCount.textContent = bulkState.stats.skipped.toString();
        appendBulkLog(rom.filename, "SKIPPED", "Already exists", "status-skipped");
      } else if (res.success) {
        consecutiveErrors = 0;
        bulkState.stats.saved++;
        statSavedCount.textContent = bulkState.stats.saved.toString();
        const files = res.savedFiles || [];
        const matched = res.matchedName || "";
        const typesStr = files.join(", ");
        appendBulkLog(rom.filename, "SAVED", `${matched} (${typesStr})`, "status-saved");
      } else {
        const errorKind = res.errorKind;
        if (errorKind === "NotFound" || (res.error && res.error.toLowerCase().includes("not found"))) {
          consecutiveErrors = 0;
          bulkState.stats.error++;
          statErrorCount.textContent = bulkState.stats.error.toString();
          appendBulkLog(rom.filename, "NOT FOUND", res.error || "No art", "status-warning");
        } else {
          consecutiveErrors++;
          bulkState.stats.error++;
          statErrorCount.textContent = bulkState.stats.error.toString();
          appendBulkLog(rom.filename, "ERROR", res.error || "Scrape failed", "status-error");
        }
      }
    } else if (finalError) {
      consecutiveErrors++;
      bulkState.stats.error++;
      statErrorCount.textContent = bulkState.stats.error.toString();
      appendBulkLog(rom.filename, "ERROR", finalError.toString(), "status-error");
    }

    if (consecutiveErrors >= 5) {
      appendBulkLog(rom.filename, "PAUSED", "5 consecutive errors encountered. Bulk scrape paused.", "status-retrying");
      bulkState.isPaused = true;
      bulkPauseBtn.textContent = "Resume";
      bulkStatusIndicator.textContent = "Paused (5 Consecutive Errors)";
      showModalAlert(
        "Bulk Scrape Paused",
        "Encountered 5 consecutive errors from the scraper service. Scraping has been paused. Please check your network connection or settings, then click Resume.",
        "Got It",
        () => {}
      );
      consecutiveErrors = 0;
    }

    // Pacing delay to respect API rate limits, only when a network request was made
    if (!res || !res.skipped) {
      await new Promise((r) => setTimeout(r, source === SOURCE_SCREENSCRAPER ? 350 : 250));
    }
  }

  // Finished or cancelled
  bulkState.isRunning = false;
  bulkStartBtn.classList.remove("hidden");
  bulkPauseBtn.classList.add("hidden");
  bulkCancelBtn.classList.add("hidden");
  setBulkControlsDisabled(false);

  loadScreenScraperQuota();

  if (bulkState.shouldCancel) {
    if (!bulkStatusIndicator.textContent.includes("Failed")) {
      bulkStatusIndicator.textContent = "Cancelled";
      bulkCurrentItem.textContent = "Bulk scrape was cancelled.";
    }
  } else {
    bulkStatusIndicator.textContent = "Done!";
    bulkCurrentItem.textContent = `Completed: ${bulkState.stats.saved} saved, ${bulkState.stats.skipped} skipped, ${bulkState.stats.error} missed.`;
    bulkProgressBar.style.width = "100%";
    bulkProgressPct.textContent = "100%";
  }
}

bulkPauseBtn?.addEventListener("click", () => {
  bulkState.isPaused = !bulkState.isPaused;
  bulkPauseBtn.textContent = bulkState.isPaused ? "Resume" : "Pause";
  if (!bulkState.isPaused) {
    bulkStatusIndicator.textContent = "Processing…";
  }
});

bulkCancelBtn?.addEventListener("click", () => {
  bulkState.shouldCancel = true;
  if (bulkState.isPaused) {
    bulkState.isPaused = false;
  }
  bulkStatusIndicator.textContent = "Stopping…";
});

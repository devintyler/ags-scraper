const { invoke, convertFileSrc } = window.__TAURI__.core;
const { open: openDialog } = window.__TAURI__.dialog;

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

  // When the user switches to SGDB, auto-fill the search term if it's still empty.
  if (sourceChanged && !isSS && scrapeSession.romStem) {
    const termEl = document.getElementById("search-term");
    if (!termEl.dataset.userEdited) termEl.value = scrapeSession.romStem;
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

// ── Settings toggle ───────────────────────────────────────────
function openSettings() {
  settingsPanel.classList.remove("hidden");
  flow.classList.add("hidden");
  settingsBtn.classList.add("active");
  settingsBtn.setAttribute("aria-expanded", "true");
  clearCacheStatus();
}

function closeSettings() {
  settingsPanel.classList.add("hidden");
  flow.classList.remove("hidden");
  settingsBtn.classList.remove("active");
  settingsBtn.setAttribute("aria-expanded", "false");
  clearCacheStatus();
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
    return "ScreenScraper credentials not set — go to Settings";
  if (s.includes("SteamGridDB API key not configured"))
    return "SteamGridDB API key not set — go to Settings";
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
  } catch (err) {
    setStatus("Failed to load settings: " + err, true);
  }
  updateSourceUI();
  updateScrapeBtn();
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
        { name: "ROM", extensions: ["zip", "rom", "bin", "cue", "iso"] },
      ],
    });
    if (!selected) return;
    const filePath = typeof selected === "string" ? selected : selected[0];
    romPathInput.value = filePath;

    // Auto-populate search term from filename (strip extension).
    const basename = filePath.split(/[\\/]/).pop();
    const stem = basename.replace(/\.[^.]+$/, "");
    scrapeSession.romPath = filePath;
    scrapeSession.romFilename = basename;
    scrapeSession.romStem = stem;
    const termEl = document.getElementById("search-term");
    if (!termEl.dataset.userEdited) termEl.value = stem;

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
      scrapeResult.innerHTML =
        exactBlockHtml +
        `<div class="match-label">No results found</div>` +
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
      scrapeResult.textContent = msg;
      scrapeResult.className = "scrape-result error";
      scrapeResult.classList.remove("hidden");
    }
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
    scrapeResult.textContent = msg;
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
  const basename = romPathInput.value.split(/[\\/]/).pop();
  return basename.replace(/\.[^.]+$/, "");
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
    overwriteBtn.disabled = true;
    document.getElementById("overwrite-warning").classList.add("hidden");
    await doExport(selections, romName, outputDir);
    overwriteBtn.disabled = false;
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
    updateSourceUI();
    setStatus("Settings saved.", false);
  } catch (err) {
    setStatus("Error: " + err, true);
  } finally {
    btn.disabled = false;
  }
});

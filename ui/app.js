const { invoke } = window.__TAURI__.core;

// ── Cached DOM elements ────────────────────────────────────────
const settingsBtn    = document.getElementById('settings-btn');
const settingsPanel  = document.getElementById('settings-panel');
const flow           = document.getElementById('flow');
const romPathInput   = document.getElementById('rom-path');
const outputDirInput = document.getElementById('output-dir');
const scrapeBtn      = document.getElementById('scrape-btn');
const scrapeStatus   = document.getElementById('scrape-status');
const scrapeResult   = document.getElementById('scrape-result');

// ── Settings toggle ───────────────────────────────────────────
function openSettings() {
  settingsPanel.classList.remove('hidden');
  flow.classList.add('hidden');
  settingsBtn.classList.add('active');
  settingsBtn.setAttribute('aria-expanded', 'true');
}

function closeSettings() {
  settingsPanel.classList.add('hidden');
  flow.classList.remove('hidden');
  settingsBtn.classList.remove('active');
  settingsBtn.setAttribute('aria-expanded', 'false');
}

settingsBtn.addEventListener('click', () => {
  settingsPanel.classList.contains('hidden') ? openSettings() : closeSettings();
});

document.getElementById('settings-close-btn').addEventListener('click', closeSettings);

// ── Status helper ─────────────────────────────────────────────
let statusTimer = null;
function setStatus(msg, isError) {
  const el = document.getElementById('status-msg');
  el.textContent = msg;
  el.className = isError ? 'error' : 'success';
  if (statusTimer) clearTimeout(statusTimer);
  if (msg) {
    statusTimer = setTimeout(() => {
      el.textContent = '';
      el.className = '';
      statusTimer = null;
    }, 4000);
  }
}

// ── Credential field helpers ──────────────────────────────────
// Credential fields never hold the real value — they're either empty (waiting
// for input) or show a placeholder indicating something is already saved.
// Saved state is tracked via data-is-saved, not the placeholder text itself.
const SAVED_PLACEHOLDER = 'Saved — paste to overwrite';

function setCredentialField(inputEl, isSaved) {
  inputEl.value = '';
  inputEl.placeholder = isSaved ? SAVED_PLACEHOLDER : inputEl.dataset.defaultPlaceholder;
  inputEl.dataset.isSaved = isSaved ? '1' : '';
}

function credentialIsSaved(inputEl) {
  return inputEl.dataset.isSaved === '1';
}

// ── Load config on startup ────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Stash default placeholder text before we potentially replace it.
  for (const id of ['ss-pass', 'sgdb-key']) {
    const el = document.getElementById(id);
    el.dataset.defaultPlaceholder = el.placeholder;
  }

  try {
    const cfg = await invoke('load_config_cmd');
    document.getElementById('ss-user').value = cfg.screenscraper_user;
    setCredentialField(document.getElementById('ss-pass'), cfg.screenscraper_pass_set);
    setCredentialField(document.getElementById('sgdb-key'), cfg.steamgriddb_key_set);
  } catch (err) {
    setStatus('Failed to load settings: ' + err, true);
  }
  updateScrapeBtn();
});

// ── Scrape session state ───────────────────────────────────────
// allGames:  full game list from last search (matched + alternatives)
// currentId: SGDB game ID currently displayed
// seq:       monotonic counter — responses from stale in-flight requests are discarded
const scrapeSession = { allGames: [], currentId: null, seq: 0 };

// ── Main view — file / folder pickers ─────────────────────────
function updateScrapeBtn() {
  scrapeBtn.disabled = romPathInput.value.trim() === '' || outputDirInput.value.trim() === '';
}

document.getElementById('rom-browse-btn').addEventListener('click', async () => {
  const selected = await window.__TAURI__.dialog.open({
    title: 'Select ROM',
    multiple: false,
    filters: [{ name: 'ROM', extensions: ['zip', 'rom', 'bin', 'cue', 'iso'] }],
  });
  if (!selected) return;
  const filePath = typeof selected === 'string' ? selected : selected[0];
  romPathInput.value = filePath;

  // Auto-populate search term from filename (strip extension).
  const basename = filePath.split(/[\\/]/).pop();
  const stem = basename.replace(/\.[^.]+$/, '');
  const termEl = document.getElementById('search-term');
  if (!termEl.dataset.userEdited) termEl.value = stem;

  // Auto-fill output dir from the ROM's directory only if not already chosen.
  const dir = filePath.substring(0, filePath.search(/[\\/][^\\/]*$/));
  if (dir && !outputDirInput.value) outputDirInput.value = dir;

  updateScrapeBtn();
});

document.getElementById('output-browse-btn').addEventListener('click', async () => {
  const selected = await window.__TAURI__.dialog.open({ directory: true });
  if (!selected) return;
  outputDirInput.value = typeof selected === 'string' ? selected : selected[0];
  updateScrapeBtn();
});

// If the user manually edits the search term, mark it so auto-fill stops overwriting.
document.getElementById('search-term').addEventListener('input', function () {
  this.dataset.userEdited = this.value !== '' ? '1' : '';
});

// ── Scrape result renderer ─────────────────────────────────────
function renderScrapeResult(results) {
  const matched = results.matched_game;
  const totalImages = results.boxart.length + results.title.length + results.menu.length;

  if (!matched) {
    scrapeResult.textContent = 'No results found';
    scrapeResult.className = 'scrape-result error';
    scrapeResult.classList.remove('hidden');
    return;
  }

  const alternatives = scrapeSession.allGames.filter(g => g.id !== scrapeSession.currentId);
  const altHtml = alternatives.length > 0
    ? `<div class="alt-matches">
        <span class="label-muted">Alternative matches (SGDB):</span>
        ${alternatives.map(g =>
          `<button type="button" class="alt-match-btn" data-id="${g.id}" data-name="${escapeHtml(g.name)}">${escapeHtml(g.name)}</button>`
        ).join('')}
       </div>`
    : '';

  if (totalImages === 0) {
    scrapeResult.innerHTML =
      `<div class="match-label">Matched (SGDB): <strong>${escapeHtml(matched.name)}</strong> — no images found</div>` +
      altHtml;
    scrapeResult.className = 'scrape-result error';
  } else {
    scrapeResult.innerHTML =
      `<div class="match-label">Matched (SGDB): <strong>${escapeHtml(matched.name)}</strong></div>` +
      `<div>Boxart: ${results.boxart.length} &nbsp;|&nbsp; ` +
      `Title: ${results.title.length} &nbsp;|&nbsp; ` +
      `Menu: ${results.menu.length} &nbsp;|&nbsp; ` +
      `<span class="label-muted">Screenshot: 0 (requires ScreenScraper)</span></div>` +
      altHtml;
    scrapeResult.className = 'scrape-result success';
  }
  scrapeResult.classList.remove('hidden');
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Alternative game pick ──────────────────────────────────────
scrapeResult.addEventListener('click', async (e) => {
  const btn = e.target.closest('.alt-match-btn');
  if (!btn) return;

  const gameId = parseInt(btn.dataset.id, 10);
  // dataset.name is decoded by the HTML parser, so it holds the raw game name.
  const gameName = btn.dataset.name;

  btn.disabled = true;
  btn.textContent = 'Loading…';

  try {
    const results = await invoke('fetch_sgdb_images', { gameId, gameName });
    scrapeSession.currentId = gameId;
    renderScrapeResult(results);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = gameName;
    setStatus('Failed to load images: ' + err, true);
  }
});

// ── Enter key triggers scrape ──────────────────────────────────
document.getElementById('step-0').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    if (!scrapeBtn.disabled) scrapeBtn.click();
  }
});

// ── Main view — scrape ─────────────────────────────────────────
scrapeBtn.addEventListener('click', async () => {
  const romPath = romPathInput.value.trim();
  const termEl  = document.getElementById('search-term');

  const seq = ++scrapeSession.seq;

  scrapeBtn.disabled = true;
  scrapeStatus.textContent = 'Scraping…';
  scrapeStatus.className = 'scrape-spinner';
  scrapeResult.classList.add('hidden');
  scrapeResult.textContent = '';

  try {
    const romFilename = romPath.split(/[\\/]/).pop();
    const searchTerm  = termEl.value.trim() || romFilename.replace(/\.[^.]+$/, '');
    const results = await invoke('search_game', {
      romFilename,
      searchTerm,
      systemId: null, // TODO: wire up when ScreenScraper is integrated
    });

    if (scrapeSession.seq !== seq) return; // stale — a newer scrape superseded this one

    if (results.matched_game) {
      scrapeSession.allGames  = [results.matched_game, ...results.game_candidates];
      scrapeSession.currentId = results.matched_game.id;
    } else {
      scrapeSession.allGames  = [];
      scrapeSession.currentId = null;
    }
    renderScrapeResult(results);

    scrapeStatus.textContent = '';
    scrapeStatus.className   = '';
  } catch (err) {
    if (scrapeSession.seq !== seq) return;

    let msg = String(err);
    if (msg.includes('API key not configured')) {
      msg = 'SteamGridDB API key not set — go to Settings';
    } else if (msg.includes('timed out') || msg.includes('timeout')) {
      msg = 'Request timed out. Check your connection.';
    }
    scrapeStatus.textContent = '';
    scrapeStatus.className   = '';
    scrapeResult.textContent = msg;
    scrapeResult.className   = 'scrape-result error';
    scrapeResult.classList.remove('hidden');
  } finally {
    if (scrapeSession.seq === seq) scrapeBtn.disabled = false;
  }
});

// ── Save settings ─────────────────────────────────────────────
document.getElementById('save-btn').addEventListener('click', async () => {
  const btn      = document.getElementById('save-btn');
  const passInput = document.getElementById('ss-pass');
  const keyInput  = document.getElementById('sgdb-key');

  // Capture whether a new value was typed before we clear the fields.
  const passWillBeSaved = passInput.value !== '' || credentialIsSaved(passInput);
  const keyWillBeSaved  = keyInput.value  !== '' || credentialIsSaved(keyInput);

  btn.disabled = true;
  try {
    await invoke('save_config_cmd', {
      screenscraperUser: document.getElementById('ss-user').value,
      screenscraperPass: passInput.value,
      steamgriddbKey:    keyInput.value,
    });
    // Clear fields immediately — plaintext should not linger in the DOM.
    setCredentialField(passInput, passWillBeSaved);
    setCredentialField(keyInput,  keyWillBeSaved);
    setStatus('Settings saved.', false);
  } catch (err) {
    setStatus('Error: ' + err, true);
  } finally {
    btn.disabled = false;
  }
});

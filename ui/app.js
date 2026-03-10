const { invoke, convertFileSrc } = window.__TAURI__.core;
const { open: openDialog } = window.__TAURI__.dialog;

// ── Constants ──────────────────────────────────────────────────
// Source identifiers — must match the values set in the Rust backend.
const SOURCE_STEAMGRIDDB   = 'SteamGridDB';
const SOURCE_SCREENSCRAPER = 'screenscraper';
// Sentinel stored in pickerSession.selections when the user skips a tab.
const SELECTION_SKIP = 'skip';
const SAVED_PLACEHOLDER = 'Saved — paste to overwrite';
const TAB_NAMES = { boxart: 'Boxart', screenshot: 'Screenshot', title: 'Title', menu: 'Menu' };
const TABS = ['boxart', 'screenshot', 'title', 'menu'];

// ── Cached DOM elements ────────────────────────────────────────
const settingsBtn    = document.getElementById('settings-btn');
const settingsPanel  = document.getElementById('settings-panel');
const flow           = document.getElementById('flow');
const romPathInput   = document.getElementById('rom-path');
const outputDirInput = document.getElementById('output-dir');
const scrapeBtn        = document.getElementById('scrape-btn');
const scrapeStatus     = document.getElementById('scrape-status');
const scrapeResult     = document.getElementById('scrape-result');
const previewActionsEl = document.querySelector('.preview-actions');

// ── Settings toggle ───────────────────────────────────────────
function openSettings() {
  settingsPanel.classList.remove('hidden');
  flow.classList.add('hidden');
  settingsBtn.classList.add('active');
  settingsBtn.setAttribute('aria-expanded', 'true');
  clearCacheStatus();
}

function closeSettings() {
  settingsPanel.classList.add('hidden');
  flow.classList.remove('hidden');
  settingsBtn.classList.remove('active');
  settingsBtn.setAttribute('aria-expanded', 'false');
  clearCacheStatus();
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
  const selected = await openDialog({
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
  const selected = await openDialog({ directory: true });
  if (!selected) return;
  outputDirInput.value = typeof selected === 'string' ? selected : selected[0];
  updateScrapeBtn();
});

// If the user manually edits the search term, mark it so auto-fill stops overwriting.
// Clearing the field does not reset the flag — pick a new ROM to re-enable auto-fill.
document.getElementById('search-term').addEventListener('input', function () {
  if (this.value !== '') this.dataset.userEdited = '1';
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
      altHtml +
      `<div class="pick-images-row"><button type="button" id="pick-images-btn">Pick Images →</button></div>`;
    scrapeResult.className = 'scrape-result success';
    document.getElementById('pick-images-btn').addEventListener('click', () => openPicker(results));
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
  if (Number.isNaN(gameId)) return;
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

// ── Picker State ───────────────────────────────────────────────
const pickerSession = {
  results: null,
  selections: { boxart: null, screenshot: null, title: null, menu: null },
  activeTab: 'boxart',
  processedPaths: { boxart: null, screenshot: null, title: null, menu: null },
  cropPresets: { boxart: 'Center', menu: 'Center' },
  // Per-tab monotonic counter — incremented on each process_image call so
  // stale in-flight responses (e.g. from rapid preset switching) are discarded.
  processSeq: { boxart: 0, screenshot: 0, title: 0, menu: 0 },
};

// ── Navigate helper ────────────────────────────────────────────
function navigate(step) {
  document.querySelectorAll('.step-content').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.step[data-step]').forEach(s => {
    const n = parseInt(s.dataset.step, 10);
    s.classList.remove('active', 'done');
    if (n < step) s.classList.add('done');
    else if (n === step) s.classList.add('active');
  });
  document.getElementById(`step-${step}`).classList.add('active');
}

// ── Picker functions ───────────────────────────────────────────
function resetPickerUI() {
  pickerSession.selections = { boxart: null, screenshot: null, title: null, menu: null };
  pickerSession.processedPaths = { boxart: null, screenshot: null, title: null, menu: null };
  pickerSession.cropPresets = { boxart: 'Center', menu: 'Center' };
  pickerSession.processSeq = { boxart: 0, screenshot: 0, title: 0, menu: 0 };
  pickerSession.activeTab = 'boxart';
  for (const tab of TABS) {
    const grid = document.getElementById(`grid-${tab}`);
    if (grid) grid.innerHTML = '';
    const countEl = document.getElementById(`tab-count-${tab}`);
    if (countEl) countEl.textContent = '';
  }
}

function openPicker(results) {
  pickerSession.results = results;
  resetPickerUI();
  // Auto-skip tabs with no candidates
  for (const tab of ['boxart', 'title', 'menu']) {
    if (!results[tab] || results[tab].length === 0) pickerSession.selections[tab] = SELECTION_SKIP;
  }
  renderPickerTabs();
  navigate(1);
  activatePickerTab('boxart');
}

function renderPickerTabs() {
  let allResolved = true;
  for (const tab of TABS) {
    const resolved = pickerSession.selections[tab] !== null;
    if (!resolved) allResolved = false;
    const btn = document.querySelector(`.picker-tab[data-tab="${tab}"]`);
    if (btn) {
      btn.textContent = TAB_NAMES[tab] + (resolved ? ' ✓' : '');
      btn.classList.toggle('resolved', resolved);
    }
  }
  const label = allResolved ? 'Preview' : 'Next Selection';
  const currentResolved = pickerSession.selections[pickerSession.activeTab] !== null;
  document.querySelectorAll('.picker-next-sel-btn').forEach(btn => {
    btn.textContent = label;
    btn.disabled = !currentResolved;
  });
}

function activatePickerTab(tab) {
  pickerSession.activeTab = tab;
  renderPickerTabs();
  document.querySelectorAll('.picker-tab').forEach(b => {
    const isActive = b.dataset.tab === tab;
    b.classList.toggle('active', isActive);
    b.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });
  document.querySelectorAll('.tab-panel').forEach(p => {
    p.classList.toggle('active', p.id === `tab-panel-${tab}`);
  });
  populateGrid(tab);
}

function populateGrid(tab) {
  const grid = document.getElementById(`grid-${tab}`);
  if (!grid || grid.children.length > 0) return;

  const candidates = pickerSession.results ? pickerSession.results[tab] : [];
  const countEl = document.getElementById(`tab-count-${tab}`);

  if (tab === 'screenshot' || !candidates || candidates.length === 0) {
    grid.innerHTML = '<p class="grid-empty">No images available for this tab.</p>';
    if (countEl) countEl.textContent = '';
    return;
  }

  if (countEl) countEl.textContent = `${candidates.length} image${candidates.length !== 1 ? 's' : ''}`;

  for (const candidate of candidates) {
    const cell = document.createElement('div');
    cell.className = 'grid-cell loading';
    const badge = document.createElement('span');
    badge.className = 'source-badge';
    badge.textContent = candidate.source === SOURCE_STEAMGRIDDB ? 'SGDB' : 'SS';
    cell.appendChild(badge);
    grid.appendChild(cell);
    downloadAndShowImage(cell, candidate.url, tab);
  }
}

async function downloadAndShowImage(cell, url, tab) {
  try {
    const localPath = await invoke('download_and_cache', { url });
    const assetUrl = convertFileSrc(localPath);
    const img = document.createElement('img');
    img.alt = '';
    img.onload = () => {
      cell.classList.remove('loading');
      cell.appendChild(img);
    };
    img.onerror = () => {
      cell.classList.remove('loading');
      cell.classList.add('load-error');
    };
    img.src = assetUrl;
    cell.addEventListener('click', () => selectImage(tab, url, localPath, cell));
  } catch {
    cell.classList.remove('loading');
    cell.classList.add('load-error');
  }
}

function selectImage(tab, url, localPath, cell) {
  const grid = document.getElementById(`grid-${tab}`);
  if (grid) grid.querySelectorAll('.grid-cell.selected').forEach(c => c.classList.remove('selected'));
  cell.classList.add('selected');
  pickerSession.selections[tab] = { url, localPath };
  renderPickerTabs();
}

// ── Picker tab buttons — use delegation so textContent updates don't matter ──
document.querySelector('.picker-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.picker-tab');
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
document.getElementById('step-1').addEventListener('click', (e) => {
  const skipBtn = e.target.closest('.picker-skip-btn');
  if (skipBtn) {
    const tab = skipBtn.dataset.tab;
    const grid = document.getElementById(`grid-${tab}`);
    if (grid) grid.querySelectorAll('.grid-cell.selected').forEach(c => c.classList.remove('selected'));
    pickerSession.selections[tab] = SELECTION_SKIP;
    renderPickerTabs();
    advanceToNextUnresolved(tab);
    return;
  }

  const nextSelBtn = e.target.closest('.picker-next-sel-btn');
  if (nextSelBtn) {
    const allResolved = TABS.every(
      t => pickerSession.selections[t] !== null
    );
    if (allResolved) {
      navigate(2);
      renderPreview();
    } else {
      advanceToNextUnresolved(pickerSession.activeTab);
    }
  }
});

// ── Preview rendering ──────────────────────────────────────────
const IMAGE_TYPE_MAP = { boxart: 'Boxart', screenshot: 'Screenshot', title: 'Title', menu: 'Menu' };
// Output pixel dimensions per type — used to size the preview container so its
// shape always matches the file that will be written.
// Note: screenshot is a maximum bounding box (output may be smaller if the
// source image was already within bounds), so the container is an upper bound.
const OUTPUT_DIMS = {
  boxart:     { w: 236, h: 322 },
  screenshot: { w: 362, h: 278 },
  title:      { w: 960, h: 186 },
  menu:       { w: 236, h: 322 },
};

function buildPreviewCol(tab) {
  const selection = pickerSession.selections[tab];
  const isSkipped = !selection || selection === SELECTION_SKIP;
  const isPresetTab = tab === 'boxart' || tab === 'menu';

  const col = document.createElement('div');
  col.className = 'preview-col';
  col.dataset.tab = tab;

  const label = document.createElement('div');
  label.className = 'preview-col-label';
  label.textContent = TAB_NAMES[tab];
  col.appendChild(label);

  if (isSkipped) {
    const skip = document.createElement('div');
    skip.className = 'preview-col-skip';
    skip.textContent = 'Skipped';
    col.appendChild(skip);
    return col;
  }

  const imgWrap = document.createElement('div');
  imgWrap.className = 'preview-col-img-wrap';
  const { w, h } = OUTPUT_DIMS[tab];
  imgWrap.style.width = `${w}px`;
  imgWrap.style.aspectRatio = `${w} / ${h}`;

  const spinner = document.createElement('div');
  spinner.className = 'preview-col-spinner hidden';
  imgWrap.appendChild(spinner);

  const img = document.createElement('img');
  img.className = 'preview-col-img hidden';
  img.id = `preview-col-img-${tab}`;
  img.alt = TAB_NAMES[tab];
  imgWrap.appendChild(img);
  col.appendChild(imgWrap);

  const dims = document.createElement('div');
  dims.className = 'preview-col-dims hidden';
  dims.id = `preview-col-dims-${tab}`;
  col.appendChild(dims);

  if (isPresetTab) {
    const presets = document.createElement('div');
    presets.className = 'preview-col-presets';
    for (const preset of ['Top', 'Center', 'Bottom']) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'crop-preset-btn' + (preset === pickerSession.cropPresets[tab] ? ' active' : '');
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
  const container = document.getElementById('preview-columns');
  container.innerHTML = '';
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
    imgEl.classList.remove('hidden');
    if (dimsEl) {
      dimsEl.textContent = `${imgEl.naturalWidth} × ${imgEl.naturalHeight}`;
      dimsEl.classList.remove('hidden');
    }
  };
  imgEl.src = convertFileSrc(tempPath) + '?t=' + Date.now();
}

async function triggerPreviewProcess(tab) {
  const selection = pickerSession.selections[tab];
  if (!selection || selection === SELECTION_SKIP) return;

  const cropPreset = (tab === 'boxart' || tab === 'menu') ? pickerSession.cropPresets[tab] : null;
  const col = document.querySelector(`.preview-col[data-tab="${tab}"]`);
  if (!col) return;

  const seq = ++pickerSession.processSeq[tab];
  pickerSession.processedPaths[tab] = null; // clear stale path; button disabled until new one arrives
  updateConfirmBtn();

  const spinnerEl = col.querySelector('.preview-col-spinner');
  const imgEl = document.getElementById(`preview-col-img-${tab}`);
  const dimsEl = document.getElementById(`preview-col-dims-${tab}`);
  const imgWrap = col.querySelector('.preview-col-img-wrap');

  if (spinnerEl) spinnerEl.classList.remove('hidden');
  if (imgEl) imgEl.classList.add('dimmed');
  if (dimsEl) dimsEl.classList.add('hidden');
  imgWrap?.querySelector('.preview-col-error')?.remove();

  try {
    const tempPath = await invoke('process_image', {
      cachePath: selection.localPath,
      imageType: IMAGE_TYPE_MAP[tab],
      cropPreset,
    });
    if (pickerSession.processSeq[tab] !== seq) return; // stale — a newer call superseded this one

    pickerSession.processedPaths[tab] = tempPath;
    updateConfirmBtn();
    if (imgEl) {
      imgEl.onload = () => {
        if (spinnerEl) spinnerEl.classList.add('hidden');
        imgEl.classList.remove('hidden', 'dimmed');
        if (dimsEl) {
          dimsEl.textContent = `${imgEl.naturalWidth} × ${imgEl.naturalHeight}`;
          dimsEl.classList.remove('hidden');
        }
      };
      imgEl.onerror = () => {
        if (spinnerEl) spinnerEl.classList.add('hidden');
        imgEl.classList.add('hidden');
        imgEl.classList.remove('dimmed');
        if (imgWrap) {
          const errEl = document.createElement('span');
          errEl.className = 'preview-col-error';
          errEl.textContent = 'Failed to display';
          imgWrap.appendChild(errEl);
        }
      };
      imgEl.src = convertFileSrc(tempPath) + '?t=' + Date.now();
    }
  } catch (err) {
    if (pickerSession.processSeq[tab] !== seq) return;
    if (spinnerEl) spinnerEl.classList.add('hidden');
    if (imgEl) {
      imgEl.classList.add('hidden');
      imgEl.classList.remove('dimmed');
    }
    if (imgWrap) {
      const errEl = document.createElement('span');
      errEl.className = 'preview-col-error';
      errEl.textContent = 'Processing failed';
      imgWrap.appendChild(errEl);
    }
    updateConfirmBtn();
    console.error('process_image failed:', err);
  }
}

// ── Preview crop preset delegation ────────────────────────────
document.getElementById('preview-columns').addEventListener('click', (e) => {
  const presetBtn = e.target.closest('.crop-preset-btn');
  if (!presetBtn) return;
  const { tab, preset } = presetBtn.dataset;
  document.querySelectorAll(`.preview-col[data-tab="${tab}"] .crop-preset-btn`)
    .forEach(b => b.classList.toggle('active', b.dataset.preset === preset));
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
  return basename.replace(/\.[^.]+$/, '');
}

function buildExportPaths() {
  const p = pickerSession.processedPaths;
  return {
    boxart:     p.boxart      ?? null,
    screenshot: p.screenshot  ?? null,
    title:      p.title       ?? null,
    menu:       p.menu        ?? null,
  };
}

function updateConfirmBtn() {
  const btn = document.getElementById('confirm-save-btn');
  const allReady = TABS.every(tab => {
    const sel = pickerSession.selections[tab];
    if (!sel || sel === SELECTION_SKIP) return true; // skipped tabs don't need a path
    return pickerSession.processedPaths[tab] !== null;
  });
  btn.disabled = !allReady;
}

function showExportError(msg) {
  document.getElementById('export-status').textContent = msg;
}

function clearExportStatus() {
  document.getElementById('export-status').textContent = '';
}

function resetExportState() {
  pendingExport = null;
  document.getElementById('overwrite-warning').classList.add('hidden');
  document.getElementById('export-success').classList.add('hidden');
  previewActionsEl.classList.remove('hidden');
  clearExportStatus();
  updateConfirmBtn();
}

function showExportSuccess(outputDir) {
  document.getElementById('export-success-dir').textContent = outputDir;
  document.getElementById('export-success').classList.remove('hidden');
  previewActionsEl.classList.add('hidden');
}

async function doExport(selections, romName, outputDir) {
  try {
    const report = await invoke('export_images', { selections, romName, outputDir, overwrite: true });
    const failed = report.results.filter(r => !r.success);
    if (failed.length > 0) {
      const msgs = failed.map(r => `${r.image_type}: ${r.error}`).join('; ');
      showExportError('Some files failed to save: ' + msgs);
      previewActionsEl.classList.remove('hidden');
      updateConfirmBtn();
    } else {
      showExportSuccess(outputDir);
    }
  } catch (err) {
    showExportError('Export failed: ' + err);
    previewActionsEl.classList.remove('hidden');
    updateConfirmBtn();
  }
}

// ── Preview back button ────────────────────────────────────────
document.getElementById('preview-back-btn').addEventListener('click', () => {
  invoke('cleanup_temp_dir').catch(() => {});
  pickerSession.processedPaths = { boxart: null, screenshot: null, title: null, menu: null };
  pickerSession.processSeq = { boxart: 0, screenshot: 0, title: 0, menu: 0 };
  resetExportState();
  navigate(1);
  activatePickerTab(pickerSession.activeTab);
});

// ── Export — confirm & save ────────────────────────────────────
document.getElementById('confirm-save-btn').addEventListener('click', async () => {
  const confirmBtn = document.getElementById('confirm-save-btn');
  confirmBtn.disabled = true;
  clearExportStatus();

  const romName = getRomName();
  const outputDir = outputDirInput.value.trim();
  if (!romName) { showExportError('No ROM file selected.'); updateConfirmBtn(); return; }
  if (!outputDir) { showExportError('No output directory selected.'); updateConfirmBtn(); return; }

  const selections = buildExportPaths();
  try {
    const report = await invoke('export_images', { selections, romName, outputDir, overwrite: false });
    if (report.conflicts.length > 0) {
      pendingExport = { selections, romName, outputDir };
      const list = document.getElementById('overwrite-conflict-list');
      list.innerHTML = report.conflicts.map(p => `<li>${escapeHtml(p)}</li>`).join('');
      document.getElementById('overwrite-warning').classList.remove('hidden');
      previewActionsEl.classList.add('hidden');
    } else {
      await doExport(selections, romName, outputDir);
    }
  } catch (err) {
    showExportError('Export failed: ' + err);
    updateConfirmBtn();
  }
});

document.getElementById('overwrite-cancel-btn').addEventListener('click', () => {
  resetExportState(); // clears pendingExport, restores .preview-actions, re-enables button
});

document.getElementById('overwrite-confirm-btn').addEventListener('click', async () => {
  if (!pendingExport) return;
  const { selections, romName, outputDir } = pendingExport;
  pendingExport = null;
  const overwriteBtn = document.getElementById('overwrite-confirm-btn');
  overwriteBtn.disabled = true;
  document.getElementById('overwrite-warning').classList.add('hidden');
  await doExport(selections, romName, outputDir);
  overwriteBtn.disabled = false;
});

document.getElementById('scrape-another-btn').addEventListener('click', async () => {
  await invoke('cleanup_temp_dir').catch(() => {});
  resetPickerUI();
  resetExportState();
  // Reset scrape form (output dir is intentionally kept for the next scrape)
  romPathInput.value = '';
  const termEl = document.getElementById('search-term');
  termEl.value = '';
  delete termEl.dataset.userEdited;
  scrapeResult.classList.add('hidden');
  scrapeResult.textContent = '';
  scrapeSession.allGames = [];
  scrapeSession.currentId = null;
  updateScrapeBtn();
  navigate(0);
});

// ── Picker back button ─────────────────────────────────────────
document.getElementById('picker-back-btn').addEventListener('click', () => {
  invoke('cleanup_temp_dir').catch(() => {});
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
  const el = document.getElementById('cache-status');
  el.textContent = msg;
  el.className = msg ? (isError ? 'error' : 'success') : '';
}

function clearCacheStatus() {
  setCacheStatus('', false);
}

function setClearBtnsDisabled(disabled) {
  document.getElementById('clear-cache-btn').disabled = disabled;
  document.getElementById('clear-temp-btn').disabled = disabled;
}

document.getElementById('clear-cache-btn').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  setClearBtnsDisabled(true);
  try {
    const result = await invoke('clear_cache');
    const msg = result.files_deleted === 0
      ? 'Downloaded image cache is already empty'
      : `Cleared ${result.files_deleted} file${result.files_deleted !== 1 ? 's' : ''} (${formatBytes(result.bytes_freed)} freed)`;
    setCacheStatus(msg, false);
  } catch (err) {
    setCacheStatus('Failed to clear cache: ' + err, true);
  } finally {
    setClearBtnsDisabled(false);
  }
});

document.getElementById('clear-temp-btn').addEventListener('click', async () => {
  setClearBtnsDisabled(true);
  // cleanup_temp_dir returns no value and silently ignores errors on the Rust
  // side, so this invoke always resolves — there is no catch path to handle.
  await invoke('cleanup_temp_dir');
  setCacheStatus('Preview temp files cleared', false);
  setClearBtnsDisabled(false);
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

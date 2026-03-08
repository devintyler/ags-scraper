const { invoke } = window.__TAURI__.core;

// ── Settings toggle ───────────────────────────────────────────
const settingsBtn = document.getElementById('settings-btn');
const settingsPanel = document.getElementById('settings-panel');
const flow = document.getElementById('flow');

function openSettings() {
  settingsPanel.classList.remove('hidden');
  flow.style.display = 'none';
  settingsBtn.classList.add('active');
}

function closeSettings() {
  settingsPanel.classList.add('hidden');
  flow.style.display = '';
  settingsBtn.classList.remove('active');
}

settingsBtn.addEventListener('click', () => {
  settingsPanel.classList.contains('hidden') ? openSettings() : closeSettings();
});

document.getElementById('settings-close-btn').addEventListener('click', closeSettings);

// ── Status helper ─────────────────────────────────────────────
function setStatus(msg, isError) {
  const el = document.getElementById('status-msg');
  el.textContent = msg;
  el.className = isError ? 'error' : 'success';
  if (msg) {
    setTimeout(() => { el.textContent = ''; el.className = ''; }, 4000);
  }
}

// ── Credential field helpers ──────────────────────────────────
// Credential fields never hold the real value — they're either empty (waiting
// for input) or show a placeholder indicating something is already saved.
const SAVED_PLACEHOLDER = 'Saved — paste to overwrite';

function setCredentialField(inputEl, isSaved) {
  inputEl.value = '';
  inputEl.placeholder = isSaved ? SAVED_PLACEHOLDER : inputEl.dataset.defaultPlaceholder;
}

function credentialIsSaved(inputEl) {
  return inputEl.placeholder === SAVED_PLACEHOLDER;
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
});

// ── Save settings ─────────────────────────────────────────────
document.getElementById('save-btn').addEventListener('click', async () => {
  const btn = document.getElementById('save-btn');
  const passInput = document.getElementById('ss-pass');
  const keyInput = document.getElementById('sgdb-key');

  // Capture whether a new value was typed before we clear the fields.
  const passWillBeSaved = passInput.value !== '' || credentialIsSaved(passInput);
  const keyWillBeSaved = keyInput.value !== '' || credentialIsSaved(keyInput);

  btn.disabled = true;
  try {
    await invoke('save_config_cmd', {
      screenscraperUser: document.getElementById('ss-user').value,
      screenscraperPass: passInput.value,
      steamgriddbKey: keyInput.value,
    });
    // Clear fields immediately — plaintext should not linger in the DOM.
    setCredentialField(passInput, passWillBeSaved);
    setCredentialField(keyInput, keyWillBeSaved);
    setStatus('Settings saved.', false);
  } catch (err) {
    setStatus('Error: ' + err, true);
  } finally {
    btn.disabled = false;
  }
});

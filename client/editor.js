/**
 * editor.js — Sequence Auto Editor
 * Manages transcript display, cut list state, and render/export.
 */

const API = 'http://localhost:8000';
const params = new URLSearchParams(location.search);
const JOB_ID = params.get('job');

// localStorage key for persisting operations for this session
const LS_KEY = JOB_ID ? `seq_ops_${JOB_ID}` : null;

// ── STATE ────────────────────────────────────────────────────────────────────

let state = {
  words: [],
  displayName: '',
  operations: [],
  activeFilter: 'all',
  searchQuery: '',
  targetLufs: -14,
  ctxWord: null,
  history: [],   // undo stack
  future:  [],   // redo stack
};


// ── INIT ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  if (!JOB_ID) {
    showError('No job ID found. Please go back and upload a video.');
    return;
  }

  setupContextMenu();
  setupFilterTabs();
  setupSearch();
  setupLufsButtons();
  setupFillerTags();
  setupKeyboardShortcuts();

  await loadTranscript();
});


async function loadTranscript() {
  try {
    const res = await fetch(`${API}/transcript/${JOB_ID}`);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Server error ${res.status}: ${text}`);
    }
    const data = await res.json();

    if (!data.words || !Array.isArray(data.words)) {
      console.error('Unexpected response shape:', data);
      throw new Error('Server returned unexpected data shape — check console');
    }

    state.words = data.words;

    // ── Restore saved operations from localStorage if present ──────────────
    const saved = LS_KEY ? localStorage.getItem(LS_KEY) : null;
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          state.operations = parsed;
          showRestoreBanner();
        } else {
          state.operations = data.edl?.operations ?? [];
        }
      } catch {
        state.operations = data.edl?.operations ?? [];
      }
    } else {
      state.operations = data.edl?.operations ?? [];
    }

    saveHistory();

    const srcVideo = data.edl?.source_video ?? '';
    const displayName = data.display_name || (srcVideo ? srcVideo.split(/[\\/]/).pop() : 'video');
    document.getElementById('topbarFilename').textContent = displayName;
    state.displayName = displayName.replace(/\.[^.]+$/, '');

    renderTranscript();
    updateStats();
    initMediaAndTimeline();
  } catch (err) {
    console.error('loadTranscript error:', err);
    showError(`Failed to load transcript: ${err.message}`);
  }
}

function showRestoreBanner() {
  const banner = document.createElement('div');
  banner.id = 'restoreBanner';
  banner.style.cssText = `
    position:fixed; top:56px; left:50%; transform:translateX(-50%);
    background:var(--teal); color:white; padding:8px 20px;
    border-radius:var(--radius); font-size:13px; font-weight:500;
    z-index:500; display:flex; align-items:center; gap:12px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
  `;
  banner.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M2 7a5 5 0 119 3" stroke="white" stroke-width="1.5" stroke-linecap="round"/>
      <path d="M2 4v3h3" stroke="white" stroke-width="1.5" stroke-linecap="round"/>
    </svg>
    Session restored from last visit
    <button onclick="discardRestored()" style="background:rgba(255,255,255,0.2);border:none;color:white;
      padding:3px 10px;border-radius:4px;cursor:pointer;font-size:12px;">Start fresh</button>
    <button onclick="document.getElementById('restoreBanner').remove()" style="background:none;border:none;
      color:white;cursor:pointer;font-size:16px;line-height:1;">×</button>
  `;
  document.body.appendChild(banner);
  setTimeout(() => banner?.remove(), 6000);
}

window.discardRestored = function() {
  if (LS_KEY) localStorage.removeItem(LS_KEY);
  document.getElementById('restoreBanner')?.remove();
  // Reload from server EDL
  location.reload();
};

function initMediaAndTimeline() {
  const videoEl     = document.getElementById('videoEl');
  const placeholder = document.getElementById('videoPlaceholder');
  videoEl.src = `${API}/video/${JOB_ID}`;
  videoEl.style.display = 'block';
  if (placeholder) placeholder.style.display = 'none';
  timeline.init(`${API}/audio/${JOB_ID}`, videoEl);
}


// ── PERSIST TO LOCALSTORAGE ───────────────────────────────────────────────────

function persistOps() {
  if (!LS_KEY) return;
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(state.operations));
  } catch (e) {
    console.warn('localStorage save failed:', e);
  }
}


// ── TRANSCRIPT RENDERING ──────────────────────────────────────────────────────

function renderTranscript() {
  const body = document.getElementById('transcriptBody');
  const { words, operations, activeFilter, searchQuery } = state;

  if (!words.length) {
    body.innerHTML = '<p class="no-results">No transcript found.</p>';
    return;
  }

  const blocks = groupIntoBlocks(words, operations);

  let html = '';
  for (const block of blocks) {
    if (block.type === 'silence') {
      const op    = block.operation;
      const isCut = op?.enabled;
      const dur   = op?.duration?.toFixed(1) ?? '?';
      const cls   = isCut ? 'silence-marker cut' : 'silence-marker';
      const label = isCut
        ? `✂ ${dur}s silence — will be removed`
        : `${dur}s pause — below threshold`;
      html += `<div class="${cls}" data-op-id="${op?.id ?? ''}">
        <div class="sil-line"></div>
        <span class="sil-badge" onclick="toggleSilence(this)">${label}</span>
        <div class="sil-line"></div>
      </div>`;
      continue;
    }

    if (activeFilter === 'silence') continue;

    const blockWords = block.words.filter(w => {
      const tag = getWordTag(w, operations);
      if (activeFilter === 'filler' && tag !== 'filler') return false;
      if (activeFilter === 'cut'    && tag !== 'cut' && tag !== 'bleep') return false;
      if (searchQuery && !w.word.toLowerCase().includes(searchQuery)) return false;
      return true;
    });

    if (blockWords.length === 0) continue;

    const timeLabel = formatTime(block.words[0]?.start ?? 0);
    html += `<div class="t-block">
      <div class="t-time">${timeLabel}</div>
      <div class="t-words">`;

    for (const w of block.words) {
      if (searchQuery && !w.word.toLowerCase().includes(searchQuery)) continue;
      const tag = getWordTag(w, operations);
      html += renderWord(w, tag);
    }

    html += `</div></div>`;
  }

  if (!html) html = '<p class="no-results">Nothing matches this filter.</p>';

  body.innerHTML = html;
  attachWordEvents();
}

function renderWord(word, tag) {
  const cls  = tag ? `word ${tag}` : 'word';
  const text = tag === 'bleep' ? '[bleep]' : word.word;
  return `<span class="${cls}" data-start="${word.start}" data-end="${word.end}" data-word="${escapeAttr(word.word)}">${escapeHtml(text)}</span>`;
}

function getWordTag(word, operations) {
  for (const op of operations) {
    if (!op.enabled) continue;
    if (word.start >= op.start && word.end <= op.end + 0.05) {
      if (op.type === 'bleep') return 'bleep';
      if (op.type === 'mute')  return 'mute';
      return 'cut';
    }
  }
  if (word.is_filler) return 'filler';
  return null;
}

function groupIntoBlocks(words, operations) {
  const silenceOps = operations.filter(op => op.type === 'cut_silence');
  const blocks     = [];
  let currentBlock = { type: 'words', words: [] };

  for (let i = 0; i < words.length; i++) {
    const w     = words[i];
    const nextW = words[i + 1];
    currentBlock.words.push(w);

    if (nextW) {
      const gap   = nextW.start - w.end;
      const silOp = silenceOps.find(op =>
        Math.abs(op.start - w.end)        < 0.1 &&
        Math.abs(op.end   - nextW.start)  < 0.1
      );
      if (gap >= 0.5 || silOp) {
        blocks.push(currentBlock);
        if (silOp)       blocks.push({ type: 'silence', operation: silOp });
        else if (gap >= 1.0) blocks.push({ type: 'silence', operation: { duration: gap, enabled: false, id: null } });
        currentBlock = { type: 'words', words: [] };
      }
    }
  }

  if (currentBlock.words.length) blocks.push(currentBlock);
  return blocks;
}

function buildOpLookup(operations) {
  const map = {};
  for (const op of operations) map[`${op.start}-${op.end}`] = op;
  return map;
}


// ── WORD INTERACTIONS ─────────────────────────────────────────────────────────

function attachWordEvents() {
  document.querySelectorAll('.word').forEach(el => {
    el.addEventListener('contextmenu', e => {
      e.preventDefault();
      state.ctxWord = el;
      showCtxMenu(e.clientX, e.clientY, el.dataset.word);
    });
    el.addEventListener('click', () => {
      hideCtxMenu();
      const t = parseFloat(el.dataset.start);
      if (!isNaN(t)) timeline.onWordClick(t);
    });
  });
}

function showCtxMenu(x, y, word) {
  const menu = document.getElementById('ctxMenu');
  document.getElementById('ctxWordLabel').textContent = word;
  menu.style.left = Math.min(x, window.innerWidth  - 180) + 'px';
  menu.style.top  = Math.min(y, window.innerHeight - 180) + 'px';
  menu.classList.add('visible');
}

function hideCtxMenu() {
  document.getElementById('ctxMenu').classList.remove('visible');
}

function setupContextMenu() {
  document.addEventListener('click', () => hideCtxMenu());
  document.querySelectorAll('.ctx-item').forEach(item => {
    item.addEventListener('click', () => {
      const action = item.dataset.action;
      const el     = state.ctxWord;
      if (!el) return;

      const start = parseFloat(el.dataset.start);
      const end   = parseFloat(el.dataset.end);
      const word  = el.dataset.word;

      if (action === 'cut')             addOperation({ type: 'cut_manual', start, end });
      if (action === 'bleep')           addOperation({ type: 'bleep',      start, end });
      if (action === 'mute')            addOperation({ type: 'mute',       start, end });
      if (action === 'restore')         removeOperationsAt(start, end);
      if (action === 'cut-all-similar') cutAllSimilar(word);

      hideCtxMenu();
    });
  });
}


// ── KEYBOARD SHORTCUTS ────────────────────────────────────────────────────────

function setupKeyboardShortcuts() {
  document.addEventListener('keydown', e => {
    // Don't fire when typing in an input
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    const isMac  = navigator.platform.toUpperCase().includes('MAC');
    const isCtrl = isMac ? e.metaKey : e.ctrlKey;

    // Cmd/Ctrl+Z — undo
    if (isCtrl && !e.shiftKey && e.key === 'z') {
      e.preventDefault();
      undo();
      return;
    }

    // FIX: use e.key.toLowerCase() === 'z' so Ctrl+Shift+Z works on all browsers
    // (browsers fire e.key = 'Z' uppercase when Shift is held)
    if ((isCtrl && e.shiftKey && e.key.toLowerCase() === 'z') || (isCtrl && e.key === 'y')) {
      e.preventDefault();
      redo();
      return;
    }

    // Delete / Backspace — cut the word currently at playhead
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      cutWordAtPlayhead();
      return;
    }
  });
}

function cutWordAtPlayhead() {
  const videoEl = document.getElementById('videoEl');
  if (!videoEl) return;
  const t = videoEl.currentTime;

  // Find the word the playhead is currently inside
  const word = state.words.find(w => t >= w.start && t <= w.end);
  if (!word) return;

  // Don't double-cut
  const alreadyCut = state.operations.some(op =>
    op.enabled &&
    op.type !== 'bleep' &&
    op.type !== 'mute' &&
    word.start >= op.start &&
    word.end   <= op.end + 0.05
  );
  if (alreadyCut) return;

  addOperation({ type: 'cut_manual', start: word.start, end: word.end });
  showShortcutToast(`Cut: "${word.word}"`);
}

function showShortcutToast(msg) {
  let toast = document.getElementById('shortcutToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'shortcutToast';
    toast.style.cssText = `
      position:fixed; bottom:160px; left:50%; transform:translateX(-50%);
      background:rgba(28,28,26,0.85); color:white; padding:6px 16px;
      border-radius:20px; font-size:12px; font-weight:500;
      z-index:400; pointer-events:none; transition:opacity 0.2s;
    `;
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.opacity = '1';
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { toast.style.opacity = '0'; }, 1800);
}


// ── OPERATION MANAGEMENT ──────────────────────────────────────────────────────

function addOperation(op) {
  saveHistory();
  // FIX: filter out non-finite ids before Math.max to prevent NaN propagation
  // which would corrupt localStorage saves (JSON.stringify turns NaN → null)
  const id = Math.max(0, ...state.operations.map(o => o.id).filter(Number.isFinite)) + 1;
  state.operations.push({ id, enabled: true, ...op });
  persistOps();
  renderTranscript();
  updateStats();
  timeline.refresh(state.operations);
}

function removeOperationsAt(start, end) {
  saveHistory();
  state.operations = state.operations.filter(op =>
    !(op.start <= start + 0.05 && op.end >= end - 0.05)
  );
  persistOps();
  renderTranscript();
  updateStats();
  timeline.refresh(state.operations);
}

function cutAllSimilar(word) {
  saveHistory();
  state.words.forEach(w => {
    if (w.word.toLowerCase() === word.toLowerCase()) {
      // FIX: same safe id generation here
      const id = Math.max(0, ...state.operations.map(o => o.id).filter(Number.isFinite)) + 1;
      state.operations.push({ id, enabled: true, type: 'cut_manual', start: w.start, end: w.end });
    }
  });
  persistOps();
  renderTranscript();
  updateStats();
  timeline.refresh(state.operations);
}

function toggleSilence(el) {
  const marker = el.closest('.silence-marker');
  const opId   = parseInt(marker.dataset.opId);
  if (!opId) return;
  saveHistory();
  const op = state.operations.find(o => o.id === opId);
  if (op) op.enabled = !op.enabled;
  persistOps();
  renderTranscript();
  updateStats();
  timeline.refresh(state.operations);
}
window.toggleSilence = toggleSilence;

function autoClean() {
  saveHistory();
  state.operations.forEach(op => {
    if (op.type === 'cut_filler' || op.type === 'cut_silence') op.enabled = true;
  });
  persistOps();
  renderTranscript();
  updateStats();
  // FIX: was missing — waveform regions weren't refreshed after auto-clean
  timeline.refresh(state.operations);
}

function undoAll() {
  if (state.history.length > 0) {
    state.future = [];
    state.operations = JSON.parse(JSON.stringify(state.history[0]));
    state.history    = [];
    persistOps();
    renderTranscript();
    updateStats();
    timeline.refresh(state.operations);
  }
}

function saveHistory() {
  state.future = []; // new action clears redo stack
  state.history.push(JSON.parse(JSON.stringify(state.operations)));
  if (state.history.length > 50) state.history.shift();
}

function undo() {
  if (!state.history.length) return;
  state.future.push(JSON.parse(JSON.stringify(state.operations)));
  state.operations = JSON.parse(JSON.stringify(state.history.pop()));
  persistOps();
  renderTranscript();
  updateStats();
  timeline.refresh(state.operations);
  showShortcutToast('Undo');
}

function redo() {
  if (!state.future.length) return;
  state.history.push(JSON.parse(JSON.stringify(state.operations)));
  state.operations = JSON.parse(JSON.stringify(state.future.pop()));
  persistOps();
  renderTranscript();
  updateStats();
  timeline.refresh(state.operations);
  showShortcutToast('Redo');
}

window.autoClean = autoClean;
window.undoAll   = undoAll;


// ── FILTER TABS ───────────────────────────────────────────────────────────────

function setupFilterTabs() {
  document.querySelectorAll('.filter-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      state.activeFilter = tab.dataset.filter;
      renderTranscript();
    });
  });
}


// ── SEARCH ────────────────────────────────────────────────────────────────────

function setupSearch() {
  document.getElementById('searchInput').addEventListener('input', e => {
    state.searchQuery = e.target.value.toLowerCase().trim();
    renderTranscript();
  });
}


// ── AUDIO SETTINGS ────────────────────────────────────────────────────────────

function setupLufsButtons() {
  document.querySelectorAll('.lufs-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.lufs-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.targetLufs = parseFloat(btn.dataset.lufs);
    });
  });
}

function setupFillerTags() {
  document.querySelectorAll('.filler-tag').forEach(tag => {
    tag.addEventListener('click', () => {
      tag.classList.toggle('active');
      saveHistory();
      const activeFillers = [...document.querySelectorAll('.filler-tag.active')]
        .map(t => t.dataset.word);
      state.words.forEach(w => {
        w.is_filler = activeFillers.includes(w.word.toLowerCase().trim('.,!?'));
      });
      // FIX: was missing — filler tag changes were never saved to localStorage
      persistOps();
      renderTranscript();
      updateStats();
    });
  });
}


// ── STATS ─────────────────────────────────────────────────────────────────────

function updateStats() {
  const enabled  = state.operations.filter(op => op.enabled);
  const silences = enabled.filter(op => op.type === 'cut_silence').length;
  const fillers  = enabled.filter(op => op.type === 'cut_filler' || op.type === 'cut_manual').length;
  const bleeps   = enabled.filter(op => op.type === 'bleep').length;
  const mutes    = enabled.filter(op => op.type === 'mute').length;

  const totalCutSec = enabled
    .filter(op => op.type !== 'bleep' && op.type !== 'mute')
    .reduce((sum, op) => sum + (op.end - op.start), 0);

  document.getElementById('editStats').innerHTML =
    `<span class="stat filler">${fillers} fillers</span>` +
    `<span class="stat silence">${silences} silences</span>` +
    (bleeps ? `<span class="stat bleep">${bleeps} bleeps</span>` : '') +
    (mutes  ? `<span class="stat mute">${mutes} mutes</span>`   : '') +
    `<span class="stat time">−${totalCutSec.toFixed(1)}s</span>`;
}


// ── EXPORT ────────────────────────────────────────────────────────────────────

function openExportPanel() {
  const enabled = state.operations.filter(op => op.enabled);
  const cutSec  = enabled
    .filter(op => op.type !== 'bleep' && op.type !== 'mute')
    .reduce((sum, op) => sum + (op.end - op.start), 0);

  document.getElementById('exportSummary').innerHTML =
    `<p><strong>${enabled.length}</strong> edits will be applied — removing <strong>${cutSec.toFixed(1)}s</strong> of footage.</p>`;

  // Pre-fill filename from display_name (strip extension)
  const filenameInput = document.getElementById('exportFilenameInput');
  if (filenameInput && !filenameInput.dataset.userEdited) {
    filenameInput.value = state.displayName || 'edited';
  }

  document.getElementById('exportOverlay').style.display = 'flex';
  // Once the user manually edits the field, stop auto-filling it
  if (filenameInput) {
    filenameInput.addEventListener('input', () => { filenameInput.dataset.userEdited = '1'; }, { once: true });
  }
  document.getElementById('renderProgress').style.display = 'none';
  document.getElementById('renderBtn').style.display = 'block';
}

function closeExportPanel() {
  document.getElementById('exportOverlay').style.display = 'none';
}

async function startRender() {
  document.getElementById('renderBtn').style.display  = 'none';
  document.getElementById('renderProgress').style.display = 'block';
  setRenderStatus('Sending to server...');
  setRenderProgress(10);

  const filenameRaw = (document.getElementById('exportFilenameInput')?.value || '').trim();
  const outputFilename = filenameRaw ? filenameRaw + '.mp4' : null;

  const payload = {
    job_id: JOB_ID,
    operations: [...state.operations, ...timeline.getFreeCuts()],
    output_filename: outputFilename,
    audio: {
      noise_gate:  document.getElementById('opt-noise').checked,
      compressor:  document.getElementById('opt-comp').checked,
      loudnorm:    document.getElementById('opt-loud').checked,
      target_lufs: state.targetLufs,
    },
  };

  try {
    const res = await fetch(`${API}/render`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(await res.text());
    setRenderProgress(30);
    setRenderStatus('Rendering video...');
    await pollRender();
  } catch (err) {
    setRenderStatus(`Error: ${err.message}`);
  }
}

async function pollRender() {
  const interval = setInterval(async () => {
    try {
      const res  = await fetch(`${API}/status/${JOB_ID}`);
      const data = await res.json();
      if (data.status === 'rendering') {
        setRenderProgress(30 + Math.random() * 40);
        setRenderStatus('Rendering...');
      } else if (data.status === 'rendered') {
        clearInterval(interval);
        setRenderProgress(100);
        setRenderStatus('Done! Downloading...');
        setTimeout(() => { window.location.href = `${API}/download/${JOB_ID}`; }, 800);
      } else if (data.status === 'error') {
        clearInterval(interval);
        setRenderStatus(`Render failed: ${data.error}`);
      }
    } catch (e) {}
  }, 2000);
}

function setRenderProgress(pct) {
  document.getElementById('renderBar').style.width = Math.min(pct, 100) + '%';
}
function setRenderStatus(msg) {
  document.getElementById('renderStatus').textContent = msg;
}

window.openExportPanel  = openExportPanel;
window.closeExportPanel = closeExportPanel;
window.startRender      = startRender;


// ── UTILS ─────────────────────────────────────────────────────────────────────

function formatTime(seconds) {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function escapeAttr(str) {
  return str.replace(/"/g,'&quot;');
}

function showError(msg) {
  document.getElementById('transcriptBody').innerHTML =
    `<div class="error-msg">${msg}</div>`;
}
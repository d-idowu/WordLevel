/**
 * editor.js — Sequence Auto Editor
 */

const API = 'http://localhost:8000';
const params = new URLSearchParams(location.search);
const JOB_ID = params.get('job');

// ── STATE ─────────────────────────────────────────────────────────────────────

let state = {
  words: [],
  operations: [],
  activeFilter: 'all',
  searchQuery: '',
  targetLufs: -14,
  ctxWord: null,
  history: [],
};


// ── INIT ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  if (!JOB_ID) { showError('No job ID. Go back and upload a video.'); return; }
  setupContextMenu();
  setupFilterTabs();
  setupSearch();
  setupLufsButtons();
  setupFillerTags();
  await loadTranscript();
});


// ── LOAD TRANSCRIPT ───────────────────────────────────────────────────────────

async function loadTranscript() {
  try {
    const res = await fetch(`${API}/transcript/${JOB_ID}`);
    if (!res.ok) throw new Error(`Server error ${res.status}: ${await res.text()}`);
    const data = await res.json();

    if (!data.words || !Array.isArray(data.words)) {
      console.error('Unexpected response shape:', data);
      throw new Error('Server returned unexpected data shape — check console');
    }

    state.words = data.words;
    state.operations = data.edl?.operations ?? [];
    saveHistory();

    const srcVideo = data.edl?.source_video ?? '';
    document.getElementById('topbarFilename').textContent =
      srcVideo ? srcVideo.split(/[\\/]/).pop() : 'video';

    renderTranscript();
    updateStats();
  } catch (err) {
    console.error('loadTranscript error:', err);
    showError(`Failed to load transcript: ${err.message}`);
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
      const op = block.operation;
      const isCut = op?.enabled;
      const dur = op?.duration?.toFixed(1) ?? '?';
      const cls = isCut ? 'silence-marker cut' : 'silence-marker';
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

    const hasMatch = block.words.some(w => {
      const tag = getWordTag(w, operations);
      if (activeFilter === 'filler' && tag !== 'filler') return false;
      if (activeFilter === 'cut' && tag !== 'cut' && tag !== 'bleep' && tag !== 'mute') return false;
      if (searchQuery && !w.word.toLowerCase().includes(searchQuery)) return false;
      return true;
    });
    if (!hasMatch && (activeFilter !== 'all' || searchQuery)) continue;

    const timeLabel = formatTime(block.words[0]?.start ?? 0);
    html += `<div class="t-block"><div class="t-time">${timeLabel}</div><div class="t-words">`;

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
  const cls = tag ? `word ${tag}` : 'word';
  let text = word.word;
  if (tag === 'bleep') text = '[bleep]';
  else if (tag === 'mute') text = '[mute]';
  return `<span class="${cls}" data-start="${word.start}" data-end="${word.end}" data-word="${escapeAttr(word.word)}">${escapeHtml(text)}</span>`;
}


// Fixed: no const inside for-of to avoid TDZ issues in some browsers
function getWordTag(word, operations) {
  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
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
  const blocks = [];
  let currentBlock = { type: 'words', words: [] };

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const nextW = words[i + 1];
    currentBlock.words.push(w);

    if (nextW) {
      const gap = nextW.start - w.end;
      const silOp = silenceOps.find(op =>
        Math.abs(op.start - w.end) < 0.1 && Math.abs(op.end - nextW.start) < 0.1
      );
      if (gap >= 0.5 || silOp) {
        blocks.push(currentBlock);
        if (silOp) blocks.push({ type: 'silence', operation: silOp });
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
  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    map[`${op.start}-${op.end}`] = op;
  }
  return map;
}


// ── WORD INTERACTIONS ─────────────────────────────────────────────────────────

function attachWordEvents() {
  document.querySelectorAll('.word').forEach(el => {

    // RIGHT-CLICK → context menu (always)
    el.addEventListener('contextmenu', e => {
      e.preventDefault();
      state.ctxWord = el;
      showCtxMenu(e.clientX, e.clientY, el.dataset.word);
    });

    // LEFT-CLICK:
    // - If word is bleped → switch to mute
    // - If word is muted  → switch to bleep
    // - Otherwise         → just close ctx menu (no action)
    el.addEventListener('click', e => {
      hideCtxMenu();

      const tag = el.classList.contains('bleep') ? 'bleep'
                : el.classList.contains('mute')  ? 'mute'
                : null;

      if (!tag) return; // normal word — do nothing on left click

      e.stopPropagation();
      const start = parseFloat(el.dataset.start);
      const end   = parseFloat(el.dataset.end);

      // Remove the existing bleep/mute op and replace with the other
      saveHistory();
      state.operations = state.operations.filter(op =>
        !(op.start <= start + 0.05 && op.end >= end - 0.05 &&
          (op.type === 'bleep' || op.type === 'mute'))
      );

      const newType = tag === 'bleep' ? 'mute' : 'bleep';
      const id = Math.max(0, ...state.operations.map(o => o.id)) + 1;
      state.operations.push({ id, enabled: true, type: newType, start, end });

      renderTranscript();
      updateStats();
    });
  });
}


function showCtxMenu(x, y, word) {
  const menu = document.getElementById('ctxMenu');
  document.getElementById('ctxWordLabel').textContent = word;
  menu.style.left = Math.min(x, window.innerWidth - 190) + 'px';
  menu.style.top  = Math.min(y, window.innerHeight - 200) + 'px';
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
      const el = state.ctxWord;
      if (!el) return;

      const start = parseFloat(el.dataset.start);
      const end   = parseFloat(el.dataset.end);
      const word  = el.dataset.word;

      if (action === 'cut')            addOperation({ type: 'cut_manual', start, end });
      if (action === 'bleep')          addOperation({ type: 'bleep', start, end });
      if (action === 'mute')           addOperation({ type: 'mute',  start, end });
      if (action === 'restore')        removeOperationsAt(start, end);
      if (action === 'cut-all-similar') cutAllSimilar(word);

      hideCtxMenu();
    });
  });
}


// ── OPERATION MANAGEMENT ──────────────────────────────────────────────────────

function addOperation(op) {
  saveHistory();
  // Remove any existing op at the same range before adding new one
  state.operations = state.operations.filter(existing =>
    !(existing.start <= op.start + 0.05 && existing.end >= op.end - 0.05 &&
      (existing.type === 'bleep' || existing.type === 'mute' || existing.type === 'cut_manual'))
  );
  const id = (state.operations.length ? Math.max(...state.operations.map(o => o.id)) : 0) + 1;
  state.operations.push({ id, enabled: true, ...op });
  renderTranscript();
  updateStats();
}

function removeOperationsAt(start, end) {
  saveHistory();
  state.operations = state.operations.filter(op =>
    !(op.start <= start + 0.05 && op.end >= end - 0.05)
  );
  renderTranscript();
  updateStats();
}

function cutAllSimilar(word) {
  saveHistory();
  state.words.forEach(w => {
    if (w.word.toLowerCase() === word.toLowerCase()) {
      addOperation({ type: 'cut_manual', start: w.start, end: w.end });
    }
  });
}

function toggleSilence(el) {
  const marker = el.closest('.silence-marker');
  const opId = parseInt(marker.dataset.opId);
  if (!opId) return;
  saveHistory();
  const op = state.operations.find(o => o.id === opId);
  if (op) op.enabled = !op.enabled;
  renderTranscript();
  updateStats();
}
window.toggleSilence = toggleSilence;

function autoClean() {
  saveHistory();
  state.operations.forEach(op => {
    if (op.type === 'cut_filler' || op.type === 'cut_silence') op.enabled = true;
  });
  renderTranscript();
  updateStats();
}

function undoAll() {
  if (state.history.length > 0) {
    state.operations = JSON.parse(JSON.stringify(state.history[0]));
    state.history = [];
    renderTranscript();
    updateStats();
  }
}

function saveHistory() {
  state.history.push(JSON.parse(JSON.stringify(state.operations)));
  if (state.history.length > 50) state.history.shift();
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
  const loudnormToggle = document.getElementById('opt-loud');
  const lufsOptions    = document.getElementById('lufsOptions');

  // Show/hide LUFS presets based on loudnorm toggle
  function syncLufs() {
    if (lufsOptions) lufsOptions.style.opacity = loudnormToggle.checked ? '1' : '0.35';
    if (lufsOptions) lufsOptions.style.pointerEvents = loudnormToggle.checked ? 'auto' : 'none';
  }
  if (loudnormToggle) { loudnormToggle.addEventListener('change', syncLufs); syncLufs(); }

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
        w.is_filler = activeFillers.includes(w.word.toLowerCase().replace(/[.,!?]/g, ''));
      });
      renderTranscript();
      updateStats();
    });
  });
}


// ── STATS ─────────────────────────────────────────────────────────────────────

function updateStats() {
  const enabled   = state.operations.filter(op => op.enabled);
  const silences  = enabled.filter(op => op.type === 'cut_silence').length;
  const fillers   = enabled.filter(op => op.type === 'cut_filler' || op.type === 'cut_manual').length;
  const bleeps    = enabled.filter(op => op.type === 'bleep').length;
  const mutes     = enabled.filter(op => op.type === 'mute').length;
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

  document.getElementById('exportOverlay').style.display = 'flex';
  document.getElementById('renderProgress').style.display = 'none';
  document.getElementById('renderBtn').style.display = 'block';
}

function closeExportPanel() {
  document.getElementById('exportOverlay').style.display = 'none';
}

async function startRender() {
  document.getElementById('renderBtn').style.display = 'none';
  document.getElementById('renderProgress').style.display = 'block';
  setRenderStatus('Sending to server...');
  setRenderProgress(10);

  const payload = {
    job_id: JOB_ID,
    operations: state.operations,
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

function setRenderProgress(pct) { document.getElementById('renderBar').style.width = Math.min(pct, 100) + '%'; }
function setRenderStatus(msg)    { document.getElementById('renderStatus').textContent = msg; }

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
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(str) {
  return str.replace(/"/g, '&quot;');
}

function showError(msg) {
  document.getElementById('transcriptBody').innerHTML = `<div class="error-msg">${msg}</div>`;
}
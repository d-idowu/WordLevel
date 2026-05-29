/**
 * timeline.js — Sequence Auto Editor
 */

const timeline = (() => {

  let ws            = null;
  let videoEl       = null;
  let isReady       = false;
  let userSeeking   = false;
  let rafId         = null;
  let freeCuts      = [];
  let freeIdCounter = 1000;

  // Region fill colors
  const COLORS = {
    cut_silence : 'rgba(24,  95, 165, 0.18)',
    cut_filler  : 'rgba(186,117,  23, 0.18)',
    cut_manual  : 'rgba(163, 45,  45, 0.18)',
    bleep       : 'rgba(83,  74, 183, 0.22)',
    mute        : 'rgba(100,100,  95, 0.18)',
    free_cut    : 'rgba(220, 50,  50, 0.12)',
  };
  // Region top-border colors (thicker, more visible)
  const BORDER = {
    cut_silence : '#185FA5',
    cut_filler  : '#BA7517',
    cut_manual  : '#A32D2D',
    bleep       : '#534AB7',
    mute        : '#646460',
    free_cut    : '#cc2222',
  };
  // Short labels shown inside region
  const LABELS = {
    cut_silence : 'silence',
    cut_filler  : 'filler',
    cut_manual  : 'cut',
    bleep       : 'bleep',
    mute        : 'mute',
    free_cut    : 'free cut',
  };


  // ── init ───────────────────────────────────────────────────────────────────

  function init(audioUrl, videoElement) {
    videoEl = videoElement;

    ws = WaveSurfer.create({
      container     : '#waveform',
      waveColor     : '#AFA9EC',
      progressColor : '#534AB7',
      cursorColor   : '#534AB7',
      cursorWidth   : 2,
      height        : 72,
      barWidth      : 2,
      barGap        : 1,
      barRadius     : 2,
      normalize     : true,
      volume        : 0,        // muted — video el handles all audio
      backend       : 'WebAudio',
      plugins: [
        WaveSurfer.regions.create({
          dragSelection: { slop: 5 },
        }),
      ],
    });

    ws.load(audioUrl);

    ws.on('ready', () => {
      isReady = true;
      // FIX: call ws.play() so cursor animates, but volume stays 0
      // so it stays in sync with video during playback
      refresh(state.operations);
      document.getElementById('tlDuration').textContent = formatTime(ws.getDuration());
    });

    // User clicks/scrubs waveform → seek video
    ws.on('seek', progress => {
      if (!isReady || userSeeking) return;
      videoEl.currentTime = progress * ws.getDuration();
    });

    // Attach mousedown to waveform wrapper AFTER ready (drawer exists then)
    ws.on('ready', () => {
      const wrapper = ws.drawer?.wrapper;
      if (wrapper) {
        wrapper.addEventListener('mousedown', () => {
          userSeeking = true;
          // Brief lock — prevents timeupdate fighting the click seek
          setTimeout(() => { userSeeking = false; }, 300);
        });
      }
    });

    // Video plays → advance WaveSurfer cursor (visual only)
    videoEl.addEventListener('timeupdate', () => {
      if (!isReady || userSeeking) return;
      const dur = ws.getDuration();
      if (dur > 0) ws.seekTo(Math.min(videoEl.currentTime / dur, 1));
      document.getElementById('tlCurrent').textContent = formatTime(videoEl.currentTime);
      highlightWordAt(videoEl.currentTime);
    });

    videoEl.addEventListener('play', () => {
      // FIX: call ws.play() with volume 0 so cursor moves with playback
      ws.setVolume(0);
      ws.play(videoEl.currentTime);
      startRaf();
    });
    videoEl.addEventListener('pause', () => { ws.pause(); stopRaf(); });
    videoEl.addEventListener('ended', () => { ws.pause(); stopRaf(); });

    // FIX: region-created — only treat as free cut if id starts with 'free-'
    // Op regions are added with explicit ids like 'op-N' so they won't match
    ws.on('region-created', region => {
      if (region.id && region.id.startsWith('op-')) return;

      // Assign free-cut id immediately
      const id = freeIdCounter++;
      region.id = `free-${id}`;
      region.update({ color: COLORS.free_cut });

      styleRegionEl(region.element, 'free_cut', 'free cut');

      // Right-click to delete
      if (region.element) {
        region.element.addEventListener('contextmenu', e => {
          e.preventDefault();
          e.stopPropagation();
          freeCuts = freeCuts.filter(fc => fc.id !== id);
          region.remove();
          updateFreeCutTints();
        });
      }

      freeCuts.push({ id, start: region.start, end: region.end, region });
      updateFreeCutTints();

      region.on('update-end', () => {
        const fc = freeCuts.find(f => f.id === id);
        if (fc) { fc.start = region.start; fc.end = region.end; }
        updateFreeCutTints();
      });
    });

    document.getElementById('tlPlayBtn').addEventListener('click', togglePlay);

    document.addEventListener('keydown', e => {
      if (e.target.tagName === 'INPUT') return;
      if (e.code === 'Space')      { e.preventDefault(); togglePlay(); }
      if (e.code === 'ArrowLeft')  seek(-5);
      if (e.code === 'ArrowRight') seek(+5);
    });

    document.querySelectorAll('.tl-speed-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tl-speed-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        setSpeed(parseFloat(btn.dataset.speed));
      });
    });
  }


  // ── region styling helper ─────────────────────────────────────────────────
  // FIX: centralised styling so op regions and free cuts look consistent
  // Label only shown if element is wide enough to not overlap other text

  function styleRegionEl(el, type, labelText) {
    if (!el) return;
    el.style.borderTop    = `3px solid ${BORDER[type] ?? '#888'}`;
    el.style.borderRadius = '2px';
    el.style.overflow     = 'hidden';

    const label = document.createElement('span');
    label.className   = 'tl-region-label';
    label.textContent = labelText;
    label.style.color = BORDER[type] ?? '#888';
    el.appendChild(label);
  }


  // ── playback ───────────────────────────────────────────────────────────────

  function togglePlay() {
    if (!videoEl) return;
    if (videoEl.paused) {
      videoEl.play();
    } else {
      videoEl.pause();
    }
    updatePlayBtn();
  }

  function seek(deltaSec) {
    if (!videoEl) return;
    videoEl.currentTime = Math.max(0, videoEl.currentTime + deltaSec);
  }

  function seekTo(t) {
    if (!videoEl) return;
    videoEl.currentTime = t;
    if (isReady) {
      userSeeking = true;
      ws.seekTo(Math.min(t / ws.getDuration(), 1));
      setTimeout(() => { userSeeking = false; }, 300);
    }
  }

  function setSpeed(rate) {
    if (videoEl) videoEl.playbackRate = rate;
  }

  function updatePlayBtn() {
    const icon = document.getElementById('tlPlayIcon');
    if (!icon) return;
    icon.innerHTML = videoEl?.paused
      ? `<path d="M5 3l11 6-11 6V3z" fill="currentColor"/>`
      : `<path d="M5 3h3v13H5zM10 3h3v13h-3z" fill="currentColor"/>`;
  }

  function startRaf() {
    updatePlayBtn();
    const tick = () => {
      if (videoEl && !videoEl.paused) {
        document.getElementById('tlCurrent').textContent = formatTime(videoEl.currentTime);
        rafId = requestAnimationFrame(tick);
      }
    };
    rafId = requestAnimationFrame(tick);
  }

  function stopRaf() {
    updatePlayBtn();
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  }


  // ── regions ────────────────────────────────────────────────────────────────

  function refresh(operations) {
    if (!isReady || !ws) return;

    // Remove op regions only, keep free cuts
    Object.values(ws.regions.list).forEach(r => {
      if (r.id && r.id.startsWith('op-')) r.remove();
    });

    for (let i = 0; i < operations.length; i++) {
      const op = operations[i];
      if (!op.enabled) continue;

      // FIX: pass explicit id so region-created can identify it immediately
      const region = ws.addRegion({
        id    : `op-${op.id}`,
        start : op.start,
        end   : op.end,
        color : COLORS[op.type] ?? 'rgba(100,100,100,0.15)',
        drag  : false,
        resize: true,
      });

      styleRegionEl(region.element, op.type, LABELS[op.type] ?? op.type);

      region.on('update-end', () => {
        const opInState = state.operations.find(o => o.id === op.id);
        if (opInState) {
          opInState.start = Math.round(region.start * 1000) / 1000;
          opInState.end   = Math.round(region.end   * 1000) / 1000;
          renderTranscript();
          updateStats();
        }
      });
    }
  }


  // ── free cut word tinting ─────────────────────────────────────────────────

  function updateFreeCutTints() {
    document.querySelectorAll('.word.in-free-cut').forEach(el => {
      el.classList.remove('in-free-cut');
    });
    if (!freeCuts.length) return;
    document.querySelectorAll('.word').forEach(el => {
      const wStart = parseFloat(el.dataset.start);
      const wEnd   = parseFloat(el.dataset.end);
      for (let i = 0; i < freeCuts.length; i++) {
        if (wStart < freeCuts[i].end && wEnd > freeCuts[i].start) {
          el.classList.add('in-free-cut');
          break;
        }
      }
    });
  }


  // ── word highlight ────────────────────────────────────────────────────────

  function highlightWordAt(t) {
    document.querySelectorAll('.word.playing').forEach(el => el.classList.remove('playing'));
    const words = state?.words ?? [];
    for (let i = 0; i < words.length; i++) {
      if (t >= words[i].start && t <= words[i].end) {
        const el = document.querySelector(`.word[data-start="${words[i].start}"]`);
        if (el) {
          el.classList.add('playing');
          el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
        break;
      }
    }
  }

  function onWordClick(startTime) { seekTo(startTime); }

  function formatTime(s) {
    if (!isFinite(s)) return '0:00';
    return `${Math.floor(s/60).toString().padStart(2,'0')}:${Math.floor(s%60).toString().padStart(2,'0')}`;
  }

  function getFreeCuts() {
    return freeCuts.map(fc => ({
      id: fc.id, type: 'free_cut',
      start: fc.start, end: fc.end, enabled: true,
    }));
  }

  return { init, refresh, onWordClick, seekTo, setSpeed, getFreeCuts, updateFreeCutTints };

})();
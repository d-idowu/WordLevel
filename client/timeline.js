/**
 * timeline.js — Sequence Auto Editor
 *
 * FIX (cursor jumping): timeupdate fires ~4Hz, so ws.seekTo() was called
 *   in 250ms jumps. Fix: drive the cursor from requestAnimationFrame at 60fps
 *   using performance.now() interpolation between timeupdate anchors.
 *   timeupdate still runs but only re-anchors the known position — RAF
 *   does all the smooth in-between movement.
 *
 * FIX (feedback loop): programmaticSeek flag wraps every ws.seekTo() call
 *   we make so the 'seek' event handler doesn't bounce videoEl.currentTime.
 *
 * FIX (no sound): switched to MediaElement backend so WaveSurfer never
 *   starts its own audio engine. ws.play() removed entirely — cursor is
 *   driven solely by the RAF loop above.
 */

const timeline = (() => {

  let ws               = null;
  let videoEl          = null;
  let isReady          = false;
  let programmaticSeek = false;
  let userSeeking      = false;
  let rafId            = null;
  let freeCuts         = [];
  let freeIdCounter    = 1000;

  // ── Smooth cursor interpolation state ────────────────────────────────────
  // On each timeupdate we record the video time + a wall-clock anchor.
  // RAF interpolates forward from that anchor at the current playback rate
  // so the cursor moves smoothly at 60fps between timeupdate ticks.
  let anchorVideoTime  = 0;
  let anchorWallTime   = 0;   // performance.now() at last timeupdate
  let isPlaying        = false;

  // Region fill colors
  const COLORS = {
    cut_silence : 'rgba(24,  95, 165, 0.18)',
    cut_filler  : 'rgba(186,117,  23, 0.18)',
    cut_manual  : 'rgba(163, 45,  45, 0.18)',
    bleep       : 'rgba(83,  74, 183, 0.22)',
    mute        : 'rgba(100,100,  95, 0.18)',
    free_cut    : 'rgba(220, 50,  50, 0.12)',
  };
  const BORDER = {
    cut_silence : '#185FA5',
    cut_filler  : '#BA7517',
    cut_manual  : '#A32D2D',
    bleep       : '#534AB7',
    mute        : '#646460',
    free_cut    : '#cc2222',
  };
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
      volume        : 0,
      backend       : 'MediaElement',
      interact      : true,
      plugins: [
        WaveSurfer.regions.create({
          dragSelection: { slop: 5 },
        }),
      ],
    });

    ws.load(audioUrl);

    ws.on('ready', () => {
      isReady = true;
      refresh(state.operations);
      document.getElementById('tlDuration').textContent = formatTime(ws.getDuration());
    });

    // Human click/scrub on waveform → seek video
    ws.on('seek', progress => {
      if (!isReady) return;
      if (programmaticSeek) return;
      if (userSeeking) {
        const t = progress * ws.getDuration();
        videoEl.currentTime = t;
        // Re-anchor immediately so RAF starts from the right position
        anchorVideoTime = t;
        anchorWallTime  = performance.now();
      }
    });

    ws.on('ready', () => {
      const wrapper = ws.drawer?.wrapper;
      if (wrapper) {
        wrapper.addEventListener('mousedown', () => {
          userSeeking = true;
          setTimeout(() => { userSeeking = false; }, 400);
        });
      }
    });

    // timeupdate: re-anchor interpolation. Does NOT move the cursor itself —
    // that's RAF's job. This corrects for buffering stalls and speed changes.
    videoEl.addEventListener('timeupdate', () => {
      if (!isReady || userSeeking) return;
      anchorVideoTime = videoEl.currentTime;
      anchorWallTime  = performance.now();
      highlightWordAt(videoEl.currentTime);
    });

    videoEl.addEventListener('play', () => {
      isPlaying = true;
      anchorVideoTime = videoEl.currentTime;
      anchorWallTime  = performance.now();
      startRaf();
    });
    videoEl.addEventListener('pause', () => {
      isPlaying = false;
      // Snap cursor to exact paused position
      if (isReady) setCursorTo(videoEl.currentTime);
      stopRaf();
    });
    videoEl.addEventListener('ended', () => {
      isPlaying = false;
      stopRaf();
    });
    // Seeking while paused: snap cursor immediately
    videoEl.addEventListener('seeked', () => {
      if (!isPlaying && isReady) setCursorTo(videoEl.currentTime);
      anchorVideoTime = videoEl.currentTime;
      anchorWallTime  = performance.now();
    });

    // region-created: only treat as free cut if id doesn't start with 'op-'
    ws.on('region-created', region => {
      if (region.id && region.id.startsWith('op-')) return;

      const id = freeIdCounter++;
      region.id = `free-${id}`;
      region.update({ color: COLORS.free_cut });
      styleRegionEl(region.element, 'free_cut', 'free cut');

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


  // ── smooth cursor via RAF ──────────────────────────────────────────────────
  // Interpolates forward from the last timeupdate anchor using wall-clock
  // delta × playbackRate. Clamped to [0, duration] so it never overshoots.

  function setCursorTo(videoTime) {
    const dur = ws.getDuration();
    if (dur > 0) {
      programmaticSeek = true;
      ws.seekTo(Math.min(Math.max(videoTime / dur, 0), 1));
      programmaticSeek = false;
    }
    document.getElementById('tlCurrent').textContent = formatTime(videoTime);
  }

  function startRaf() {
    updatePlayBtn();
    if (rafId) cancelAnimationFrame(rafId);

    const tick = () => {
      if (!isPlaying) return;

      // Interpolate: how far has wall-clock advanced since last timeupdate?
      const wallDelta    = (performance.now() - anchorWallTime) / 1000;
      const rate         = videoEl.playbackRate || 1;
      const interpolated = anchorVideoTime + wallDelta * rate;
      const dur          = ws.getDuration();
      const clamped      = Math.min(interpolated, dur);

      setCursorTo(clamped);

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
  }

  function stopRaf() {
    updatePlayBtn();
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  }


  // ── region styling helper ─────────────────────────────────────────────────

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
    videoEl.paused ? videoEl.play() : videoEl.pause();
    updatePlayBtn();
  }

  function seek(deltaSec) {
    if (!videoEl) return;
    videoEl.currentTime = Math.max(0, videoEl.currentTime + deltaSec);
  }

  function seekTo(t) {
    if (!videoEl) return;
    videoEl.currentTime = t;
    anchorVideoTime = t;
    anchorWallTime  = performance.now();
    if (isReady) setCursorTo(t);
  }

  function setSpeed(rate) {
    if (videoEl) {
      videoEl.playbackRate = rate;
      // Re-anchor so interpolation uses the new rate from this moment
      anchorVideoTime = videoEl.currentTime;
      anchorWallTime  = performance.now();
    }
  }

  function updatePlayBtn() {
    const icon = document.getElementById('tlPlayIcon');
    if (!icon) return;
    icon.innerHTML = videoEl?.paused
      ? `<path d="M5 3l11 6-11 6V3z" fill="currentColor"/>`
      : `<path d="M5 3h3v13H5zM10 3h3v13h-3z" fill="currentColor"/>`;
  }


  // ── regions ────────────────────────────────────────────────────────────────

  function refresh(operations) {
    if (!isReady || !ws) return;

    Object.values(ws.regions.list).forEach(r => {
      if (r.id && r.id.startsWith('op-')) r.remove();
    });

    for (let i = 0; i < operations.length; i++) {
      const op = operations[i];
      if (!op.enabled) continue;

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
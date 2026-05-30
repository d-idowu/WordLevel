# Sequence Auto Editor — Project Context
*Last updated: this session*

## What this is
Self-hosted AI video editor proof-of-concept for the larger Sequence editor.
Drop in video → AI transcribes → user marks cuts/bleeps/mutes → cleaned video exported.

## Stack
- **Backend**: Python + FastAPI (`server/main.py`)
- **Transcription**: Deepgram nova-2 (`server/transcribe.py`)
- **Rendering**: ffmpeg via subprocess (`server/render.py`)
- **Persistence**: SQLite via `server/db.py` — survives server restarts
- **Frontend**: Vanilla HTML/CSS/JS — no framework (`client/`)
- **Run server**: `uvicorn main:app --reload --port 8000` from `server/`
- **Run frontend**: open `client/index.html` directly or `python -m http.server 3000`
- **Platform**: Windows (ffmpeg gyan.dev build v8.1.1)
- **Transcription key**: `export DEEPGRAM_API_KEY="your_key"` ($200 free credits)

## File map
```
server/
  main.py          FastAPI routes, SQLite-backed job state, background tasks
  transcribe.py    ffmpeg audio extract → Deepgram nova-2 → EDL generation
  render.py        build_keep_segments, apply_mutes, apply_bleeps, audio chain
  db.py            SQLite helpers: init_db, upsert_job, load_job, load_all_jobs
  sequence.db      SQLite database file (auto-created on first run)
  requirements.txt fastapi, uvicorn, python-multipart, pydantic

client/
  index.html       Upload/landing page, drag-drop, recent sessions panel
  editor.html      Main editor UI shell
  editor.js        All editor logic, state management, export, keyboard shortcuts
  timeline.js      WaveSurfer waveform, playback, regions, free cuts
  style.css        Design tokens + all component styles
```

## API endpoints
- `POST /upload`               receive video, start transcription bg task, return job_id
- `GET  /status/{job_id}`      poll: uploaded / transcribing / ready / rendering / rendered / error
- `GET  /transcript/{job_id}`  return { words, edl } once ready
- `POST /render`               accept { job_id, operations, audio }, start render bg task
- `GET  /download/{job_id}`    return finished mp4
- `GET  /video/{job_id}`       stream original video to <video> element for preview
- `GET  /audio/{job_id}`       extract + cache 64k mono mp3 for WaveSurfer waveform
- `GET  /sessions`             return list of resumable sessions (ready/rendered, video still on disk)

## JS state shape (editor.js)
```js
state = {
  words: [],          // [{ word, start, end, confidence, is_filler }]
  operations: [],     // [{ id, type, start, end, enabled }]
  activeFilter: 'all',
  searchQuery: '',
  targetLufs: -14,
  ctxWord: null,
  history: [],        // undo stack, max 50
  future:  [],        // redo stack (Cmd+Shift+Z / Ctrl+Y)
}
```

## Operation types
- `cut_silence`  auto-detected silence gap (from Deepgram EDL)
- `cut_filler`   auto-detected filler word (from EDL)
- `cut_manual`   user manually cut a word via context menu or Delete key
- `bleep`        overlay 1kHz sine tone (audio stays, tone replaces it)
- `mute`         silence audio window completely (no tone)
- `free_cut`     raw timeline cut drawn by user on waveform, no word mapping

## render.py logic
1. Separate ops: cuts (cut_silence, cut_filler, cut_manual, free_cut) / bleeps / mutes
2. build_keep_segments(cuts) → list of (start, end) to keep
3. remap_ops() → re-map bleep/mute timestamps to new timeline after cuts applied
4. Trim + concat segments via filter_complex
5. apply_mutes → chain of `volume=enable='between(t\,t0\,t1)':volume=0` per mute
6. apply_bleeps → silence window + aevalsrc 1kHz tone + adelay to position + amix
7. Audio chain: afftdn → acompressor → loudnorm
8. Output: libx264 fast crf18, aac 192k, faststart

## Session persistence
- **Server side**: SQLite (`sequence.db`) stores job metadata, words JSON, EDL JSON.
  - `db.py` — init_db(), upsert_job(), load_job(), load_all_jobs()
  - On startup, main.py calls `init_db()` then restores all valid jobs into the hot `jobs` dict
  - Jobs whose video file no longer exists on disk are skipped
- **Client side**: `state.operations` saved to `localStorage` keyed by `seq_ops_{job_id}`
  - Saved on every addOperation / removeOperation / toggleSilence / autoClean
  - Restored on editor load with a dismissable "Session restored" banner
  - "Start fresh" button clears localStorage and reloads from server EDL

## Keyboard shortcuts (editor.js)
- `Delete` / `Backspace`       cut the word currently under the playhead
- `Cmd+Z` / `Ctrl+Z`           undo (pops history stack)
- `Cmd+Shift+Z` / `Ctrl+Y`     redo (pops future stack)
- `Space`                      play / pause (timeline.js)
- `← →`                        seek ±5s (timeline.js)

## Word token behaviour
**Left click** on word → seeks video/waveform to that word's timestamp
**Left click** on bleep word → switches to mute
**Left click** on mute word → switches to bleep
**Right click** → context menu (cut / bleep / mute / cut-all-similar / restore)

## Context menu actions
- `cut`              add cut_manual op at word timestamps
- `bleep`            add bleep op
- `mute`             add mute op
- `cut-all-similar`  cut_manual every word matching this text
- `restore`          remove all ops overlapping this word's timestamps

## Timeline (timeline.js) — WaveSurfer 6.6.4 + Regions plugin
- WaveSurfer volume=0 always (waveform display only, video el handles all audio)
- Sync: video timeupdate → ws.seekTo via wsSeeking flag to suppress feedback loop
- userSeeking flag (mousedown on waveform) allows human scrub → video seek
- wsSeeking flag suppresses ws.on('seek') bouncing back when we call ws.seekTo/ws.play
- Op regions: resize=true, drag=false — drag edges to adjust cut timing
  - update-end event writes back to state.operations + re-renders transcript
- Free-draw: dragSelection enabled — drag empty area to create free_cut region
  - Right-click free-cut region to delete it
  - Free cuts included in render payload merged with word ops
  - Words overlapping free-cut zone get `.in-free-cut` tint (passive/informational only)
- Speed buttons: 0.5× 0.75× 1× 1.5× 2× → sets videoEl.playbackRate
- Keyboard: Space play/pause, ← → ±5s (handled in timeline.js)

## CSS design tokens
```
--purple #534AB7 / --purple-lt #EEEDFE / --purple-mid #AFA9EC
--amber  #BA7517 / --amber-lt  #FAEEDA
--red    #A32D2D / --red-lt    #FCEBEB
--blue   #185FA5 / --blue-lt   #E6F1FB
--teal   #0F6E56 / --teal-lt   #E1F5EE
--bg #F9F8F6 / --bg-2 #FFFFFF
--text #1C1C1A / --text-2 #5F5E5A / --text-3 #888780
--font: DM Sans / --mono: DM Mono / --topbar-h: 48px
```

## Word token colours
- `.word.filler`      amber — auto-detected filler, not yet actioned
- `.word.cut`         red + strikethrough — will be removed
- `.word.bleep`       purple italic — [bleep] tone overlay
- `.word.mute`        grey italic — [mute] silent
- `.word.playing`     purple solid — currently playing in preview
- `.word.in-free-cut` faint red tint — falls within a free-draw cut zone (informational)

## Known Bugs
- Timeline not fully synced to video — cursor races ahead if video is buffering, then jumps back
- Timeline glitches when jumping around during playback (same root cause as above)
- Go-to-start button doesn't work (ws.seekTo(0) WaveSurfer 6 no-op bug, epsilon workaround attempted but unresolved)

## Known fixed bugs
- Audio doubling: WaveSurfer volume=0, ws.play() never called
- Seek glitch (~0.2s jump): one-directional sync + userSeeking flag
- Bleep noise at t=0: fixed with adelay (positions tone correctly)
- Mute doing nothing: mute ops now collected separately in render.py
- Bleep actually muting: aevalsrc + adelay + amix replaces old broken approach
- 'No such filter empty string': was malformed filter_complex string with trailing comma
- TDZ error 'can't access lexical declaration': for..of with const replaced with indexed for loops
- Timeline play button not working: wsSeeking flag prevents ws.play() seek event bouncing to videoEl

## Backlog (priority order)
1. AI-contextual filler detection (send transcript to Claude, get per-word confidence)
2. "Bleep all / Mute all similar" in context menu
3. Threshold slider for silence detection (re-runs EDL with new min_silence value)
4. Dual-mode timeline: switch between Original and Edited preview
5. Add Icons to represent fillers silences and freecuts and bleeps
6. Audio processing stats display (LUFS before/after via ffmpeg ebur128)
7. Export EDL / Premiere XML
8. "Tighten cuts" — compress silence to 0.2s instead of removing entirely
9. Batch processing multiple videos

## How to start a new session efficiently
1. Upload latest .rar of the project
2. Paste this CONTEXT.md into your first message
3. Say which files are being touched — Claude reads only those
4. Claude will not re-read files that haven't changed
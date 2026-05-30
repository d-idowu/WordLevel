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
  style.css        Shared styles
```

## API endpoints
- `POST /upload`                  receive video, start transcription bg task, return job_id
- `GET  /status/{job_id}`         poll: uploaded / transcribing / ready / rendering / rendered / error
- `GET  /transcript/{job_id}`     return { words, edl, display_name } once ready
- `POST /render`                  accept { job_id, operations, audio, output_filename }, start render bg task
- `GET  /download/{job_id}`       return finished mp4 using output_filename or display_name
- `GET  /video/{job_id}`          stream original video to <video> element for preview
- `GET  /audio/{job_id}`          extract + cache 64k mono mp3 for WaveSurfer waveform
- `GET  /sessions`                return list of resumable sessions (ready/rendered, video still on disk)
- `PATCH /sessions/{job_id}`      rename a session's display_name — persists to SQLite
- `DELETE /sessions/{job_id}`     delete session from SQLite + hot cache + disk files

## SQLite schema (db.py)
```sql
CREATE TABLE jobs (
    job_id        TEXT PRIMARY KEY,
    status        TEXT NOT NULL DEFAULT 'uploaded',
    filename      TEXT,           -- original upload filename, never changes
    display_name  TEXT,           -- user-editable name shown in UI
    video_path    TEXT,
    words_json    TEXT,
    edl_json      TEXT,
    error         TEXT,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
)
```
- `display_name` column added via ALTER TABLE migration on startup (safe for existing DBs)
- `filename` = original upload name, never mutated
- `display_name` = user-facing name; falls back to `filename` if null

## JS state shape (editor.js)
```js
state = {
  words: [],          // [{ word, start, end, confidence, is_filler }]
  operations: [],     // [{ id, type, start, end, enabled }]
  displayName: '',    // pre-filled from API display_name, used for export filename
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

## Sessions panel (index.html)
- Fetches `GET /sessions` on page load; hidden if server offline or no sessions
- Shows below the drop zone and feature pills
- Each session card shows:
  - File icon, display_name, relative timestamp ("2h ago"), status dot (purple=ready, teal=exported)
  - **Inline rename**: click the name or the pencil icon → text input appears in place
    - Commits on blur or Enter, cancels on Escape
    - Once user edits the field it won't be auto-overwritten on re-open
    - PATCHes `/sessions/{job_id}` to persist to SQLite
  - **Resume button**: links to `editor.html?job={job_id}`
  - **Delete button**: two-step confirm (card turns red, shows "Delete? / Yes / Cancel")
    - On confirm: DELETEs from server (SQLite + disk files) and removes card from DOM

## Export panel (editor.html / editor.js)
- Output filename field added between summary and format selector
- Pre-filled with `state.displayName` (stripped of extension) when panel opens
- Once user manually edits the field, auto-fill stops (tracked via `data-user-edited`)
- `output_filename` sent in render payload as `stem + '.mp4'`
- Server uses `output_filename` as the download filename; falls back to display_name then filename

## Keyboard shortcuts (editor.js)
- `Delete` / `Backspace`          cut the word currently under the playhead
- `Cmd+Z` / `Ctrl+Z`              undo (pops history stack)
- `Cmd+Shift+Z` / `Ctrl+Y`        redo — uses `e.key.toLowerCase()` so Shift+Z works cross-browser
- `Space`                         play / pause (timeline.js)
- `← →`                           seek ±5s (timeline.js)

## Undo / Redo buttons (editor.html + editor.js)
- Two buttons added to topbar between the stats strip and "Revert all":
  - **Undo** (← arrow icon) — `onclick="undo()"`, `id="undoBtn"`
  - **Redo** (→ arrow icon) — `onclick="redo()"`, `id="redoBtn"`
- Both start `disabled`; `updateUndoRedoBtns()` called after every state mutation
  to enable/disable based on `state.history.length` / `state.future.length`
- `window.undo` and `window.redo` explicitly exported so `onclick` attributes resolve
- `.btn:disabled { opacity: 0.38; cursor: not-allowed; pointer-events: none; }` added to style.css

## Loudnorm LUFS buttons greyed out when toggle is off (editor.js)
- On DOMContentLoaded, `opt-loud` checkbox change event syncs opacity + pointer-events
  of `#lufsOptions` — greyed when unchecked, full opacity when checked

## Word token behaviour
**Left click** on word → seeks video/waveform to that word's timestamp
**Right click** → context menu (cut / bleep / mute / cut-all-similar / restore)

## Context menu actions
- `cut`              add cut_manual op at word timestamps
- `bleep`            add bleep op
- `mute`             add mute op
- `cut-all-similar`  cut_manual every word matching this text
- `restore`          remove all ops overlapping this word's timestamps

## Timeline (timeline.js) — WaveSurfer 6.6.4 + Regions plugin
### Smooth cursor architecture
The cursor is driven by `requestAnimationFrame` at 60fps, NOT by `timeupdate`.

- `timeupdate` (~4Hz) only re-anchors two variables: `anchorVideoTime` and `anchorWallTime`
- RAF loop interpolates forward: `interpolated = anchorVideoTime + (performance.now() - anchorWallTime) / 1000 * playbackRate`
- `setCursorTo(t)` calls `ws.seekTo()` with `programmaticSeek = true` to block the feedback loop
- On `play`: RAF starts, anchor set from `videoEl.currentTime`
- On `pause` / `seeked`: RAF stops, cursor snapped to exact position via `setCursorTo()`
- On speed change (`setSpeed`): anchor re-set so interpolation uses new rate immediately

### Other timeline behaviour
- WaveSurfer backend: `MediaElement` (not WebAudio) — no independent audio engine
- Volume always 0 — video element handles all audio
- `ws.play()` never called — cursor driven entirely by RAF
- `programmaticSeek` flag set true before every `ws.seekTo()` call we make,
  false immediately after — blocks the `seek` event handler from bouncing `videoEl.currentTime`
- `userSeeking` flag set on waveform mousedown (400ms window) — allows human scrub → video seek
- Op regions: `resize=true`, `drag=false` — drag edges to adjust cut timing
- Free-draw: `dragSelection` enabled — drag empty area to create `free_cut` region
  - Right-click free-cut region to delete it
  - Free cuts included in render payload merged with word ops
  - Words overlapping free-cut zone get `.in-free-cut` tint (informational only)
- Speed buttons: 0.5× 0.75× 1× 1.5× 2× → sets `videoEl.playbackRate` + re-anchors interpolation

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

## Known bugs
- Go-to-start button doesn't work (ws.seekTo(0) WaveSurfer 6 no-op bug)
- Timeline cursor slightly leads real position during buffering stalls (interpolation
  runs ahead of actual decode). Corrects automatically on next timeupdate tick.

## Fixed bugs (all sessions)
- **Cursor jumping every ~250ms**: timeupdate-driven ws.seekTo() caused visible hops.
  Fixed with RAF interpolation loop — cursor now moves at 60fps between timeupdate anchors.
- **Feedback loop / cursor snapping back**: ws.seekTo() fired WaveSurfer 'seek' event
  which reset videoEl.currentTime. Fixed with `programmaticSeek` flag.
- **No sound during playback**: WebAudio backend ran independent audio engine fighting
  the video element. Fixed by switching to MediaElement backend + removing ws.play() calls.
- **Redo shortcut broken**: `e.key === 'z'` failed when Shift held (browsers fire 'Z') → `.toLowerCase()`
- **Undo/Redo buttons missing**: added to topbar with disabled state management via `updateUndoRedoBtns()`
- **window.undo/redo not exported**: `onclick` attributes in HTML silently failed → added `window.undo = undo` etc.
- **LUFS buttons not greyed when loudnorm off**: added toggle listener on DOMContentLoaded
- **Save not persisting filler tag toggles**: `persistOps()` was missing from `setupFillerTags`
- **Op id NaN corruption**: `Math.max(...ids)` with NaN → fixed with `.filter(Number.isFinite)`
- **Auto-clean didn't update waveform**: `timeline.refresh()` was missing from `autoClean()`
- **Sessions panel missing from index.html**: rebuilt fetch + render
- **No way to rename sessions**: inline rename on cards → PATCHes SQLite
- **No way to delete sessions**: two-step confirm delete → DELETEs SQLite + disk
- **Export filename not customisable**: filename input in export panel, pre-filled from display_name
- **display_name column missing from DB**: ALTER TABLE migration on startup

## Backlog (priority order)
1. AI-contextual filler detection (send transcript to Claude, get per-word filler confidence)
2. "Bleep all / Mute all similar" in context menu
3. Threshold slider for silence detection (re-runs EDL with new min_silence value)
4. Dual-mode timeline: switch between Original and Edited preview
5. Add icons to represent fillers, silences, free cuts and bleeps in the waveform legend
6. Audio processing stats display (LUFS before/after via ffmpeg ebur128)
7. Export EDL / Premiere XML
8. "Tighten cuts" — compress silence to 0.2s instead of removing entirely
9. Batch processing multiple videos
10. Fix go-to-start button (ws.seekTo(0) no-op in WaveSurfer 6)

## How to start a new session efficiently
1. Upload latest .rar of the project
2. Paste this CONTEXT.md into your first message
3. Say which files are being touched — Claude reads only those
4. Claude will not re-read files that haven't changed
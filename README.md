# Sequence Auto Editor

Proof of concept for the Sequence AI video editor.
Drop in a video → AI finds fillers & silences → you decide what to cut → get your video back.

## Stack
- **Backend**: Python + FastAPI + ffmpeg
- **Transcription**: Deepgram nova-2 (word-level timestamps)
- **Frontend**: Vanilla HTML/CSS/JS (no framework needed at this scale)

## Setup

### 1. Install system dependencies
```bash
# macOS
brew install ffmpeg

# Ubuntu/Debian
sudo apt install ffmpeg
```

### 2. Set up Python server
```bash
cd server
python -m venv venv
source venv/bin/activate       # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

### 3. Get a Deepgram API key
Sign up at https://console.deepgram.com — you get $200 free credit.

```bash
export DEEPGRAM_API_KEY="your_key_here"
```

### 4. Run the server
```bash
cd server
uvicorn main:app --reload --port 8000
```

### 5. Open the frontend
Either open `client/index.html` directly in your browser,
or serve it with any static server:

```bash
cd client
python -m http.server 3000
# then open http://localhost:3000
```

## How it works

```
Upload video → FastAPI saves to uploads/
            → ffmpeg extracts mono 16kHz WAV
            → Deepgram nova-2 transcribes with word timestamps
            → EDL (Edit Decision List) generated from silences + filler words
            → Editor UI loads — word tokens are clickable
            → User toggles cuts, bleeps, adjusts audio settings
            → POST cut list to /render
            → ffmpeg concat filter applies all cuts
            → ffmpeg loudnorm normalizes to target LUFS
            → Download edited video
```

## File structure
```
sequence-editor/
  server/
    main.py          FastAPI routes + job state
    transcribe.py    Deepgram integration + EDL generation
    render.py        ffmpeg cut + audio processing
    requirements.txt
    uploads/         (created automatically)
    outputs/         (created automatically)
  client/
    index.html       Upload / landing page
    editor.html      Editing interface
    editor.js        All editor logic
    style.css        Shared styles
  README.md
```

## Next steps (Phase 2)
- [ ] Waveform visualization (WaveSurfer.js)
- [ ] Undo/redo keyboard shortcuts (Cmd+Z)
- [ ] Preview playback synced to transcript position
- [ ] Custom filler word management
- [ ] Export progress via WebSocket (real-time instead of polling)
- [ ] SQLite for job persistence (survive server restarts)
- [ ] Drag-to-select multiple words for manual cuts

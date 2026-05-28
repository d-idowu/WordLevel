"""
transcribe.py — Deepgram-powered transcription
------------------------------------------------
Extracts audio from video, sends to Deepgram nova-2,
returns word-level transcript + auto-generated EDL.

Set your key:  export DEEPGRAM_API_KEY="your_key_here"
Free credits:  https://console.deepgram.com  ($200 free)
"""

import os
import json
import subprocess
import tempfile
import urllib.request
import urllib.error
from pathlib import Path


DEEPGRAM_API_KEY = os.environ.get("DEEPGRAM_API_KEY", "")

FILLER_WORDS = {
    "um", "uh", "like", "you know", "basically", "literally",
    "actually", "so", "right", "okay", "hmm", "mhm"
}

SILENCE_MIN_SEC = 1.0   # flag silences longer than this


# ── AUDIO EXTRACTION ─────────────────────────────────────────────────────────

def extract_audio(video_path: str, output_path: str):
    """Use ffmpeg to pull mono 16kHz WAV — Deepgram's preferred format."""
    cmd = [
        "ffmpeg", "-y",
        "-i", video_path,
        "-ac", "1",
        "-ar", "16000",
        "-vn",
        output_path
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg audio extract failed:\n{result.stderr}")


# ── DEEPGRAM TRANSCRIPTION ────────────────────────────────────────────────────

def call_deepgram(audio_path: str) -> dict:
    """
    POST audio to Deepgram nova-2.
    Returns the full Deepgram response dict.
    """
    if not DEEPGRAM_API_KEY:
        raise RuntimeError(
            "DEEPGRAM_API_KEY not set. "
            "Get free credits at https://console.deepgram.com"
        )

    url = (
        "https://api.deepgram.com/v1/listen"
        "?model=nova-2"
        "&smart_format=true"
        "&punctuate=true"
        "&disfluencies=true"   # keeps um/uh in transcript
        "&words=true"          # word-level timestamps
        "&utterances=false"
    )

    with open(audio_path, "rb") as f:
        audio_data = f.read()

    req = urllib.request.Request(
        url,
        data=audio_data,
        headers={
            "Authorization": f"Token {DEEPGRAM_API_KEY}",
            "Content-Type": "audio/wav",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        raise RuntimeError(f"Deepgram API error {e.code}: {body}")


def parse_words(dg_response: dict) -> list[dict]:
    """
    Flatten Deepgram response into a simple word list:
    [{ word, start, end, confidence }, ...]
    """
    words = []
    channels = dg_response.get("results", {}).get("channels", [])
    if not channels:
        return words

    alternatives = channels[0].get("alternatives", [])
    if not alternatives:
        return words

    for w in alternatives[0].get("words", []):
        words.append({
            "word": w.get("word", "").strip(),
            "start": round(w.get("start", 0), 3),
            "end": round(w.get("end", 0), 3),
            "confidence": round(w.get("confidence", 1.0), 3),
            "is_filler": w.get("word", "").lower().strip(".,!?") in FILLER_WORDS,
        })
    return words


# ── EDL GENERATION ───────────────────────────────────────────────────────────

def generate_edl(words: list[dict]) -> dict:
    """
    Analyse word list and build an Edit Decision List.
    Each operation can be toggled on/off independently in the UI.
    """
    operations = []
    op_id = 1

    # Detect silences (gaps between consecutive words)
    for i in range(1, len(words)):
        gap = words[i]["start"] - words[i - 1]["end"]
        if gap >= SILENCE_MIN_SEC:
            operations.append({
                "id": op_id,
                "type": "cut_silence",
                "start": round(words[i - 1]["end"], 3),
                "end": round(words[i]["start"], 3),
                "duration": round(gap, 3),
                "enabled": True,
                "note": f'{gap:.1f}s silence after "{words[i-1]["word"]}"',
            })
            op_id += 1

    # Detect filler words
    for word in words:
        if word["is_filler"]:
            operations.append({
                "id": op_id,
                "type": "cut_filler",
                "word": word["word"],
                "start": word["start"],
                "end": word["end"],
                "enabled": True,
                "note": f'Filler: "{word["word"]}" at {word["start"]:.2f}s',
            })
            op_id += 1

    # Sort chronologically
    operations.sort(key=lambda x: x["start"])

    silences = sum(1 for op in operations if op["type"] == "cut_silence")
    fillers  = sum(1 for op in operations if op["type"] == "cut_filler")

    return {
        "version": 1,
        "total_operations": len(operations),
        "silences_found": silences,
        "fillers_found": fillers,
        "operations": operations,
    }


# ── MAIN ENTRY POINT ─────────────────────────────────────────────────────────

def transcribe_video(video_path: str) -> tuple[list, dict]:
    """
    Full pipeline: video → audio → Deepgram → words + EDL.
    Returns (words, edl).
    """
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        audio_path = tmp.name

    try:
        print(f"[transcribe] Extracting audio from {video_path}...")
        extract_audio(video_path, audio_path)

        print(f"[transcribe] Sending to Deepgram nova-2...")
        dg_response = call_deepgram(audio_path)

        words = parse_words(dg_response)
        print(f"[transcribe] Got {len(words)} words")

        edl = generate_edl(words)
        print(f"[transcribe] EDL: {edl['silences_found']} silences, {edl['fillers_found']} fillers")

        return words, edl

    finally:
        # Clean up temp audio file
        try:
            os.unlink(audio_path)
        except Exception:
            pass

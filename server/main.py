"""
main.py — Sequence Auto Editor backend
---------------------------------------
Run with:  uvicorn main:app --reload --port 8000
"""

import os
import uuid
import asyncio
from pathlib import Path
from fastapi import FastAPI, UploadFile, File, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import List, Optional
import shutil

from transcribe import transcribe_video
from render import render_edit

app = FastAPI(title="Sequence WordLevel")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

UPLOAD_DIR = Path("uploads")
OUTPUT_DIR = Path("outputs")
UPLOAD_DIR.mkdir(exist_ok=True)
OUTPUT_DIR.mkdir(exist_ok=True)

# ── in-memory job state (swap for Redis/SQLite in production) ─────────────────
jobs: dict = {}


# ── DATA MODELS ───────────────────────────────────────────────────────────────

class CutOperation(BaseModel):
    id: int
    type: str           # "cut_silence" | "cut_filler" | "cut_manual" | "bleep"
    start: float
    end: float
    enabled: bool

class AudioSettings(BaseModel):
    noise_gate: bool = True
    compressor: bool = True
    loudnorm: bool = True
    target_lufs: float = -14.0   # -14 YouTube, -16 Spotify, -23 broadcast

class RenderRequest(BaseModel):
    job_id: str
    operations: List[CutOperation]
    audio: AudioSettings


# ── ROUTES ────────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/upload")
async def upload_video(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...)
):
    """Receive a video file, kick off transcription, return a job_id."""

    allowed = {".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v"}
    ext = Path(file.filename).suffix.lower()
    if ext not in allowed:
        raise HTTPException(400, f"Unsupported format: {ext}")

    job_id = str(uuid.uuid4())
    video_path = UPLOAD_DIR / f"{job_id}{ext}"

    # Save upload to disk
    with open(video_path, "wb") as f:
        shutil.copyfileobj(file.file, f)

    jobs[job_id] = {
        "status": "uploaded",
        "filename": file.filename,
        "video_path": str(video_path),
        "transcript": None,
        "edl": None,
        "error": None,
    }

    # Run transcription in background so upload returns immediately
    background_tasks.add_task(run_transcription, job_id, video_path)

    return {"job_id": job_id, "status": "transcribing"}


@app.get("/status/{job_id}")
async def get_status(job_id: str):
    """Poll this to know when transcription is done."""
    if job_id not in jobs:
        raise HTTPException(404, "Job not found")
    job = jobs[job_id]
    return {
        "status": job["status"],
        "filename": job["filename"],
        "error": job["error"],
    }


@app.get("/transcript/{job_id}")
async def get_transcript(job_id: str):
    """Return the full transcript + auto-generated EDL once ready."""
    if job_id not in jobs:
        raise HTTPException(404, "Job not found")
    job = jobs[job_id]
    if job["status"] != "ready":
        raise HTTPException(400, f"Not ready yet — status: {job['status']}")
    return {
        "words": job["transcript"],
        "edl": job["edl"],
    }


@app.post("/render")
async def render_video(req: RenderRequest, background_tasks: BackgroundTasks):
    """Accept the final cut list + audio settings, render the output video."""
    if req.job_id not in jobs:
        raise HTTPException(404, "Job not found")
    job = jobs[req.job_id]
    if job["status"] not in ("ready", "rendered"):
        raise HTTPException(400, "Transcript not ready")

    jobs[req.job_id]["status"] = "rendering"
    background_tasks.add_task(run_render, req.job_id, req.operations, req.audio)
    return {"job_id": req.job_id, "status": "rendering"}


@app.get("/download/{job_id}")
async def download_video(job_id: str):
    """Return the finished video file."""
    if job_id not in jobs:
        raise HTTPException(404, "Job not found")
    job = jobs[job_id]
    if job["status"] != "rendered":
        raise HTTPException(400, f"Not rendered yet — status: {job['status']}")
    output_path = OUTPUT_DIR / f"{job_id}_edited.mp4"
    if not output_path.exists():
        raise HTTPException(500, "Output file missing")
    return FileResponse(
        str(output_path),
        media_type="video/mp4",
        filename=f"sequence_edited_{job['filename']}"
    )


# ── BACKGROUND TASKS ─────────────────────────────────────────────────────────

async def run_transcription(job_id: str, video_path: Path):
    try:
        jobs[job_id]["status"] = "transcribing"
        words, edl = await asyncio.to_thread(transcribe_video, str(video_path))
        jobs[job_id]["transcript"] = words
        jobs[job_id]["edl"] = edl
        jobs[job_id]["status"] = "ready"
    except Exception as e:
        jobs[job_id]["status"] = "error"
        jobs[job_id]["error"] = str(e)


async def run_render(job_id: str, operations: List[CutOperation], audio: AudioSettings):
    try:
        video_path = jobs[job_id]["video_path"]
        output_path = str(OUTPUT_DIR / f"{job_id}_edited.mp4")
        ops = [op.dict() for op in operations if op.enabled]
        await asyncio.to_thread(render_edit, video_path, output_path, ops, audio.dict())
        jobs[job_id]["status"] = "rendered"
    except Exception as e:
        jobs[job_id]["status"] = "error"
        jobs[job_id]["error"] = str(e)


# ── SERVE FRONTEND ────────────────────────────────────────────────────────────
# Uncomment once you have the client/ folder built
# app.mount("/", StaticFiles(directory="../client", html=True), name="static")

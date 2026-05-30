"""
main.py — Sequence Auto Editor backend
---------------------------------------
Run with:  uvicorn main:app --reload --port 8000
"""

import os
import uuid
import json
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
from db import init_db, upsert_job, load_job, load_all_jobs

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

# ── in-memory job cache (source of truth is SQLite, this is the hot cache) ───
jobs: dict = {}


def _job_to_mem(db_row: dict) -> dict:
    """Convert a DB row into the in-memory jobs dict shape."""
    return {
        "status":     db_row["status"],
        "filename":   db_row["filename"],
        "video_path": db_row["video_path"],
        "transcript": db_row["words"],
        "edl":        db_row["edl"],
        "error":      db_row["error"],
    }


@app.on_event("startup")
async def startup():
    """Init DB and reload all known jobs into the hot cache."""
    init_db()
    for row in load_all_jobs():
        # Only restore jobs whose video file still exists on disk
        if row["video_path"] and Path(row["video_path"]).exists():
            jobs[row["job_id"]] = _job_to_mem(row)
    print(f"[startup] Restored {len(jobs)} job(s) from DB")


# ── DATA MODELS ───────────────────────────────────────────────────────────────

class CutOperation(BaseModel):
    id: int
    type: str
    start: float
    end: float
    enabled: bool

class AudioSettings(BaseModel):
    noise_gate: bool = True
    compressor: bool = True
    loudnorm: bool = True
    target_lufs: float = -14.0

class RenderRequest(BaseModel):
    job_id: str
    operations: List[CutOperation]
    audio: AudioSettings


# ── ROUTES ────────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/sessions")
async def list_sessions():
    """
    Return all saved sessions for the resume UI on the upload page.
    Only returns jobs that are 'ready' or 'rendered' and still have their video.
    """
    sessions = []
    for row in load_all_jobs():
        if row["status"] not in ("ready", "rendered"):
            continue
        if not row["video_path"] or not Path(row["video_path"]).exists():
            continue
        sessions.append({
            "job_id":    row["job_id"],
            "filename":  row["filename"],
            "status":    row["status"],
            "updated_at": row["updated_at"],
        })
    return {"sessions": sessions}


@app.post("/upload")
async def upload_video(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...)
):
    allowed = {".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v"}
    ext = Path(file.filename).suffix.lower()
    if ext not in allowed:
        raise HTTPException(400, f"Unsupported format: {ext}")

    job_id = str(uuid.uuid4())
    video_path = UPLOAD_DIR / f"{job_id}{ext}"

    with open(video_path, "wb") as f:
        shutil.copyfileobj(file.file, f)

    job = {
        "status":     "uploaded",
        "filename":   file.filename,
        "video_path": str(video_path),
        "transcript": None,
        "edl":        None,
        "error":      None,
    }
    jobs[job_id] = job

    # Persist immediately so the job survives a restart even before transcription
    upsert_job(
        job_id,
        status="uploaded",
        filename=file.filename,
        video_path=str(video_path),
    )

    background_tasks.add_task(run_transcription, job_id, video_path)
    return {"job_id": job_id, "status": "transcribing"}


@app.get("/status/{job_id}")
async def get_status(job_id: str):
    if job_id not in jobs:
        # Try restoring from DB (e.g. direct URL navigation after restart)
        row = load_job(job_id)
        if row and row["video_path"] and Path(row["video_path"]).exists():
            jobs[job_id] = _job_to_mem(row)
        else:
            raise HTTPException(404, "Job not found")
    job = jobs[job_id]
    return {
        "status":   job["status"],
        "filename": job["filename"],
        "error":    job["error"],
    }


@app.get("/transcript/{job_id}")
async def get_transcript(job_id: str):
    if job_id not in jobs:
        row = load_job(job_id)
        if row and row["video_path"] and Path(row["video_path"]).exists():
            jobs[job_id] = _job_to_mem(row)
        else:
            raise HTTPException(404, "Job not found")
    job = jobs[job_id]
    if job["status"] != "ready" and job["status"] != "rendered":
        raise HTTPException(400, f"Not ready yet — status: {job['status']}")
    return {
        "words": job["transcript"],
        "edl":   job["edl"],
    }


@app.post("/render")
async def render_video(req: RenderRequest, background_tasks: BackgroundTasks):
    if req.job_id not in jobs:
        raise HTTPException(404, "Job not found")
    job = jobs[req.job_id]
    if job["status"] not in ("ready", "rendered"):
        raise HTTPException(400, "Transcript not ready")

    jobs[req.job_id]["status"] = "rendering"
    upsert_job(req.job_id, status="rendering")
    background_tasks.add_task(run_render, req.job_id, req.operations, req.audio)
    return {"job_id": req.job_id, "status": "rendering"}


@app.get("/download/{job_id}")
async def download_video(job_id: str):
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


@app.get("/video/{job_id}")
async def stream_video(job_id: str):
    if job_id not in jobs:
        raise HTTPException(404, "Job not found")
    video_path = jobs[job_id]["video_path"]
    if not Path(video_path).exists():
        raise HTTPException(404, "Video file not found")
    return FileResponse(video_path, media_type="video/mp4")


@app.get("/audio/{job_id}")
async def stream_audio(job_id: str):
    if job_id not in jobs:
        raise HTTPException(404, "Job not found")
    video_path = jobs[job_id]["video_path"]
    audio_path = UPLOAD_DIR / f"{job_id}_preview.mp3"

    if not audio_path.exists():
        import subprocess
        result = subprocess.run([
            "ffmpeg", "-y", "-i", video_path,
            "-vn", "-ac", "1", "-ar", "22050",
            "-b:a", "64k",
            str(audio_path)
        ], capture_output=True)
        if result.returncode != 0:
            raise HTTPException(500, "Audio extraction failed")

    return FileResponse(str(audio_path), media_type="audio/mpeg")


# ── BACKGROUND TASKS ─────────────────────────────────────────────────────────

async def run_transcription(job_id: str, video_path: Path):
    try:
        jobs[job_id]["status"] = "transcribing"
        upsert_job(job_id, status="transcribing")

        words, edl = await asyncio.to_thread(transcribe_video, str(video_path))

        jobs[job_id]["transcript"] = words
        jobs[job_id]["edl"]        = edl
        jobs[job_id]["status"]     = "ready"

        # Persist transcript + EDL to DB — survives server restart from here
        upsert_job(
            job_id,
            status="ready",
            words_json=json.dumps(words),
            edl_json=json.dumps(edl),
        )
    except Exception as e:
        jobs[job_id]["status"] = "error"
        jobs[job_id]["error"]  = str(e)
        upsert_job(job_id, status="error", error=str(e))


async def run_render(job_id: str, operations: List[CutOperation], audio: AudioSettings):
    try:
        video_path  = jobs[job_id]["video_path"]
        output_path = str(OUTPUT_DIR / f"{job_id}_edited.mp4")
        ops = [op.dict() for op in operations if op.enabled]
        await asyncio.to_thread(render_edit, video_path, output_path, ops, audio.dict())
        jobs[job_id]["status"] = "rendered"
        upsert_job(job_id, status="rendered")
    except Exception as e:
        jobs[job_id]["status"] = "error"
        jobs[job_id]["error"]  = str(e)
        upsert_job(job_id, status="error", error=str(e))


# ── SERVE FRONTEND ────────────────────────────────────────────────────────────
# app.mount("/", StaticFiles(directory="../client", html=True), name="static")
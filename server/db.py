"""
db.py — SQLite persistence for Sequence Auto Editor
----------------------------------------------------
Stores job metadata, transcripts, and EDLs so sessions survive
server restarts. Words + EDL are stored as JSON blobs.

Schema lives in a single file: server/sequence.db
"""

import sqlite3
import json
from pathlib import Path

DB_PATH = Path(__file__).parent / "sequence.db"


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    """Create tables if they don't exist. Safe to call on every startup."""
    with get_conn() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS jobs (
                job_id      TEXT PRIMARY KEY,
                status      TEXT NOT NULL DEFAULT 'uploaded',
                filename    TEXT,
                display_name TEXT,
                video_path  TEXT,
                words_json  TEXT,
                edl_json    TEXT,
                error       TEXT,
                created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        """)
        # Migration: add display_name column if it doesn't exist yet
        # (handles existing DBs created before this column was added)
        try:
            conn.execute("ALTER TABLE jobs ADD COLUMN display_name TEXT")
        except Exception:
            pass  # column already exists
        conn.commit()


def upsert_job(job_id: str, **fields):
    """Insert or update a job row. Pass only the fields you want to set."""
    with get_conn() as conn:
        row = conn.execute("SELECT job_id FROM jobs WHERE job_id = ?", (job_id,)).fetchone()
        if row:
            set_clause = ", ".join(f"{k} = ?" for k in fields)
            set_clause += ", updated_at = CURRENT_TIMESTAMP"
            values = list(fields.values()) + [job_id]
            conn.execute(f"UPDATE jobs SET {set_clause} WHERE job_id = ?", values)
        else:
            fields["job_id"] = job_id
            cols = ", ".join(fields.keys())
            placeholders = ", ".join("?" for _ in fields)
            conn.execute(f"INSERT INTO jobs ({cols}) VALUES ({placeholders})", list(fields.values()))
        conn.commit()


def load_job(job_id: str) -> dict | None:
    """Return a job as a plain dict, or None if not found."""
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM jobs WHERE job_id = ?", (job_id,)).fetchone()
        if not row:
            return None
        d = dict(row)
        d["words"]  = json.loads(d.pop("words_json") or "null")
        d["edl"]    = json.loads(d.pop("edl_json")   or "null")
        return d


def load_all_jobs() -> list[dict]:
    """Return all jobs ordered by most recent first."""
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM jobs ORDER BY updated_at DESC"
        ).fetchall()
        result = []
        for row in rows:
            d = dict(row)
            d["words"] = json.loads(d.pop("words_json") or "null")
            d["edl"]   = json.loads(d.pop("edl_json")   or "null")
            result.append(d)
        return result
"""
render.py — ffmpeg-powered edit renderer
"""

import subprocess
from pathlib import Path


# ── MAIN ENTRY ────────────────────────────────────────────────────────────────

def render_edit(
    input_path: str,
    output_path: str,
    operations: list[dict],
    audio_settings: dict,
) -> None:
    duration = get_duration(input_path)

    cuts   = [op for op in operations if op["type"] in ("cut_silence", "cut_filler", "cut_manual", "free_cut")]
    bleeps = [op for op in operations if op["type"] == "bleep"]
    mutes  = [op for op in operations if op["type"] == "mute"]

    keep_segments = build_keep_segments(cuts, duration)
    if not keep_segments:
        raise ValueError("All segments are cut — nothing left to render")

    cmd = build_ffmpeg_command(
        input_path, output_path,
        keep_segments, bleeps, mutes,
        audio_settings, duration,
    )

    print(f"[render] ffmpeg command:\n{' '.join(cmd)}\n")
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg render failed:\n{result.stderr[-3000:]}")
    print(f"[render] Done → {output_path}")


# ── SEGMENT BUILDING ──────────────────────────────────────────────────────────

def build_keep_segments(cuts: list[dict], duration: float) -> list[tuple]:
    if not cuts:
        return [(0.0, duration)]

    sorted_cuts = sorted(cuts, key=lambda x: x["start"])
    merged = []
    cur_start = sorted_cuts[0]["start"]
    cur_end   = sorted_cuts[0]["end"]

    for cut in sorted_cuts[1:]:
        if cut["start"] <= cur_end:
            cur_end = max(cur_end, cut["end"])
        else:
            merged.append((cur_start, cur_end))
            cur_start = cut["start"]
            cur_end   = cut["end"]
    merged.append((cur_start, cur_end))

    keep = []
    prev_end = 0.0
    for cut_start, cut_end in merged:
        if cut_start > prev_end + 0.001:
            keep.append((round(prev_end, 3), round(cut_start, 3)))
        prev_end = cut_end
    if prev_end < duration - 0.001:
        keep.append((round(prev_end, 3), round(duration, 3)))

    return keep


# ── TIMESTAMP REMAPPING ───────────────────────────────────────────────────────

def map_time(t: float, keep_segments: list[tuple]) -> float | None:
    """Map original-timeline time to new-timeline time. Returns None if in a cut."""
    offset = 0.0
    for seg_start, seg_end in keep_segments:
        if seg_start <= t <= seg_end:
            return round(offset + (t - seg_start), 3)
        offset += seg_end - seg_start
    return None


def remap_ops(ops: list[dict], keep_segments: list[tuple]) -> list[dict]:
    remapped = []
    for op in ops:
        new_start = map_time(op["start"], keep_segments)
        new_end   = map_time(op["end"],   keep_segments)
        if new_start is not None and new_end is not None:
            remapped.append({**op, "new_start": new_start, "new_end": new_end})
    return remapped


# ── FFMPEG COMMAND BUILDER ────────────────────────────────────────────────────

def build_ffmpeg_command(
    input_path: str,
    output_path: str,
    keep_segments: list[tuple],
    bleeps: list[dict],
    mutes: list[dict],
    audio_settings: dict,
    duration: float,
) -> list[str]:

    cmd = ["ffmpeg", "-y", "-i", input_path]
    filters = []
    seg_labels_v = []
    seg_labels_a = []

    # ── 1. Trim each keep segment ─────────────────────────────────────────────
    for i, (seg_start, seg_end) in enumerate(keep_segments):
        filters.append(f"[0:v]trim=start={seg_start}:end={seg_end},setpts=PTS-STARTPTS[v{i}]")
        filters.append(f"[0:a]atrim=start={seg_start}:end={seg_end},asetpts=PTS-STARTPTS[a{i}]")
        seg_labels_v.append(f"[v{i}]")
        seg_labels_a.append(f"[a{i}]")

    n = len(keep_segments)
    filters.append(f"{''.join(seg_labels_v)}concat=n={n}:v=1:a=0[vcat]")
    filters.append(f"{''.join(seg_labels_a)}concat=n={n}:v=0:a=1[acat]")

    current_audio = "[acat]"

    # ── 2. Mutes — silence audio in window using volume filter chain ──────────
    # Each mute adds one volume=0 enable expression chained together
    remapped_mutes = remap_ops(mutes, keep_segments)
    if remapped_mutes:
        current_audio = apply_mutes(remapped_mutes, current_audio, filters)

    # ── 3. Bleeps — silence window + overlay a delayed 1kHz tone ─────────────
    remapped_bleeps = remap_ops(bleeps, keep_segments)
    if remapped_bleeps:
        current_audio = apply_bleeps(remapped_bleeps, current_audio, filters, cmd)

    # ── 4. Audio processing chain ─────────────────────────────────────────────
    audio_chain = []
    if audio_settings.get("noise_gate"):
        audio_chain.append("afftdn=nf=-25")
    if audio_settings.get("compressor"):
        audio_chain.append("acompressor=threshold=-18dB:ratio=4:attack=5:release=50")
    if audio_settings.get("loudnorm"):
        target = audio_settings.get("target_lufs", -14.0)
        audio_chain.append(f"loudnorm=I={target}:TP=-1.5:LRA=11")

    if audio_chain:
        filters.append(f"{current_audio}{','.join(audio_chain)}[afinal]")
        current_audio = "[afinal]"
    else:
        filters.append(f"{current_audio}acopy[afinal]")
        current_audio = "[afinal]"

    filter_complex = ";".join(filters)

    cmd += [
        "-filter_complex", filter_complex,
        "-map", "[vcat]",
        "-map", current_audio,
        "-c:v", "libx264",
        "-preset", "fast",
        "-crf", "18",
        "-c:a", "aac",
        "-b:a", "192k",
        "-movflags", "+faststart",
        output_path,
    ]

    return cmd


# ── MUTE FILTER ───────────────────────────────────────────────────────────────

def apply_mutes(mutes: list[dict], audio_in: str, filters: list) -> str:
    """
    Chain volume=0 expressions for each mute window.
    Uses a single volume filter with multiple enable conditions OR'd together.
    This is the simplest correct approach — no tone, just silence.
    """
    # Build one volume filter per mute (chaining is safest for multiple windows)
    current = audio_in
    for i, m in enumerate(mutes):
        t0  = m["new_start"]
        t1  = m["new_end"]
        out = f"[muted{i}]"
        # volume=0 only between t0 and t1, pass-through otherwise
        filters.append(
            f"{current}volume=enable='between(t\\,{t0}\\,{t1})':volume=0{out}"
        )
        current = out
    return current


# ── BLEEP FILTER ──────────────────────────────────────────────────────────────

def apply_bleeps(bleeps: list[dict], audio_in: str, filters: list, cmd: list) -> str:
    """
    For each bleep:
      1. Silence the original audio in the window (volume=0)
      2. Generate a 1kHz sine tone of the exact duration
      3. Delay the tone to the correct position with adelay
      4. Mix delayed tone into the silenced audio with amix

    Key fix: adelay pushes the tone to the right position so it doesn't
    bleed into t=0. The tone is generated at t=0 by aevalsrc, then
    adelay shifts it by new_start milliseconds before mixing.
    """
    current = audio_in

    for i, bleep in enumerate(bleeps):
        t0  = bleep["new_start"]
        t1  = bleep["new_end"]
        dur = round(t1 - t0, 3)
        delay_ms = int(round(t0 * 1000))  # adelay takes milliseconds

        sil_label  = f"[bsil{i}]"
        tone_label = f"[btone{i}]"
        dly_label  = f"[bdly{i}]"
        out_label  = f"[bout{i}]"

        # Step 1: silence the window in the main audio
        filters.append(
            f"{current}volume=enable='between(t\\,{t0}\\,{t1})':volume=0{sil_label}"
        )

        # Step 2: generate 1kHz sine tone for exactly `dur` seconds
        # aevalsrc always starts at t=0, so we delay it in step 3
        filters.append(
            f"aevalsrc=sin(2*PI*1000*t):s=44100:c=stereo:d={dur}{tone_label}"
        )

        # Step 3: delay the tone to land at the right position
        # adelay=Xms|Xms delays both L and R channels
        filters.append(
            f"{tone_label}adelay={delay_ms}|{delay_ms}{dly_label}"
        )

        # Step 4: mix silenced audio + delayed tone
        # duration=first keeps the length of the main (silenced) audio track
        filters.append(
            f"{sil_label}{dly_label}amix=inputs=2:duration=first:dropout_transition=0{out_label}"
        )

        current = out_label

    return current


# ── UTILS ─────────────────────────────────────────────────────────────────────

def get_duration(video_path: str) -> float:
    cmd = [
        "ffprobe", "-v", "quiet",
        "-show_entries", "format=duration",
        "-of", "csv=p=0",
        video_path
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"ffprobe failed: {result.stderr}")
    return float(result.stdout.strip())
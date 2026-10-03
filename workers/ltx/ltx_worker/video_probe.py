"""Prove a generated file is the video that was asked for, before anyone is told it exists.

A pipeline returning without an exception proves nothing about the file on disk, so
success requires: a non-empty file ffprobe can open, exactly one video stream, the
requested resolution, every requested frame (decoded and counted — exact for H.264), a
container duration consistent with numFrames/fps, and no audio stream (the worker writes
video-only; see engine.py).
"""

from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path


class InvalidOutput(RuntimeError):
    """The generated file is not the requested video."""


@dataclass(frozen=True)
class ProbeResult:
    width: int
    height: int
    frames: int
    duration_sec: float
    codec: str
    size_bytes: int


def ffprobe_bin() -> str:
    path = shutil.which("ffprobe")
    if not path:
        raise InvalidOutput("ffprobe is not available in this image")
    return path


def probe_video(path: Path, timeout_sec: float = 120.0) -> ProbeResult:
    if not path.is_file():
        raise InvalidOutput("generated file does not exist")
    size = path.stat().st_size
    if size == 0:
        raise InvalidOutput("generated file is empty")
    try:
        r = subprocess.run(
            [
                ffprobe_bin(), "-v", "error", "-count_frames",
                "-show_entries", "stream=codec_type,codec_name,width,height,nb_read_frames:format=duration",
                "-of", "json", str(path),
            ],
            capture_output=True, text=True, timeout=timeout_sec, check=False,
        )
    except subprocess.TimeoutExpired:
        raise InvalidOutput("ffprobe timed out on the generated file") from None
    if r.returncode != 0:
        raise InvalidOutput("ffprobe could not read the generated file")
    try:
        info = json.loads(r.stdout)
    except json.JSONDecodeError:
        raise InvalidOutput("ffprobe returned unreadable output") from None

    streams = info.get("streams") or []
    video = [s for s in streams if s.get("codec_type") == "video"]
    if len(video) != 1:
        raise InvalidOutput(f"expected exactly one video stream, found {len(video)}")
    if any(s.get("codec_type") == "audio" for s in streams):
        raise InvalidOutput("generated file has an audio stream; the worker writes video-only files")
    v = video[0]
    try:
        frames = int(v["nb_read_frames"])
        width, height = int(v["width"]), int(v["height"])
        duration = float((info.get("format") or {})["duration"])
    except (KeyError, TypeError, ValueError):
        raise InvalidOutput("ffprobe did not report frames, size and duration") from None
    return ProbeResult(width, height, frames, duration, str(v.get("codec_name") or ""), size)


def check_video(path: Path, *, width: int, height: int, num_frames: int, fps: int) -> ProbeResult:
    """Raise InvalidOutput unless `path` is exactly the requested clip."""
    p = probe_video(path)
    if (p.width, p.height) != (width, height):
        raise InvalidOutput(f"resolution is {p.width}x{p.height}, expected {width}x{height}")
    if p.frames != num_frames:
        raise InvalidOutput(f"video has {p.frames} frames, expected {num_frames}")
    expected = num_frames / fps
    # One frame of slack covers container rounding; more means the timing is wrong.
    if abs(p.duration_sec - expected) > 1.0 / fps + 0.05:
        raise InvalidOutput(f"duration is {p.duration_sec:.3f}s, expected {expected:.3f}s")
    return p

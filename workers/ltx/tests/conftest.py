"""Fixtures: a throwaway "network volume", a valid input image, and a fake LtxEngine.

No GPU, no torch, no network, no weights. The fake engine writes a REAL tiny MP4 with the
system ffmpeg, so the handler's ffprobe validation runs against a real file.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

from ltx_worker.engine import EngineError, EngineOutput
from ltx_worker.schemas import GenerationRequest

HAVE_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))
needs_ffmpeg = pytest.mark.skipif(not HAVE_FFMPEG, reason="ffmpeg/ffprobe not installed")


def make_mp4(path: Path, *, width: int, height: int, frames: int, fps: int, audio: bool = False) -> None:
    args = ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"testsrc2=s={width}x{height}:r={fps}"]
    if audio:
        args += ["-f", "lavfi", "-i", "sine=frequency=440", "-shortest", "-c:a", "aac"]
    args += ["-frames:v", str(frames), "-c:v", "libx264", "-pix_fmt", "yuv420p", str(path)]
    subprocess.run(args, check=True)


class FakeEngine:
    """Records every call; `mode` selects how generate misbehaves."""

    def __init__(self, mode: str = "ok") -> None:
        self.mode = mode
        self.load_calls = 0
        self._loaded = False
        self.calls: list[tuple[GenerationRequest, Path, Path]] = []
        self.peak: int | None = None

    @property
    def loaded(self) -> bool:
        return self._loaded

    def load(self) -> None:
        if not self._loaded:
            self.load_calls += 1
            self._loaded = True

    def generate(self, req: GenerationRequest, image: Path, out: Path) -> EngineOutput:
        self.calls.append((req, image, out))
        if self.mode == "raise":
            raise EngineError("RuntimeError: CUDA out of memory")
        if self.mode == "empty":
            out.write_bytes(b"")
        elif self.mode == "garbage":
            out.write_bytes(b"this is not an mp4 at all" * 100)
        elif self.mode == "wrong_size":
            make_mp4(out, width=req.width * 2, height=req.height, frames=req.num_frames, fps=req.fps)
        elif self.mode == "short":
            make_mp4(out, width=req.width, height=req.height, frames=req.num_frames - 8, fps=req.fps)
        elif self.mode == "with_audio":
            make_mp4(out, width=req.width, height=req.height, frames=req.num_frames, fps=req.fps, audio=True)
        elif self.mode == "misreport":
            make_mp4(out, width=req.width, height=req.height, frames=req.num_frames, fps=req.fps)
            return EngineOutput(num_frames=req.num_frames - 8)
        else:
            make_mp4(out, width=req.width, height=req.height, frames=req.num_frames, fps=req.fps)
        return EngineOutput(num_frames=req.num_frames, peak_cuda_bytes=self.peak)

    def info(self) -> dict[str, object]:
        return {"model": "LTX-2.5", "pipeline": "distilled", "residency": "page_cache", "quantization": "fp8-cast"}


@pytest.fixture
def volume(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    vol = tmp_path / "volume"
    (vol / "jobs" / "k1").mkdir(parents=True)
    monkeypatch.setenv("RUNPOD_VOLUME_MOUNT", str(vol))
    return vol.resolve()


@pytest.fixture
def image(volume: Path) -> Path:
    img = volume / "jobs" / "k1" / "input.png"
    # A real 1x1 PNG: the fake engine never reads it, but it is a genuine image file.
    img.write_bytes(
        bytes.fromhex(
            "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
            "1f15c4890000000d49444154789c6360f8cfc0f01f0005fe02fea7d6"
            "a4ff0000000049454e44ae426082"
        )
    )
    return img


def valid_input(**over: object) -> dict[str, object]:
    base: dict[str, object] = {
        "prompt": "slow push-in on a quiet harbour at dawn",
        "imagePath": "jobs/k1/input.png",
        "imageStrength": 1.0,
        "outputPath": "jobs/k1/output.mp4",
        "width": 128,
        "height": 64,
        "fps": 24,
        "numFrames": 17,
        "seed": 42,
    }
    base.update(over)
    return base

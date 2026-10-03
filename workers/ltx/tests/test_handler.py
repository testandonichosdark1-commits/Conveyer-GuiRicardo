import json
import os
import re
import shutil
from pathlib import Path

import pytest

from ltx_worker import handler as handler_mod
from ltx_worker.handler import handle
from ltx_worker.video_probe import InvalidOutput

from .conftest import FakeEngine, needs_ffmpeg, valid_input


def tree(root: Path) -> set[str]:
    return {str(p.relative_to(root)) for p in root.rglob("*")}


def outside_snapshot(tmp_path: Path, volume: Path) -> set[str]:
    return {p for p in tree(tmp_path) if not p.startswith(volume.name)}


# ── success ──────────────────────────────────────────────────────────────────────────────


@needs_ffmpeg
def test_valid_job_writes_the_output_and_returns_small_metadata(volume: Path, image: Path):
    engine = FakeEngine()
    res = handle(valid_input(), engine=engine)
    assert "error" not in res, res
    out = volume / "jobs" / "k1" / "output.mp4"
    assert out.is_file() and out.stat().st_size > 0
    assert {k: res[k] for k in ("storage", "path", "model", "pipeline", "width", "height", "fps", "numFrames", "durationSec", "seed")} == {
        "storage": "network_volume",
        "path": "jobs/k1/output.mp4",
        "model": "LTX-2.5",
        "pipeline": "distilled",
        "width": 128,
        "height": 64,
        "fps": 24,
        "numFrames": 17,
        "durationSec": round(17 / 24, 6),
        "seed": 42,
    }
    assert res["bytes"] == out.stat().st_size
    assert set(res["timings"]) == {"loadSec", "generateSec", "validateSec", "totalSec"}


@needs_ffmpeg
def test_sha256_is_the_digest_of_the_published_file(volume: Path, image: Path):
    import hashlib

    res = handle(valid_input(), engine=FakeEngine())
    out = volume / "jobs" / "k1" / "output.mp4"
    assert re.fullmatch(r"[0-9a-f]{64}", res["sha256"])
    assert res["sha256"] == hashlib.sha256(out.read_bytes()).hexdigest()


@needs_ffmpeg
def test_different_files_have_different_sha256(volume: Path, image: Path):
    a = handle(valid_input(outputPath="jobs/k1/a.mp4"), engine=FakeEngine())
    b = handle(valid_input(outputPath="jobs/k1/b.mp4", width=192), engine=FakeEngine())
    assert a["sha256"] != b["sha256"]


@needs_ffmpeg
def test_hashing_reads_nothing_outside_the_volume(volume: Path, image: Path, monkeypatch: pytest.MonkeyPatch):
    import builtins

    opened: list[str] = []
    real_open = builtins.open

    def spy(file, *a, **k):
        opened.append(str(file))
        return real_open(file, *a, **k)

    monkeypatch.setattr(handler_mod, "open", spy, raising=False)
    res = handle(valid_input(), engine=FakeEngine())
    assert "error" not in res
    assert opened and all(Path(p).resolve().is_relative_to(volume) for p in opened)


@needs_ffmpeg
def test_result_has_no_media_no_base64_and_no_absolute_paths(volume: Path, image: Path):
    res = handle(valid_input(), engine=FakeEngine())
    blob = json.dumps(res)
    assert len(blob) < 2048
    assert str(volume) not in blob and "/runpod-volume" not in blob
    assert not re.search(r"[A-Za-z0-9+/=]{200,}", blob)
    assert res["path"] == "jobs/k1/output.mp4"


@needs_ffmpeg
def test_engine_receives_the_exact_request_and_resolved_paths(volume: Path, image: Path):
    engine = FakeEngine()
    handle(valid_input(prompt="p", seed=7, width=192, height=128, fps=30, numFrames=25, imageStrength=0.8), engine=engine)
    (req, img, out), = engine.calls
    assert (req.prompt, req.seed, req.width, req.height, req.fps, req.num_frames, req.image_strength) == ("p", 7, 192, 128, 30, 25, 0.8)
    assert img == image
    # The engine writes a temporary sibling, never the final path.
    assert out.parent == volume / "jobs" / "k1" and out.name.startswith(".output.partial-") and out.suffix == ".mp4"


@needs_ffmpeg
def test_model_is_loaded_once_and_reused_across_jobs(volume: Path, image: Path):
    engine = FakeEngine()
    r1 = handle(valid_input(outputPath="jobs/k1/a.mp4"), engine=engine)
    r2 = handle(valid_input(outputPath="jobs/k1/b.mp4", seed=8), engine=engine)
    assert "error" not in r1 and "error" not in r2
    assert engine.load_calls == 1
    assert len(engine.calls) == 2


@needs_ffmpeg
def test_success_leaves_no_partial_file_and_replaces_an_old_output_atomically(volume: Path, image: Path):
    out = volume / "jobs" / "k1" / "output.mp4"
    out.write_bytes(b"old result")
    handle(valid_input(), engine=FakeEngine())
    assert out.read_bytes()[:4] != b"old "
    assert not [p for p in out.parent.iterdir() if ".partial-" in p.name]


# ── input / path rejections (nothing generated, nothing written) ─────────────────────────


@pytest.mark.parametrize(
    ("over", "code"),
    [
        ({"prompt": ""}, "invalid_input"),
        ({"imagePath": None}, "invalid_input"),
        ({"numFrames": 24}, "invalid_input"),
        ({"width": 100}, "invalid_input"),
        ({"imagePath": "jobs/k1/missing.png"}, "invalid_path"),
        ({"imagePath": "../../etc/passwd.png"}, "invalid_path"),
        ({"imagePath": "/etc/passwd.png"}, "invalid_path"),
        ({"outputPath": "../escape.mp4"}, "invalid_path"),
        ({"outputPath": "/tmp/escape.mp4"}, "invalid_path"),
        ({"outputPath": "jobs/k1/input.png"}, "invalid_path"),
    ],
)
def test_rejections_never_reach_the_engine(volume: Path, image: Path, tmp_path: Path, over, code):
    before = outside_snapshot(tmp_path, volume)
    engine = FakeEngine()
    res = handle(valid_input(**over), engine=engine)
    assert res["error"].startswith(f"{code}:")
    assert engine.calls == [] and engine.load_calls == 0
    assert outside_snapshot(tmp_path, volume) == before


def test_symlink_escape_is_rejected(volume: Path, tmp_path: Path):
    (tmp_path / "outside.png").write_bytes(b"x")
    os.symlink(tmp_path / "outside.png", volume / "jobs" / "k1" / "evil.png")
    res = handle(valid_input(imagePath="jobs/k1/evil.png"), engine=FakeEngine())
    assert res["error"].startswith("invalid_path:")
    assert str(tmp_path) not in res["error"]


# ── generation / validation failures: no output, no partial left behind ──────────────────


def assert_clean_failure(res: dict, volume: Path, code: str):
    assert res["error"].startswith(f"{code}:"), res
    d = volume / "jobs" / "k1"
    assert not (d / "output.mp4").exists()
    assert not [p for p in d.iterdir() if ".partial-" in p.name]


def test_engine_failure(volume: Path, image: Path):
    res = handle(valid_input(), engine=FakeEngine("raise"))
    assert_clean_failure(res, volume, "engine_failed")
    assert "CUDA out of memory" in res["error"]


@needs_ffmpeg
@pytest.mark.parametrize(
    ("mode", "fragment"),
    [
        ("empty", "empty"),
        ("garbage", "could not read"),
        ("wrong_size", "resolution"),
        ("short", "frames"),
        ("with_audio", "audio"),
        ("misreport", "pipeline produced"),
    ],
)
def test_invalid_outputs_are_never_published(volume: Path, image: Path, mode, fragment):
    res = handle(valid_input(), engine=FakeEngine(mode))
    assert_clean_failure(res, volume, "invalid_output")
    assert fragment in res["error"]


@needs_ffmpeg
def test_a_failed_job_keeps_the_previous_output_untouched(volume: Path, image: Path):
    out = volume / "jobs" / "k1" / "output.mp4"
    out.write_bytes(b"previous good clip")
    res = handle(valid_input(), engine=FakeEngine("garbage"))
    assert res["error"].startswith("invalid_output:")
    assert out.read_bytes() == b"previous good clip"


def test_missing_ffprobe_is_an_invalid_output_not_a_success(volume: Path, image: Path, monkeypatch: pytest.MonkeyPatch):
    if not shutil.which("ffmpeg"):
        pytest.skip("ffmpeg not installed")
    real_which = shutil.which
    monkeypatch.setattr(shutil, "which", lambda name: None if name == "ffprobe" else real_which(name))
    res = handle(valid_input(), engine=FakeEngine())
    assert_clean_failure(res, volume, "invalid_output")
    assert "ffprobe is not available" in res["error"]


def test_a_failing_checker_is_respected(volume: Path, image: Path):
    def check(*_a, **_k):
        raise InvalidOutput("duration is 9.000s, expected 0.708s")

    engine = FakeEngine("empty")
    res = handle(valid_input(), engine=engine, check=check)
    assert_clean_failure(res, volume, "invalid_output")


def test_unexpected_errors_carry_no_traceback_or_secrets(volume: Path, image: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("HF_TOKEN", "hf_SUPERSECRET")

    class Boom(FakeEngine):
        def generate(self, *a, **k):
            raise KeyError("hf_SUPERSECRET in /some/internal/path")

    res = handle(valid_input(), engine=Boom())
    assert res == {"error": "internal: KeyError"}


def test_engine_error_messages_are_scrubbed(volume: Path, image: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("HF_TOKEN", "hf_SUPERSECRET")
    from ltx_worker.engine import EngineError

    class Leaky(FakeEngine):
        def generate(self, req, image, out):
            raise EngineError(f"failed reading {out} with token hf_SUPERSECRET")

    res = handle(valid_input(), engine=Leaky())
    assert "hf_SUPERSECRET" not in res["error"] and str(volume) not in res["error"]
    assert "<volume>" in res["error"] and "[REDACTED]" in res["error"]


def test_handler_module_does_not_import_torch_or_ltx():
    import sys

    assert "torch" not in sys.modules
    assert not any(m.startswith(("ltx_core", "ltx_pipelines", "runpod")) for m in sys.modules)
    assert handler_mod.handle is handle

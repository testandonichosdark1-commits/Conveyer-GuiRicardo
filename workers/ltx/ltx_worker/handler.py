"""Runpod Serverless handler: validate → resolve paths → generate → verify → publish atomically.

Output is written to a temporary file in the SAME directory as `outputPath`
(`.<name>.partial-<hex>.mp4` — the .mp4 suffix lets the encoder pick the container), proved
with ffprobe, fsynced, and only then renamed onto `outputPath`. A failure removes the
temporary file; `outputPath` never names a partial or unverified clip.

The result carries the clip's byte size and SHA-256 (computed here, never an ETag), so the
caller can verify its download. The returned JSON is small and never contains media, base64, absolute paths, secrets or a
traceback. A failure returns `{"error": "<code>: <message>"}`, which Runpod records as FAILED.
"""

from __future__ import annotations

import hashlib
import os
import time
import uuid
from pathlib import Path
from typing import Any, Callable

from .engine import EngineError, LtxEngine
from .paths import PathError, resolve_input_file, resolve_output_file, volume_mount
from .schemas import GenerationRequest, InvalidInput, parse_request
from .video_probe import InvalidOutput, ProbeResult, check_video
from .weights import WeightsUnavailable

MAX_ERROR_CHARS = 500


def _error(code: str, message: str, mount: Path | None) -> dict[str, str]:
    msg = message
    if mount is not None:
        msg = msg.replace(str(mount), "<volume>")
    for secret in (os.environ.get("HF_TOKEN"), os.environ.get("RUNPOD_API_KEY")):
        if secret:
            msg = msg.replace(secret, "[REDACTED]")
    return {"error": f"{code}: {msg[:MAX_ERROR_CHARS]}"}


def _fsync_dir(path: Path) -> None:
    try:
        fd = os.open(path, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def sha256_file(path: Path, chunk: int = 1 << 20) -> str:
    """Lowercase hex SHA-256, streamed (clips can be large)."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while block := f.read(chunk):
            h.update(block)
    return h.hexdigest()


def handle(
    job_input: Any,
    *,
    engine: LtxEngine,
    mount: Path | None = None,
    check: Callable[..., ProbeResult] = check_video,
) -> dict[str, Any]:
    t0 = time.monotonic()
    try:
        req: GenerationRequest = parse_request(job_input)
    except InvalidInput as e:
        return _error("invalid_input", str(e), None)

    try:
        mount = mount or volume_mount()
        image = resolve_input_file(mount, req.image_path)
        out = resolve_output_file(mount, req.output_path)
    except PathError as e:
        return _error("invalid_path", str(e), mount)
    if out == image:
        return _error("invalid_path", "outputPath must differ from imagePath", mount)

    tmp = out.with_name(f".{out.stem}.partial-{uuid.uuid4().hex}.mp4")
    try:
        t_load = time.monotonic()
        engine.load()
        t_gen = time.monotonic()
        produced = engine.generate(req, image, tmp)
        t_check = time.monotonic()
        if produced.num_frames != req.num_frames:
            raise InvalidOutput(f"pipeline produced {produced.num_frames} frames, expected {req.num_frames}")
        probe = check(tmp, width=req.width, height=req.height, num_frames=req.num_frames, fps=req.fps)
        # Hashed after validation and before the rename: the rename moves these exact bytes,
        # so the digest describes the published file without reading it a second time.
        digest = sha256_file(tmp)
        with open(tmp, "rb") as f:
            os.fsync(f.fileno())
        os.replace(tmp, out)
        _fsync_dir(out.parent)
        t_end = time.monotonic()
    except WeightsUnavailable as e:
        return _error("weights_unavailable", str(e), mount)
    except EngineError as e:
        return _error("engine_failed", str(e), mount)
    except InvalidOutput as e:
        return _error("invalid_output", str(e), mount)
    except Exception as e:  # noqa: BLE001 — never let a stack trace reach the job result
        return _error("internal", type(e).__name__, mount)
    finally:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass

    return {
        "storage": "network_volume",
        "path": req.output_path,
        **engine.info(),
        "width": req.width,
        "height": req.height,
        "fps": req.fps,
        "numFrames": req.num_frames,
        "durationSec": req.duration_sec,
        "seed": req.seed,
        "bytes": probe.size_bytes,
        "sha256": digest,
        "codec": probe.codec,
        "timings": {
            "loadSec": round(t_gen - t_load, 3),
            "generateSec": round(t_check - t_gen, 3),
            "validateSec": round(t_end - t_check, 3),
            "totalSec": round(t_end - t0, 3),
        },
    }


def main() -> None:  # pragma: no cover — runs only inside the Runpod container
    import runpod  # noqa: PLC0415
    from runpod.serverless import VolumeCache  # noqa: PLC0415

    from .engine import EngineConfig, Ltx25DistilledEngine  # noqa: PLC0415

    engine = Ltx25DistilledEngine(EngineConfig.from_env())
    # Load before accepting jobs, so the cold start pays for it once. VolumeCache hydrates
    # HF_HOME from the network volume first and syncs any newly downloaded weights back.
    hf_home = os.environ.get("HF_HOME") or "/root/.cache/huggingface"
    if os.environ.get("LTX_VOLUME_CACHE", "1") == "1":
        with VolumeCache(dirs=[hf_home]):
            engine.load()
    else:
        engine.load()

    runpod.serverless.start({"handler": lambda job: handle(job.get("input"), engine=engine)})


if __name__ == "__main__":  # pragma: no cover
    main()

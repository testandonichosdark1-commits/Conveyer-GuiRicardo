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
import logging
import os
import time
import uuid
from pathlib import Path
from typing import Any, Callable

from .engine import EngineError, LtxEngine
from .provenance import provenance
from .redact import scrub
from .paths import PathError, resolve_input_file, resolve_output_file, volume_mount
from .schemas import GenerationRequest, InvalidInput, parse_request
from .video_probe import InvalidOutput, ProbeResult, check_video
from .weights import WeightsUnavailable

MAX_ERROR_CHARS = 500
log = logging.getLogger("ltx_worker")


def _error(code: str, message: str, mount: Path | None, job_id: str | None = None) -> dict[str, str]:
    msg = scrub(message, mount)[:MAX_ERROR_CHARS]
    log.warning("job %s failed: %s: %s", job_id or "-", code, msg)
    return {"error": f"{code}: {msg}"}


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
    job_id: str | None = None,
) -> dict[str, Any]:
    t0 = time.monotonic()
    try:
        req: GenerationRequest = parse_request(job_input)
    except InvalidInput as e:
        return _error("invalid_input", str(e), None, job_id)

    log.info(
        "job %s start: %dx%d, %d frames @ %d fps, seed %d, prompt %d chars",
        job_id or "-", req.width, req.height, req.num_frames, req.fps, req.seed, len(req.prompt),
    )
    try:
        mount = mount or volume_mount()
        image = resolve_input_file(mount, req.image_path)
        out = resolve_output_file(mount, req.output_path)
    except PathError as e:
        return _error("invalid_path", str(e), mount, job_id)
    if out == image:
        return _error("invalid_path", "outputPath must differ from imagePath", mount, job_id)

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
        return _error("weights_unavailable", str(e), mount, job_id)
    except EngineError as e:
        return _error("engine_failed", str(e), mount, job_id)
    except InvalidOutput as e:
        return _error("invalid_output", str(e), mount, job_id)
    except Exception as e:  # noqa: BLE001 — never let a stack trace reach the job result
        return _error("internal", type(e).__name__, mount, job_id)
    finally:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass

    timings = {
        "loadSec": round(t_gen - t_load, 3),
        "generateSec": round(t_check - t_gen, 3),
        "validateSec": round(t_end - t_check, 3),
        "totalSec": round(t_end - t0, 3),
    }
    log.info(
        "job %s done: %d bytes, generate %.1fs, total %.1fs, peak cuda %s",
        job_id or "-", probe.size_bytes, timings["generateSec"], timings["totalSec"],
        f"{produced.peak_cuda_bytes / 2**30:.2f} GiB" if produced.peak_cuda_bytes is not None else "n/a",
    )
    result: dict[str, Any] = {
        "storage": "network_volume",
        "path": req.output_path,
        **provenance(),
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
        "timings": timings,
    }
    if produced.peak_cuda_bytes is not None:
        result["peakCudaMemoryBytes"] = produced.peak_cuda_bytes
    return result


def boot(
    engine: LtxEngine,
    *,
    preflight: Callable[[], Any],
    cache_factory: Callable[[list[str]], Any] | None,
    hf_home: str,
) -> None:
    """Worker startup, in the only safe order: CUDA preflight → hydrate → load → sync.

    The preflight runs FIRST and a failure raises before any weight is hydrated, downloaded or
    loaded — a host whose CUDA stack does not work must not spend minutes moving 66 GiB first.
    `cache_factory=None` disables VolumeCache. Sync is INLINE (background=False): the
    context-manager form syncs on a daemon thread, and a worker scaled down by its idle timeout
    mid-copy would leave a partial mirror on the volume.
    """
    from .preflight import PreflightError  # noqa: PLC0415

    try:
        report = preflight()
    except PreflightError as e:
        log.error("%s", scrub(str(e), None))
        raise
    log.info("cuda preflight ok: %s", " ".join(f"{k}={v}" for k, v in report.as_dict().items()))

    if cache_factory is None:
        engine.load()
        return
    cache = cache_factory([hf_home])
    t = time.monotonic()
    cache.hydrate()
    log.info("volume cache hydrated in %.1fs", time.monotonic() - t)
    engine.load()
    t = time.monotonic()
    cache.sync(background=False)
    log.info("volume cache synced in %.1fs", time.monotonic() - t)


def main() -> None:  # pragma: no cover — runs only inside the Runpod container
    import runpod  # noqa: PLC0415
    from runpod.serverless import VolumeCache  # noqa: PLC0415

    from .engine import EngineConfig, Ltx25DistilledEngine  # noqa: PLC0415
    from .preflight import PreflightError, run_preflight  # noqa: PLC0415

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    config = EngineConfig.from_env()
    volume_cache = os.environ.get("LTX_VOLUME_CACHE", "1") == "1"
    log.info(
        "startup: %s; residency=%s quantization=%s; weight download %s; volume cache %s",
        " ".join(f"{k}={v}" for k, v in provenance().items()), config.residency, config.quantization,
        "allowed" if os.environ.get("LTX_ALLOW_WEIGHT_DOWNLOAD") == "1" else "disabled",
        "on" if volume_cache else "off",
    )
    engine = Ltx25DistilledEngine(config)
    try:
        boot(
            engine,
            preflight=run_preflight,
            cache_factory=(lambda dirs: VolumeCache(dirs=dirs)) if volume_cache else None,
            hf_home=os.environ.get("HF_HOME") or "/root/.cache/huggingface",
        )
    except PreflightError:
        # Exit before any weight was touched: a restart costs an image start, not a 66 GiB copy.
        raise SystemExit(1) from None

    log.info("ready for jobs")
    runpod.serverless.start({"handler": lambda job: handle(job.get("input"), engine=engine, job_id=job.get("id"))})


if __name__ == "__main__":  # pragma: no cover
    main()

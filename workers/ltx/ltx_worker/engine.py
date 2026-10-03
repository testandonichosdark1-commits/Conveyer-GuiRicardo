"""LtxEngine: the model, loaded ONCE per worker process and reused by every job.

The real engine wraps the official `ltx_pipelines.distilled.DistilledPipeline`
(Lightricks/LTX-2 v1.4.2) through its Python API — never by spawning the CLI per job, which
would rebuild the pipeline and re-read 66 GiB of weights every time. torch and ltx_* are
imported inside `load()` only, so tests run the handler against a fake engine on any machine.

Residency (LTX_RESIDENCY) — how the weights stay between jobs. The pipeline object and the
model shells are built once in every mode; the modes differ in where WEIGHTS live:
  - page_cache (default)  The library's own default: each stage builds its component on
                          the GPU from the local weight files and frees it afterwards. After
                          the first job the files are in the OS page cache, so later builds
                          read RAM, not disk. Peak VRAM ≈ the largest component (the 39 GiB
                          bf16 transformer) plus activations.
  - gpu                   One shared `ModelRegistry(cache_weights=True)`: weights stay on the
                          GPU after the first job. Fastest, but VRAM must hold every
                          component at once (~66 GiB bf16) plus activations.
  - cpu                   `OffloadMode.CPU`: weights pinned in host RAM after the first pass
                          and streamed layer by layer (documented ~5 GB VRAM for LTX-2,
                          slower per step, needs large host RAM).
Quantization (LTX_QUANTIZATION): fp8-cast (default) | none (bf16). FP8 Cast is the library's
`QuantizationKind.FP8_CAST`, which LTX's optimization guide recommends for a smaller memory
footprint together with PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True — set as a container
env in the Dockerfile, not in code.
GPU choice and fallback belong to the Runpod endpoint; none of this names a GPU.

Audio: LTX-2.5 is a joint audio-video model. DistilledPipeline always builds the audio VAE
and computes the audio track; there is no supported switch to skip it, and patching the
pipeline's internals is not done here. The worker only declines to WRITE it, via the
documented `encode_video(audio=None)` ("None for a video-only file"). Conveyer's assembler
strips audio from every beat anyway, so nothing downstream depends on this.

One generation at a time per worker (a lock), even if a concurrency modifier is ever added:
scaling is more workers on the endpoint, not two jobs on one GPU.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from .schemas import GenerationRequest

LTX_GIT_TAG = "v1.4.2"
LTX_GIT_COMMIT = "9ec55f9f22798a3198d9c923856824821bc3317e"
MODEL = "LTX-2.5"
PIPELINE = "distilled"
# Conditioning image goes on the first frame: this is image-to-video.
IMAGE_FRAME_INDEX = 0

RESIDENCY_MODES = ("page_cache", "gpu", "cpu")
QUANTIZATION_MODES = ("none", "fp8-cast")


log = logging.getLogger("ltx_worker")


class EngineError(RuntimeError):
    """Generation failed inside the model or encoder."""


@dataclass(frozen=True)
class EngineOutput:
    num_frames: int  # frames the pipeline reports it produced
    peak_cuda_bytes: int | None = None  # torch.cuda.max_memory_allocated during this job


class LtxEngine(Protocol):
    @property
    def loaded(self) -> bool: ...

    def load(self) -> None:
        """Idempotent: builds the model the first time, no-op afterwards."""

    def generate(self, req: GenerationRequest, image: Path, out: Path) -> EngineOutput:
        """Write the clip for `req` conditioned on `image` to `out` (an .mp4 path)."""

    def info(self) -> dict[str, object]: ...


@dataclass(frozen=True)
class EngineConfig:
    residency: str = "page_cache"
    quantization: str = "fp8-cast"

    @classmethod
    def from_env(cls) -> EngineConfig:
        residency = os.environ.get("LTX_RESIDENCY") or "page_cache"
        quantization = os.environ.get("LTX_QUANTIZATION") or "fp8-cast"
        if residency not in RESIDENCY_MODES:
            raise ValueError(f"LTX_RESIDENCY must be one of {RESIDENCY_MODES}, got {residency!r}")
        if quantization not in QUANTIZATION_MODES:
            raise ValueError(f"LTX_QUANTIZATION must be one of {QUANTIZATION_MODES}, got {quantization!r}")
        return cls(residency=residency, quantization=quantization)


class Ltx25DistilledEngine:
    """DistilledPipeline built once, called per job under a lock."""

    def __init__(self, config: EngineConfig, resolve_files=None) -> None:
        self._config = config
        self._resolve_files = resolve_files
        self._lock = threading.Lock()
        self._pipeline = None
        self.load_seconds: float | None = None

    @property
    def loaded(self) -> bool:
        return self._pipeline is not None

    def load(self) -> None:
        with self._lock:
            if self._pipeline is not None:
                return
            t0 = time.monotonic()
            # Heavy imports only here: tests and the handler module never need torch.
            from ltx_core.loader.registry import ModelRegistry  # noqa: PLC0415
            from ltx_pipelines.distilled import DistilledPipeline  # noqa: PLC0415
            from ltx_pipelines.utils.model_paths import ModelPaths  # noqa: PLC0415
            from ltx_pipelines.utils.quantization_factory import QuantizationKind  # noqa: PLC0415
            from ltx_pipelines.utils.types import OffloadMode  # noqa: PLC0415

            from .weights import resolve_model_files  # noqa: PLC0415

            log.info("resolving weights (residency=%s, quantization=%s)", self._config.residency, self._config.quantization)
            files = (self._resolve_files or resolve_model_files)()
            log.info("weights ready; building DistilledPipeline")
            paths = ModelPaths.from_split(
                transformer_path=str(files.transformer),
                text_encoder_path=str(files.text_encoder),
                video_vae_path=str(files.video_vae),
                audio_vae_path=str(files.audio_vae),
            )
            quantization = (
                QuantizationKind.FP8_CAST.to_policy(str(files.transformer))
                if self._config.quantization == "fp8-cast"
                else None
            )
            self._pipeline = DistilledPipeline(
                model_paths=paths,
                spatial_upsampler_path=str(files.spatial_upsampler),
                loras=[],
                quantization=quantization,
                registry=ModelRegistry(cache_models=True, cache_weights=True) if self._config.residency == "gpu" else None,
                offload_mode=OffloadMode.CPU if self._config.residency == "cpu" else OffloadMode.NONE,
            )
            self.load_seconds = round(time.monotonic() - t0, 3)
            log.info("model loaded in %.1fs", self.load_seconds)

    def generate(self, req: GenerationRequest, image: Path, out: Path) -> EngineOutput:
        self.load()
        import torch  # noqa: PLC0415
        from ltx_core.model.video_vae import AUTO_TILING, get_video_chunks_number  # noqa: PLC0415
        from ltx_pipelines.utils.media_io import encode_video  # noqa: PLC0415
        from ltx_pipelines.utils.types import ImageConditioningInput  # noqa: PLC0415

        with self._lock, torch.inference_mode():
            cuda = torch.cuda.is_available()
            if cuda:
                torch.cuda.reset_peak_memory_stats()
            try:
                result = self._pipeline(
                    prompt=req.prompt,
                    seed=req.seed,
                    height=req.height,
                    width=req.width,
                    frame_rate=float(req.fps),
                    images=[ImageConditioningInput(str(image), IMAGE_FRAME_INDEX, req.image_strength)],
                    num_frames=req.num_frames,
                    tiling_config=AUTO_TILING,
                    enhance_prompt=False,
                )
                encode_video(
                    video=result.video,
                    fps=req.fps,
                    audio=None,  # video-only file; see the module docstring
                    output_path=str(out),
                    video_chunks_number=get_video_chunks_number(result.num_frames, result.tiling_config),
                )
            except Exception as e:
                raise EngineError(f"{type(e).__name__}: {e}") from None
            peak = int(torch.cuda.max_memory_allocated()) if cuda else None
        return EngineOutput(num_frames=int(result.num_frames), peak_cuda_bytes=peak)

    def info(self) -> dict[str, object]:
        return {
            "model": MODEL,
            "pipeline": PIPELINE,
            "residency": self._config.residency,
            "quantization": self._config.quantization,
        }

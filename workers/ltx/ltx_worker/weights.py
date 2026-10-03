"""Which LTX-2.5 weights the worker needs, and where they come from.

Never baked into the image (66.2 GiB). They live in the Hugging Face cache (HF_HOME), which
`runpod.serverless.VolumeCache` mirrors onto the endpoint's network volume: the first cold
start downloads them once (only if LTX_ALLOW_WEIGHT_DOWNLOAD=1 and HF_TOKEN is set — the repo
is gated), later cold starts re-hydrate from the volume. Without both, the worker runs
OFFLINE and fails clearly if anything is missing.

Only the five files DistilledPipeline loads are fetched, pinned to one repo revision.
Runpod's endpoint-level "model caching" was not used: it caches the WHOLE repository
(all transformer variants, > 160 GiB) and cannot select files.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

HF_REPO = "Lightricks/LTX-2.5"
# Commit of Lightricks/LTX-2.5 on 2026-10-02. Change deliberately, never float on `main`.
HF_REVISION = "2356ce76915d6c48d313d7e8b25900e1dd3abaa8"

# Exactly the components of the official DistilledPipeline quick start (bf16, split layout).
FILES = {
    "transformer": "diffusion_models/ltx-2.5-22b-distilled-transformer-bf16.safetensors",  # 39.13 GiB
    "text_encoder": "text_encoders/gemma4-12b-with-proj-ltx-2.5-bf16.safetensors",  # 24.46 GiB
    "video_vae": "vae/ltx-2.5-video-vae-bf16.safetensors",  # 1.37 GiB
    "audio_vae": "vae/ltx-2.5-audio-vae-bf16.safetensors",  # 0.34 GiB (required by the pipeline)
    "spatial_upsampler": "latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors",  # 0.93 GiB
}


class WeightsUnavailable(RuntimeError):
    pass


@dataclass(frozen=True)
class ModelFiles:
    transformer: Path
    text_encoder: Path
    video_vae: Path
    audio_vae: Path
    spatial_upsampler: Path


def resolve_model_files() -> ModelFiles:
    """Local paths of every weight file; downloads only when explicitly allowed."""
    allow = os.environ.get("LTX_ALLOW_WEIGHT_DOWNLOAD") == "1"
    token = os.environ.get("HF_TOKEN") or None
    if allow and not token:
        raise WeightsUnavailable("LTX_ALLOW_WEIGHT_DOWNLOAD=1 but HF_TOKEN is not set (the LTX-2.5 repo is gated)")
    from huggingface_hub import hf_hub_download  # noqa: PLC0415 — only needed when loading the real model
    paths: dict[str, Path] = {}
    for key, filename in FILES.items():
        try:
            paths[key] = Path(
                hf_hub_download(
                    repo_id=HF_REPO,
                    filename=filename,
                    revision=HF_REVISION,
                    token=token if allow else None,
                    local_files_only=not allow,
                )
            )
        except Exception as e:  # noqa: BLE001 — re-raised without the token or a traceback
            raise WeightsUnavailable(
                f"weight file {filename} is not available"
                + ("" if allow else " in the local cache (downloads are disabled)")
                + f": {type(e).__name__}"
            ) from None
    return ModelFiles(**paths)

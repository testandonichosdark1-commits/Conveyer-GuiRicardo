"""Job input contract.

Every rule below is either an LTX rule confirmed in Lightricks/LTX-2 v1.4.2, or a worker
policy cap — and says which. Nothing important is defaulted: the caller sends every
generation parameter explicitly, so the same input always means the same job.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

# --- LTX rules (Lightricks/LTX-2 v1.4.2) -----------------------------------------------------
# ltx_pipelines.utils.helpers.assert_resolution: two-stage pipelines (DistilledPipeline is one)
# need height and width divisible by 64.
RESOLUTION_DIVISOR = 64
# ltx_pipelines.utils.helpers.snap_frames_to_grid: (frames - 1) % VIDEO_SCALE_FACTORS.time == 0,
# with time = 8 (ltx_core.types.SpatioTemporalScaleFactors.default). The pipeline silently
# floors anything else onto that grid; this worker REJECTS it instead, so the frame count the
# caller asked for is the frame count it gets.
FRAME_GRID = 8

# --- Worker policy caps (ours, not LTX's): bound one job's cost and memory --------------------
MAX_SIDE = 2048
MAX_FRAMES = 257
MAX_FPS = 60
MAX_PROMPT_CHARS = 4000
MAX_SEED = 2**63 - 1

ALLOWED_IMAGE_SUFFIXES = (".png", ".jpg", ".jpeg")  # LTX accepts PNG/JPEG stills (SDR)

FIELDS = (
    "prompt",
    "imagePath",
    "imageStrength",
    "outputPath",
    "width",
    "height",
    "fps",
    "numFrames",
    "seed",
)


class InvalidInput(ValueError):
    """The job input does not satisfy the contract. Safe to show to the caller."""


@dataclass(frozen=True)
class GenerationRequest:
    prompt: str
    image_path: str  # relative to the volume mount
    image_strength: float  # conditioning strength of the first-frame image, (0, 1]
    output_path: str  # relative to the volume mount
    width: int
    height: int
    fps: int
    num_frames: int
    seed: int

    @property
    def duration_sec(self) -> float:
        return round(self.num_frames / self.fps, 6)


def _int(raw: dict[str, Any], name: str, lo: int, hi: int) -> int:
    v = raw.get(name)
    # bool is an int subclass in Python; true/false is never a valid size.
    if isinstance(v, bool) or not isinstance(v, int):
        raise InvalidInput(f"{name} must be an integer")
    if not lo <= v <= hi:
        raise InvalidInput(f"{name} must be between {lo} and {hi}, got {v}")
    return v


def _rel_path(raw: dict[str, Any], name: str) -> str:
    v = raw.get(name)
    if not isinstance(v, str) or not v.strip():
        raise InvalidInput(f"{name} is required (a path relative to the volume)")
    return v


def parse_request(raw: Any) -> GenerationRequest:
    """Validate a Runpod job's `input` object. Raises InvalidInput."""
    if not isinstance(raw, dict):
        raise InvalidInput("input must be a JSON object")
    unknown = sorted(set(raw) - set(FIELDS))
    if unknown:
        raise InvalidInput(f"unknown input field(s): {', '.join(unknown)}")

    prompt = raw.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise InvalidInput("prompt is required")
    if len(prompt) > MAX_PROMPT_CHARS:
        raise InvalidInput(f"prompt exceeds {MAX_PROMPT_CHARS} characters")

    image_path = _rel_path(raw, "imagePath")
    output_path = _rel_path(raw, "outputPath")

    strength = raw.get("imageStrength")
    if isinstance(strength, bool) or not isinstance(strength, (int, float)) or not 0 < strength <= 1:
        raise InvalidInput("imageStrength must be a number in (0, 1]")

    width = _int(raw, "width", RESOLUTION_DIVISOR, MAX_SIDE)
    height = _int(raw, "height", RESOLUTION_DIVISOR, MAX_SIDE)
    for name, v in (("width", width), ("height", height)):
        if v % RESOLUTION_DIVISOR:
            raise InvalidInput(f"{name} must be a multiple of {RESOLUTION_DIVISOR} (LTX two-stage pipeline), got {v}")

    fps = _int(raw, "fps", 1, MAX_FPS)
    num_frames = _int(raw, "numFrames", 1, MAX_FRAMES)
    if (num_frames - 1) % FRAME_GRID:
        lower = ((num_frames - 1) // FRAME_GRID) * FRAME_GRID + 1
        raise InvalidInput(
            f"numFrames must satisfy (numFrames - 1) % {FRAME_GRID} == 0 (LTX temporal grid), "
            f"got {num_frames}; nearest valid values are {lower} and {lower + FRAME_GRID}"
        )
    seed = _int(raw, "seed", 0, MAX_SEED)

    return GenerationRequest(
        prompt=prompt,
        image_path=image_path,
        image_strength=float(strength),
        output_path=output_path,
        width=width,
        height=height,
        fps=fps,
        num_frames=num_frames,
        seed=seed,
    )

"""CUDA preflight: prove the GPU stack works BEFORE touching 66 GiB of weights.

Runs at worker startup, before VolumeCache hydration and model load. If CUDA is unusable on
this host, the worker fails in seconds with a clear reason — instead of hydrating (or
downloading) the weights first and only then discovering the runtime cannot run.

It exercises real CUDA (allocate, matmul, synchronize, read back) and imports NATTEN, rather
than parsing `nvidia-smi`'s "CUDA Version" line: that text is the driver's generation, and a
13.0 driver is expected to run this cu132 runtime under CUDA 13.x minor-version
compatibility. A host is never rejected for what it prints — only for what fails.
"""

from __future__ import annotations

import importlib
import shutil
import subprocess
from dataclasses import asdict, dataclass
from types import ModuleType
from typing import Callable

from .redact import scrub

MAX_DETAIL_CHARS = 200


class PreflightError(RuntimeError):
    """The GPU stack is unusable on this host. `stage` says which check failed."""

    def __init__(self, stage: str, detail: str) -> None:
        self.stage = stage
        super().__init__(f"cuda preflight failed at {stage}: {detail}")


@dataclass(frozen=True)
class PreflightReport:
    gpu_name: str
    gpu_count: int
    total_vram_gib: float
    compute_capability: str
    torch_version: str
    torch_cuda: str | None
    driver_version: str | None
    natten_version: str | None

    def as_dict(self) -> dict[str, object]:
        return asdict(self)


def _detail(e: BaseException) -> str:
    # Type + first line only: enough to classify, no tracebacks or long dumps.
    first = (str(e).splitlines() or [""])[0]
    return scrub(f"{type(e).__name__}: {first}")[:MAX_DETAIL_CHARS]


def nvidia_driver_version() -> str | None:
    """The driver version string from nvidia-smi (NOT its 'CUDA Version'), or None."""
    exe = shutil.which("nvidia-smi")
    if not exe:
        return None
    try:
        r = subprocess.run(
            [exe, "--query-gpu=driver_version", "--format=csv,noheader"],
            capture_output=True, text=True, timeout=15, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    line = (r.stdout or "").strip().splitlines()
    return line[0].strip() if r.returncode == 0 and line else None


def run_preflight(
    import_module: Callable[[str], ModuleType] = importlib.import_module,
    driver_version: Callable[[], str | None] = nvidia_driver_version,
) -> PreflightReport:
    """Raise PreflightError, or return what was found. Frees its test memory either way."""
    try:
        torch = import_module("torch")
    except Exception as e:  # noqa: BLE001 — any import failure is a preflight failure
        raise PreflightError("torch_import", _detail(e)) from None

    try:
        available = bool(torch.cuda.is_available())
    except Exception as e:  # noqa: BLE001
        raise PreflightError("cuda_available", _detail(e)) from None
    if not available:
        raise PreflightError("cuda_available", "torch.cuda.is_available() is False (no GPU, or driver/runtime mismatch)")

    try:
        count = int(torch.cuda.device_count())
        if count < 1:
            raise RuntimeError("no CUDA device enumerated")
        props = torch.cuda.get_device_properties(0)
        name = str(props.name)
        vram_gib = round(int(props.total_memory) / 2**30, 2)
        cc = f"{props.major}.{props.minor}"
    except Exception as e:  # noqa: BLE001
        raise PreflightError("enumerate", _detail(e)) from None

    a = b = None
    try:
        a = torch.ones((64, 64), device="cuda")
        b = a @ a
        torch.cuda.synchronize()
        if not bool((b == 64).all().item()):
            raise RuntimeError("matmul returned a wrong result")
    except Exception as e:  # noqa: BLE001
        raise PreflightError("cuda_op", _detail(e)) from None
    finally:
        del a, b
        try:
            torch.cuda.empty_cache()
        except Exception:  # noqa: BLE001, S110 — freeing is best effort
            pass

    try:
        natten = import_module("natten")
    except Exception as e:  # noqa: BLE001
        raise PreflightError("natten_import", _detail(e)) from None

    return PreflightReport(
        gpu_name=name,
        gpu_count=count,
        total_vram_gib=vram_gib,
        compute_capability=cc,
        torch_version=str(getattr(torch, "__version__", "unknown")),
        torch_cuda=getattr(getattr(torch, "version", None), "cuda", None),
        driver_version=driver_version(),
        natten_version=getattr(natten, "__version__", None),
    )

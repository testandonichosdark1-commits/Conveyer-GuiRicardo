"""What exactly produced a clip: worker build, LTX code, weights. Reported with every result.

`workerRevision` is the git SHA the image was built from (Dockerfile ARG WORKER_REVISION →
ENV CONVEYER_WORKER_REVISION). `ltxVersion`/`ltxCommit`/`weightsRevision` come from the code,
which the Dockerfile's pins are tested against. The build timestamp is informational only —
never an identity.
"""

from __future__ import annotations

import os

from .engine import LTX_GIT_COMMIT, LTX_GIT_TAG
from .weights import HF_REVISION


def provenance() -> dict[str, str]:
    out = {
        "workerRevision": os.environ.get("CONVEYER_WORKER_REVISION") or "unknown",
        "ltxVersion": LTX_GIT_TAG,
        "ltxCommit": LTX_GIT_COMMIT,
        "weightsRevision": HF_REVISION,
        "torchCuda": os.environ.get("LTX_TORCH_CUDA") or "unknown",
    }
    ts = os.environ.get("CONVEYER_BUILD_TIMESTAMP")
    if ts:
        out["buildTimestamp"] = ts
    return out

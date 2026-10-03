"""Redaction shared by every message that can leave the worker (job results, logs, errors)."""

from __future__ import annotations

import os
from pathlib import Path

# Values never allowed into a log line or a job result. Prompts are logged by LENGTH only.
SECRET_ENV = ("HF_TOKEN", "RUNPOD_API_KEY", "RUNPOD_S3_ACCESS_KEY_ID", "RUNPOD_S3_SECRET_ACCESS_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY")


def scrub(text: str, mount: Path | None = None) -> str:
    if mount is not None:
        text = text.replace(str(mount), "<volume>")
    for name in SECRET_ENV:
        secret = os.environ.get(name)
        if secret:
            text = text.replace(secret, "[REDACTED]")
    return text

"""Resolve request paths against the network-volume mount — and never outside it.

Requests carry paths RELATIVE to the volume. Absolute paths, `..`, backslashes, NUL bytes
and symlinks that lead out of the mount are all rejected. Output directories are created
one component at a time, checking each existing component first, so a symlinked directory
can never make `mkdir` create anything outside the mount.

(A process that can rewrite the volume between check and use could still race this; the
volume is written only by our own orchestrator and these jobs, so that is out of scope.)
"""

from __future__ import annotations

import os
from pathlib import Path, PurePosixPath

from .schemas import ALLOWED_IMAGE_SUFFIXES

DEFAULT_MOUNT = "/runpod-volume"
MAX_PATH_CHARS = 512


class PathError(ValueError):
    """A request path is unusable. Messages only ever name the RELATIVE path."""


def volume_mount() -> Path:
    """The mount root: RUNPOD_VOLUME_MOUNT (tests, local runs) or Runpod's /runpod-volume."""
    root = Path(os.environ.get("RUNPOD_VOLUME_MOUNT") or DEFAULT_MOUNT)
    try:
        real = root.resolve(strict=True)
    except FileNotFoundError:
        raise PathError("network volume is not mounted") from None
    if not real.is_dir():
        raise PathError("network volume mount is not a directory")
    return real


def _parts(rel: str, field: str) -> tuple[str, ...]:
    if len(rel) > MAX_PATH_CHARS:
        raise PathError(f"{field} is longer than {MAX_PATH_CHARS} characters")
    if "\x00" in rel or "\\" in rel:
        raise PathError(f"{field} contains a forbidden character")
    if rel.startswith(("/", "~")) or (len(rel) >= 2 and rel[1] == ":"):
        raise PathError(f"{field} must be relative to the volume, not absolute")
    # Checked on the raw text: PurePosixPath would silently drop "." and "//" segments.
    raw_parts = rel.split("/")
    if any(p in ("", ".", "..") for p in raw_parts):
        raise PathError(f"{field} must not contain empty, '.' or '..' segments")
    return tuple(PurePosixPath(rel).parts)


def _inside(path: Path, mount: Path) -> bool:
    return path == mount or mount in path.parents


def resolve_input_file(mount: Path, rel: str, field: str = "imagePath") -> Path:
    """An existing regular image file inside the mount (symlinks followed, then re-checked)."""
    parts = _parts(rel, field)
    if not rel.lower().endswith(ALLOWED_IMAGE_SUFFIXES):
        raise PathError(f"{field} must be a {'/'.join(ALLOWED_IMAGE_SUFFIXES)} file")
    try:
        real = mount.joinpath(*parts).resolve(strict=True)
    except FileNotFoundError:
        raise PathError(f"{field} does not exist on the volume: {rel}") from None
    if not _inside(real, mount):
        raise PathError(f"{field} resolves outside the volume: {rel}")
    if not real.is_file():
        raise PathError(f"{field} is not a regular file: {rel}")
    return real


def resolve_output_file(mount: Path, rel: str, field: str = "outputPath") -> Path:
    """Where to write the result: parent directories created inside the mount only."""
    parts = _parts(rel, field)
    if not rel.lower().endswith(".mp4"):
        raise PathError(f"{field} must end in .mp4")
    cur = mount
    for part in parts[:-1]:
        nxt = cur / part
        if nxt.is_symlink() or nxt.exists():
            target = nxt.resolve(strict=True)
            if not _inside(target, mount):
                raise PathError(f"{field} resolves outside the volume: {rel}")
            if not target.is_dir():
                raise PathError(f"{field} has a non-directory component: {rel}")
            cur = target
        else:
            nxt.mkdir()
            cur = nxt
    final = cur / parts[-1]
    if final.is_symlink():
        raise PathError(f"{field} must not be a symlink: {rel}")
    if final.exists() and not final.is_file():
        raise PathError(f"{field} exists and is not a file: {rel}")
    return final

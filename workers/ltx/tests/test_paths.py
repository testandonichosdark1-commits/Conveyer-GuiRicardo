import os
from pathlib import Path

import pytest

from ltx_worker.paths import PathError, resolve_input_file, resolve_output_file, volume_mount


def test_mount_comes_from_env(volume: Path):
    assert volume_mount() == volume


def test_missing_mount_is_reported(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    monkeypatch.setenv("RUNPOD_VOLUME_MOUNT", str(tmp_path / "nope"))
    with pytest.raises(PathError, match="not mounted"):
        volume_mount()


def test_input_resolves_inside_the_volume(volume: Path, image: Path):
    assert resolve_input_file(volume, "jobs/k1/input.png") == image


def test_missing_input(volume: Path):
    with pytest.raises(PathError, match="does not exist"):
        resolve_input_file(volume, "jobs/k1/missing.png")


@pytest.mark.parametrize(
    "rel",
    ["../outside.png", "jobs/../../etc/x.png", "jobs/./k1/input.png", "jobs//k1/input.png", "jobs/k1/input.png/", "/etc/x.png", "~/x.png", "C:/x.png", "jobs\\k1\\input.png", "jobs/k1/in\x00put.png"],
)
def test_traversal_absolute_and_odd_input_paths_are_rejected(volume: Path, image: Path, rel: str):
    with pytest.raises(PathError):
        resolve_input_file(volume, rel)


def test_input_must_be_an_image_file(volume: Path, image: Path):
    with pytest.raises(PathError, match=r"\.png"):
        resolve_input_file(volume, "jobs/k1/input.gif")
    (volume / "jobs" / "k1" / "dir.png").mkdir()
    with pytest.raises(PathError, match="not a regular file"):
        resolve_input_file(volume, "jobs/k1/dir.png")


def test_input_symlink_escaping_the_volume_is_rejected(volume: Path, tmp_path: Path):
    outside = tmp_path / "secret.png"
    outside.write_bytes(b"x")
    os.symlink(outside, volume / "jobs" / "k1" / "link.png")
    with pytest.raises(PathError, match="outside the volume"):
        resolve_input_file(volume, "jobs/k1/link.png")


def test_input_symlink_staying_inside_the_volume_is_allowed(volume: Path, image: Path):
    os.symlink(image, volume / "jobs" / "k1" / "alias.png")
    assert resolve_input_file(volume, "jobs/k1/alias.png") == image


def test_output_parent_directories_are_created_inside_the_volume(volume: Path):
    out = resolve_output_file(volume, "jobs/new/deep/output.mp4")
    assert out == volume / "jobs" / "new" / "deep" / "output.mp4"
    assert out.parent.is_dir()
    assert not out.exists()


@pytest.mark.parametrize("rel", ["../out.mp4", "jobs/../../out.mp4", "/tmp/out.mp4", "jobs/k1/out.mov", "jobs/k1/out"])
def test_bad_output_paths_are_rejected(volume: Path, rel: str):
    with pytest.raises(PathError):
        resolve_output_file(volume, rel)


def test_output_through_a_symlinked_directory_outside_is_rejected_before_any_mkdir(volume: Path, tmp_path: Path):
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    os.symlink(outside, volume / "jobs" / "escape")
    with pytest.raises(PathError, match="outside the volume"):
        resolve_output_file(volume, "jobs/escape/new/output.mp4")
    assert list(outside.iterdir()) == []  # nothing was created outside the volume


def test_output_must_not_be_a_symlink(volume: Path, tmp_path: Path):
    os.symlink(tmp_path / "target.mp4", volume / "jobs" / "k1" / "output.mp4")
    with pytest.raises(PathError, match="symlink"):
        resolve_output_file(volume, "jobs/k1/output.mp4")


def test_output_that_is_a_directory_is_rejected(volume: Path):
    (volume / "jobs" / "k1" / "output.mp4").mkdir()
    with pytest.raises(PathError, match="not a file"):
        resolve_output_file(volume, "jobs/k1/output.mp4")

import logging
import py_compile
import re
from pathlib import Path

import pytest

from ltx_worker.engine import LTX_GIT_COMMIT, LTX_GIT_TAG
from ltx_worker.handler import handle
from ltx_worker.provenance import provenance
from ltx_worker.weights import HF_REVISION

from .conftest import FakeEngine, needs_ffmpeg, valid_input

WORKER = Path(__file__).parent.parent
DOCKERFILE = (WORKER / "Dockerfile").read_text()
WORKFLOW = WORKER.parent.parent / ".github" / "workflows" / "build-ltx-worker.yml"


# ── provenance ───────────────────────────────────────────────────────────────────────────


def test_provenance_reports_build_code_and_weights(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("CONVEYER_WORKER_REVISION", "a" * 40)
    monkeypatch.setenv("LTX_TORCH_CUDA", "cu132")
    monkeypatch.delenv("CONVEYER_BUILD_TIMESTAMP", raising=False)
    assert provenance() == {
        "workerRevision": "a" * 40,
        "ltxVersion": LTX_GIT_TAG,
        "ltxCommit": LTX_GIT_COMMIT,
        "weightsRevision": HF_REVISION,
        "torchCuda": "cu132",
    }


def test_unknown_build_is_reported_as_unknown_and_timestamp_is_optional(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("CONVEYER_WORKER_REVISION", raising=False)
    monkeypatch.setenv("CONVEYER_BUILD_TIMESTAMP", "2026-10-02T12:00:00Z")
    p = provenance()
    assert p["workerRevision"] == "unknown"
    assert p["buildTimestamp"] == "2026-10-02T12:00:00Z"


@needs_ffmpeg
def test_job_result_carries_provenance_and_peak_memory(volume: Path, image: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("CONVEYER_WORKER_REVISION", "b" * 40)
    engine = FakeEngine()
    engine.peak = 21 * 2**30
    res = handle(valid_input(), engine=engine)
    assert (res["workerRevision"], res["ltxVersion"], res["weightsRevision"]) == ("b" * 40, LTX_GIT_TAG, HF_REVISION)
    assert res["peakCudaMemoryBytes"] == 21 * 2**30


@needs_ffmpeg
def test_no_peak_field_without_a_cuda_measurement(volume: Path, image: Path):
    assert "peakCudaMemoryBytes" not in handle(valid_input(), engine=FakeEngine())


# ── Dockerfile ↔ code consistency (static; no Docker needed) ─────────────────────────────


def test_dockerfile_installs_exactly_the_ltx_commit_the_code_reports():
    commits = set(re.findall(r"LTX-2\.git@([0-9a-f]{40})", DOCKERFILE))
    assert commits == {LTX_GIT_COMMIT}
    assert "ARG LTX_COMMIT" not in DOCKERFILE  # not overridable, or the result could lie


def test_dockerfile_defaults_to_the_cuda_ltx_pins():
    assert "ARG CUDA_BASE_TAG=13.2.0-base-ubuntu24.04" in DOCKERFILE
    assert "ARG TORCH_CUDA=cu132" in DOCKERFILE
    assert "FROM nvidia/cuda:${CUDA_BASE_TAG}" in DOCKERFILE


def test_provenance_layer_comes_after_every_dependency_layer():
    assert DOCKERFILE.index("ARG WORKER_REVISION") > DOCKERFILE.index("COPY ltx_worker")
    assert DOCKERFILE.index("ARG WORKER_REVISION") > DOCKERFILE.rindex("uv pip install")
    assert "CONVEYER_WORKER_REVISION=${WORKER_REVISION}" in DOCKERFILE


def test_dockerfile_copies_only_existing_paths():
    for src in re.findall(r"^COPY\s+(\S+)\s", DOCKERFILE, flags=re.M):
        assert (WORKER / src).exists(), src


def test_every_worker_module_compiles():
    for f in (WORKER / "ltx_worker").glob("*.py"):
        py_compile.compile(str(f), doraise=True)


# ── build workflow (static) ──────────────────────────────────────────────────────────────


def test_build_workflow_is_manual_only_and_pushes_immutable_tags():
    wf = WORKFLOW.read_text()
    # Triggers = the direct children of the top-level `on:` block: exactly workflow_dispatch.
    on_block = re.search(r"^on:\n((?:[ \t].*\n|\n)*)", wf, flags=re.M).group(1)
    triggers = re.findall(r"^  ([a-z_]+):", on_block, flags=re.M)
    assert triggers == ["workflow_dispatch"]
    assert ":latest" not in wf
    assert "github.sha" in wf
    # The only secret is the job's own GITHUB_TOKEN — no HF / Runpod / S3 credential at build time.
    assert set(re.findall(r"secrets\.([A-Z_]+)", wf)) == {"GITHUB_TOKEN"}
    for banned in ("HF_TOKEN", "RUNPOD_API_KEY", "RUNPOD_S3"):
        assert banned not in wf
    # Third-party actions pinned to a full commit SHA.
    for ref in re.findall(r"uses:\s*\S+@(\S+)", wf):
        assert re.fullmatch(r"[0-9a-f]{40}", ref), ref


# ── logs ─────────────────────────────────────────────────────────────────────────────────


@needs_ffmpeg
def test_logs_are_operational_and_never_contain_prompts_or_secrets(
    volume: Path, image: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
):
    monkeypatch.setenv("HF_TOKEN", "hf_SUPERSECRETVALUE")
    monkeypatch.setenv("RUNPOD_S3_SECRET_ACCESS_KEY", "rps_S3SECRETVALUE")
    caplog.set_level(logging.INFO, logger="ltx_worker")
    prompt = "a very private creative brief nobody should read in logs"
    handle(valid_input(prompt=prompt), engine=FakeEngine(), job_id="job-123")

    from ltx_worker.engine import EngineError

    class Leaky(FakeEngine):
        def generate(self, req, image, out):
            raise EngineError("boom hf_SUPERSECRETVALUE rps_S3SECRETVALUE")

    handle(valid_input(prompt=prompt), engine=Leaky(), job_id="job-124")
    text = caplog.text
    assert "job job-123 start: 128x64, 17 frames @ 24 fps, seed 42, prompt" in text
    assert "job job-123 done:" in text
    assert "job job-124 failed: engine_failed" in text
    assert prompt not in text
    assert "hf_SUPERSECRETVALUE" not in text and "rps_S3SECRETVALUE" not in text

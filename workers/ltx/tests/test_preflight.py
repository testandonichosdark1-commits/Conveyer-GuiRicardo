"""CUDA preflight + boot order, with fake torch/natten modules — no GPU, no CUDA, no weights."""

from __future__ import annotations

import logging
from types import SimpleNamespace

import pytest

from ltx_worker.handler import boot
from ltx_worker.preflight import PreflightError, run_preflight


class FakeTensor:
    def __init__(self, value: float, broken: bool = False) -> None:
        self.value, self.broken = value, broken

    def __matmul__(self, other: FakeTensor) -> FakeTensor:
        if self.broken:
            raise RuntimeError("CUDA error: no kernel image is available for execution on the device")
        return FakeTensor(self.value * other.value * 64)

    def __eq__(self, other: object) -> FakeTensor:  # type: ignore[override]
        return FakeTensor(1.0 if self.value == other else 0.0)

    def all(self) -> FakeTensor:
        return self

    def item(self) -> bool:
        return self.value == 1.0


def fake_torch(*, available=True, count=1, enumerate_error=None, op_broken=False, wrong_result=False):
    state = {"empty_cache": 0, "synchronize": 0}

    def get_props(i):
        if enumerate_error:
            raise enumerate_error
        return SimpleNamespace(name="NVIDIA L40S", total_memory=48 * 2**30, major=8, minor=9)

    def ones(shape, device):
        assert device == "cuda"
        return FakeTensor(0.5 if wrong_result else 1.0, broken=op_broken)

    cuda = SimpleNamespace(
        is_available=lambda: available,
        device_count=lambda: count,
        get_device_properties=get_props,
        synchronize=lambda: state.__setitem__("synchronize", state["synchronize"] + 1),
        empty_cache=lambda: state.__setitem__("empty_cache", state["empty_cache"] + 1),
    )
    mod = SimpleNamespace(__version__="2.13.0+cu132", version=SimpleNamespace(cuda="13.2"), cuda=cuda, ones=ones)
    return mod, state


def importer(torch_mod=None, *, torch_error=None, natten_error=None):
    def imp(name):
        if name == "torch":
            if torch_error:
                raise torch_error
            return torch_mod
        if name == "natten":
            if natten_error:
                raise natten_error
            return SimpleNamespace(__version__="0.21.7")
        raise AssertionError(name)

    return imp


# ── preflight ───────────────────────────────────────────────────────────────────────────


def test_success_reports_the_gpu_and_stack_and_frees_test_memory():
    torch, state = fake_torch()
    r = run_preflight(importer(torch), driver_version=lambda: "580.95.05")
    assert r.as_dict() == {
        "gpu_name": "NVIDIA L40S",
        "gpu_count": 1,
        "total_vram_gib": 48.0,
        "compute_capability": "8.9",
        "torch_version": "2.13.0+cu132",
        "torch_cuda": "13.2",
        "driver_version": "580.95.05",
        "natten_version": "0.21.7",
    }
    assert state["synchronize"] == 1 and state["empty_cache"] == 1


def test_a_13_0_driver_is_not_rejected_for_a_13_2_runtime():
    # The verdict comes from real CUDA work, never from version strings.
    torch, _ = fake_torch()
    torch.version.cuda = "13.2"
    assert run_preflight(importer(torch), driver_version=lambda: "580.65.06").torch_cuda == "13.2"


def test_driver_version_is_optional():
    torch, _ = fake_torch()
    assert run_preflight(importer(torch), driver_version=lambda: None).driver_version is None


@pytest.mark.parametrize(
    ("kwargs", "stage"),
    [
        ({"torch_error": ImportError("libcudart.so.13: cannot open shared object file")}, "torch_import"),
        ({"torch": {"available": False}}, "cuda_available"),
        ({"torch": {"count": 0}}, "enumerate"),
        ({"torch": {"enumerate_error": RuntimeError("CUDA driver initialization failed")}}, "enumerate"),
        ({"torch": {"op_broken": True}}, "cuda_op"),
        ({"torch": {"wrong_result": True}}, "cuda_op"),
        ({"natten_error": ImportError("undefined symbol: _ZN3c10")}, "natten_import"),
    ],
)
def test_each_failure_is_reported_at_its_stage(kwargs, stage):
    torch, state = fake_torch(**kwargs.get("torch", {}))
    imp = importer(torch, torch_error=kwargs.get("torch_error"), natten_error=kwargs.get("natten_error"))
    with pytest.raises(PreflightError) as e:
        run_preflight(imp, driver_version=lambda: None)
    assert e.value.stage == stage
    assert str(e.value).startswith(f"cuda preflight failed at {stage}:")
    if stage == "cuda_op":
        assert state["empty_cache"] == 1  # test memory is freed even on failure


def test_errors_are_short_and_carry_no_traceback_or_secret(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("HF_TOKEN", "hf_SUPERSECRET")
    long = RuntimeError("first line hf_SUPERSECRET\n" + "Traceback (most recent call last):\n  File x\n" * 50)
    torch, _ = fake_torch(enumerate_error=long)
    with pytest.raises(PreflightError) as e:
        run_preflight(importer(torch), driver_version=lambda: None)
    msg = str(e.value)
    assert "Traceback" not in msg and len(msg) < 300
    assert "hf_SUPERSECRET" not in msg and "[REDACTED]" in msg


# ── boot order ──────────────────────────────────────────────────────────────────────────


class Recorder:
    def __init__(self) -> None:
        self.events: list[str] = []

    def engine(self):
        rec = self

        class E:
            loaded = False

            def load(self):
                rec.events.append("load")

        return E()

    def cache_factory(self, dirs):
        rec = self
        rec.events.append(f"cache({','.join(dirs)})")

        class C:
            def hydrate(self):
                rec.events.append("hydrate")

            def sync(self, *, background=True):
                rec.events.append(f"sync(background={background})")

        return C()


def ok_preflight():
    torch, _ = fake_torch()
    return run_preflight(importer(torch), driver_version=lambda: "580.95.05")


def test_boot_runs_preflight_then_hydrate_load_and_an_inline_sync(caplog: pytest.LogCaptureFixture):
    caplog.set_level(logging.INFO, logger="ltx_worker")
    rec = Recorder()
    boot(rec.engine(), preflight=ok_preflight, cache_factory=rec.cache_factory, hf_home="/root/.cache/huggingface")
    assert rec.events == ["cache(/root/.cache/huggingface)", "hydrate", "load", "sync(background=False)"]
    assert "cuda preflight ok: gpu_name=NVIDIA L40S" in caplog.text
    assert "driver_version=580.95.05" in caplog.text


def test_boot_without_volume_cache_just_loads():
    rec = Recorder()
    boot(rec.engine(), preflight=ok_preflight, cache_factory=None, hf_home="/x")
    assert rec.events == ["load"]


@pytest.mark.parametrize("with_cache", [True, False])
def test_a_failed_preflight_never_hydrates_or_loads(with_cache: bool, caplog: pytest.LogCaptureFixture, monkeypatch):
    monkeypatch.setenv("HF_TOKEN", "hf_SUPERSECRETVALUE")

    def failing():
        raise PreflightError("cuda_available", "torch.cuda.is_available() is False — token hf_SUPERSECRETVALUE")

    rec = Recorder()
    with pytest.raises(PreflightError):
        boot(rec.engine(), preflight=failing, cache_factory=rec.cache_factory if with_cache else None, hf_home="/x")
    assert rec.events == []  # no cache object, no hydrate, no load, no sync
    assert "cuda preflight failed at cuda_available" in caplog.text
    assert "hf_SUPERSECRETVALUE" not in caplog.text

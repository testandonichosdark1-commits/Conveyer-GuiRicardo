import pytest

from ltx_worker import weights
from ltx_worker.engine import LTX_GIT_COMMIT, LTX_GIT_TAG, EngineConfig, Ltx25DistilledEngine
from ltx_worker.weights import FILES, HF_REVISION, WeightsUnavailable, resolve_model_files


def test_defaults_are_fp8_cast_and_library_default_residency(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("LTX_RESIDENCY", raising=False)
    monkeypatch.delenv("LTX_QUANTIZATION", raising=False)
    assert EngineConfig.from_env() == EngineConfig(residency="page_cache", quantization="fp8-cast")
    assert EngineConfig() == EngineConfig(quantization="fp8-cast")


def test_bf16_stays_available_by_explicit_override(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("LTX_QUANTIZATION", "none")
    assert EngineConfig.from_env().quantization == "none"


def test_dockerfile_sets_the_allocator_and_quantization_env():
    from pathlib import Path

    text = (Path(__file__).parent.parent / "Dockerfile").read_text()
    assert "PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True" in text
    assert "LTX_QUANTIZATION=fp8-cast" in text
    # Secrets are never baked into the image: no ENV/ARG carries a token, and no token value appears.
    import re

    instructions = [ln for ln in text.splitlines() if not ln.lstrip().startswith("#")]
    assert not any("HF_TOKEN" in ln or "API_KEY" in ln for ln in instructions)
    assert not re.search(r"hf_[A-Za-z0-9]{20,}", text)


@pytest.mark.parametrize(("var", "value"), [("LTX_RESIDENCY", "vram"), ("LTX_QUANTIZATION", "int4")])
def test_unknown_modes_fail_loudly(monkeypatch: pytest.MonkeyPatch, var, value):
    monkeypatch.setenv(var, value)
    with pytest.raises(ValueError, match=var):
        EngineConfig.from_env()


def test_constructing_the_real_engine_loads_nothing():
    e = Ltx25DistilledEngine(EngineConfig())
    assert e.loaded is False
    assert e.info() == {"model": "LTX-2.5", "pipeline": "distilled", "residency": "page_cache", "quantization": "fp8-cast"}


def test_versions_are_pinned_not_floating():
    assert LTX_GIT_TAG == "v1.4.2" and len(LTX_GIT_COMMIT) == 40
    assert len(HF_REVISION) == 40 and HF_REVISION != "main"


def test_only_the_five_distilled_pipeline_files_are_fetched():
    assert set(FILES) == {"transformer", "text_encoder", "video_vae", "audio_vae", "spatial_upsampler"}
    assert "distilled" in FILES["transformer"] and "dev" not in FILES["transformer"]


def test_download_without_a_token_is_refused_before_any_network(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("LTX_ALLOW_WEIGHT_DOWNLOAD", "1")
    monkeypatch.delenv("HF_TOKEN", raising=False)
    with pytest.raises(WeightsUnavailable, match="HF_TOKEN"):
        resolve_model_files()


def test_offline_with_an_empty_cache_fails_clearly_without_network(monkeypatch: pytest.MonkeyPatch, tmp_path):
    pytest.importorskip("huggingface_hub")
    monkeypatch.delenv("LTX_ALLOW_WEIGHT_DOWNLOAD", raising=False)
    monkeypatch.setenv("HF_HUB_OFFLINE", "1")
    monkeypatch.setenv("HF_HOME", str(tmp_path / "hf"))
    monkeypatch.setenv("HF_TOKEN", "hf_SUPERSECRET")
    with pytest.raises(WeightsUnavailable, match="downloads are disabled") as e:
        resolve_model_files()
    assert "hf_SUPERSECRET" not in str(e.value)
    assert weights.HF_REPO == "Lightricks/LTX-2.5"

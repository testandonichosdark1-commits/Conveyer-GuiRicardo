# Runpod Serverless worker: still image -> LTX-2.5 DistilledPipeline -> MP4 on a network volume.
#
# No model weights and no secrets in this image. Weights (66.2 GiB) come from the HF cache
# that runpod.serverless.VolumeCache mirrors onto the endpoint's network volume (see
# ltx_worker/weights.py). HF_TOKEN, when needed, is an endpoint secret, never a build arg.
#
# Versions are the ones Lightricks/LTX-2 v1.4.2 resolves (packages/ltx-core/pyproject.toml):
# torch 2.13.0 + CUDA 13.2 wheels, torchaudio from the cu132 test index, natten built for
# that torch, and the repo's cuDNN override. The torch wheels bundle the CUDA libraries, so
# the base image is the minimal CUDA "base" (no system cuDNN, which the LTX repo warns can
# shadow the wheel's and fail with CUDNN_STATUS_SUBLIBRARY_VERSION_MISMATCH).
# Hosts must run an NVIDIA driver that supports CUDA 13.2 — restrict the endpoint's allowed
# CUDA versions accordingly.

FROM nvidia/cuda:13.2.0-base-ubuntu24.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    VIRTUAL_ENV=/opt/venv \
    PATH=/opt/venv/bin:$PATH \
    UV_NO_CACHE=1 \
    HF_HOME=/root/.cache/huggingface \
    HF_HUB_DISABLE_TELEMETRY=1 \
    RUNPOD_VOLUME_MOUNT=/runpod-volume \
    LTX_QUANTIZATION=fp8-cast \
    PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True

# System: Python 3.12 (Ubuntu 24.04), git (to fetch the pinned LTX source), ffmpeg/ffprobe
# (output validation).
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3.12 python3.12-venv git ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && python3.12 -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir uv==0.9.30

# 1. PyTorch stack — the heaviest layer, changes least often.
COPY overrides.txt /tmp/overrides.txt
RUN uv pip install --python /opt/venv/bin/python \
      --override /tmp/overrides.txt \
      --index-strategy unsafe-best-match \
      --extra-index-url https://download.pytorch.org/whl/cu132 \
      --extra-index-url https://download.pytorch.org/whl/test/cu132 \
      --find-links https://whl.natten.org \
      "torch==2.13.0+cu132" "torchvision==0.28.0+cu132" "torchaudio==2.11.0+cu132" \
      "natten==0.21.7+torch2130cu132"

# 2. LTX-2 at an exact commit (tag v1.4.2) — never `main`. Both packages in ONE command so
#    ltx-pipelines' bare "ltx-core" requirement resolves to this commit, not to the older
#    ltx-core release on PyPI; the assert below proves it.
ARG LTX_COMMIT=9ec55f9f22798a3198d9c923856824821bc3317e
RUN uv pip install --python /opt/venv/bin/python \
      --override /tmp/overrides.txt \
      "ltx-core @ git+https://github.com/Lightricks/LTX-2.git@${LTX_COMMIT}#subdirectory=packages/ltx-core" \
      "ltx-pipelines @ git+https://github.com/Lightricks/LTX-2.git@${LTX_COMMIT}#subdirectory=packages/ltx-pipelines" \
 && python -c "import importlib.metadata as m; v = (m.version('ltx-core'), m.version('ltx-pipelines'), m.version('torch')); assert v[:2] == ('1.4.2', '1.4.2') and v[2].startswith('2.13.0'), v; print('pinned', v)"

# 3. Worker runtime dependencies.
COPY requirements.txt /tmp/requirements.txt
RUN uv pip install --python /opt/venv/bin/python --override /tmp/overrides.txt -r /tmp/requirements.txt

# 4. Worker code — the only layer that changes on a worker-only edit.
WORKDIR /app
COPY ltx_worker /app/ltx_worker

CMD ["python", "-u", "-m", "ltx_worker.handler"]

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
#
# CUDA variant. The default is exactly what LTX v1.4.2 pins: cu132. Runpod Serverless exposes
# allowedCudaVersions up to 13.0 (API reference, checked 2026-10-02); a cu132 runtime on 13.x
# drivers is expected-compatible under CUDA 13.x minor-version compatibility, pending runtime
# validation by the worker's CUDA preflight. The same stack also exists as cu130 wheels (torch 2.13.0+cu130,
# torchvision 0.28.0+cu130, torchaudio 2.11.0+cu130, natten 0.21.7+torch2130cu130), selectable
# with --build-arg TORCH_CUDA=cu130 --build-arg CUDA_BASE_TAG=13.0.2-base-ubuntu24.04. That
# variant is NOT what LTX tests against; it is the documented fallback, not the default.
# See DEPLOYMENT.md.

ARG CUDA_BASE_TAG=13.2.0-base-ubuntu24.04
FROM nvidia/cuda:${CUDA_BASE_TAG}
ARG TORCH_CUDA=cu132

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
      --extra-index-url https://download.pytorch.org/whl/${TORCH_CUDA} \
      --extra-index-url https://download.pytorch.org/whl/test/${TORCH_CUDA} \
      --find-links https://whl.natten.org \
      "torch==2.13.0+${TORCH_CUDA}" "torchvision==0.28.0+${TORCH_CUDA}" "torchaudio==2.11.0+${TORCH_CUDA}" \
      "natten==0.21.7+torch2130${TORCH_CUDA}"

# 2. LTX-2 at an exact commit (tag v1.4.2) — never `main`, and not a build arg: it must match
#    ltx_worker/engine.py LTX_GIT_COMMIT, which the job result reports (pinned by a test).
#    Both packages in ONE command so ltx-pipelines' bare "ltx-core" requirement resolves to
#    this commit, not to the older ltx-core release on PyPI; the assert below proves it.
RUN uv pip install --python /opt/venv/bin/python \
      --override /tmp/overrides.txt \
      "ltx-core @ git+https://github.com/Lightricks/LTX-2.git@9ec55f9f22798a3198d9c923856824821bc3317e#subdirectory=packages/ltx-core" \
      "ltx-pipelines @ git+https://github.com/Lightricks/LTX-2.git@9ec55f9f22798a3198d9c923856824821bc3317e#subdirectory=packages/ltx-pipelines" \
 && python -c "import importlib.metadata as m; v = (m.version('ltx-core'), m.version('ltx-pipelines'), m.version('torch')); assert v[:2] == ('1.4.2', '1.4.2') and v[2].startswith('2.13.0'), v; print('pinned', v)" \
 && python -c "import torch, torchaudio, torchvision, ltx_pipelines.distilled, ltx_pipelines.utils.media_io; print('imports ok', torch.__version__, torch.version.cuda)"

# 3. Worker runtime dependencies.
COPY requirements.txt /tmp/requirements.txt
RUN uv pip install --python /opt/venv/bin/python --override /tmp/overrides.txt -r /tmp/requirements.txt

# 4. Worker code — the only layer that changes on a worker-only edit.
WORKDIR /app
COPY ltx_worker /app/ltx_worker
RUN python -m compileall -q /app/ltx_worker \
 && python -c "import ltx_worker.handler, ltx_worker.engine, ltx_worker.weights"

# 5. Provenance, last so a new commit never invalidates the dependency layers above. The job
#    result reports workerRevision; ltxVersion and weightsRevision come from the code itself.
ARG WORKER_REVISION=unknown
ARG BUILD_TIMESTAMP=
ENV CONVEYER_WORKER_REVISION=${WORKER_REVISION} \
    CONVEYER_BUILD_TIMESTAMP=${BUILD_TIMESTAMP} \
    LTX_TORCH_CUDA=${TORCH_CUDA}
LABEL org.opencontainers.image.revision=${WORKER_REVISION} \
      org.opencontainers.image.created=${BUILD_TIMESTAMP} \
      org.opencontainers.image.title="conveyer-ltx-worker"

CMD ["python", "-u", "-m", "ltx_worker.handler"]

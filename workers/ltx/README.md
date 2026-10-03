# LTX-2.5 worker (Runpod Serverless)

Still image → **LTX-2.5 `DistilledPipeline`** → MP4, written to the endpoint's network volume.
An isolated project: nothing in the Conveyer app imports it, and the app does not call it yet.

| Pinned | Value |
|---|---|
| LTX code | [Lightricks/LTX-2](https://github.com/Lightricks/LTX-2) tag `v1.4.2`, commit `9ec55f9f22798a3198d9c923856824821bc3317e` |
| LTX weights | `Lightricks/LTX-2.5` revision `2356ce76915d6c48d313d7e8b25900e1dd3abaa8` (gated) |
| Pipeline | `ltx_pipelines.distilled.DistilledPipeline` (fast/distilled; no DFR, no dev model) |
| Runtime | Python 3.12, torch `2.13.0+cu132`, torchvision `0.28.0+cu132`, torchaudio `2.11.0+cu132`, natten `0.21.7+torch2130cu132`, cuDNN `9.24.0.43`, transformers `5.14.1` (resolved) |
| Image base | `nvidia/cuda:13.2.0-base-ubuntu24.04` — hosts need a driver supporting CUDA 13.2 |
| SDK | `runpod==1.12.0`, `huggingface_hub==1.33.0` (transformers < 5.15 requires hub < 2) |

## Input (`job.input`)

Every field is required; unknown fields are rejected. Nothing important is defaulted.

| Field | Type | Rule |
|---|---|---|
| `prompt` | string | non-empty, ≤ 4000 chars (worker cap) |
| `imagePath` | string | **relative** to the volume; existing `.png`/`.jpg`/`.jpeg`; conditions frame 0 |
| `imageStrength` | number | `(0, 1]` — LTX's image-conditioning strength |
| `outputPath` | string | **relative** to the volume; ends in `.mp4`; parents created inside the volume |
| `width`, `height` | int | multiple of **64** (LTX two-stage rule); 64–2048 (worker cap) |
| `fps` | int | 1–60 (worker cap; LTX default is 24) |
| `numFrames` | int | `(numFrames − 1) % 8 == 0` (LTX temporal grid), ≤ 257 (worker cap). Off-grid values are **rejected**, never snapped |
| `seed` | int | 0 … 2⁶³−1 |

The worker does not take a duration: the caller converts a beat length into a legal frame
count. Example:

```json
{ "input": {
  "prompt": "slow push-in on a quiet harbour at dawn, soft light",
  "imagePath": "jobs/ab12cd/input.png",
  "imageStrength": 1.0,
  "outputPath": "jobs/ab12cd/output.mp4",
  "width": 1920, "height": 1088, "fps": 24, "numFrames": 121, "seed": 42
} }
```

## Output

```json
{ "storage": "network_volume", "path": "jobs/ab12cd/output.mp4",
  "model": "LTX-2.5", "pipeline": "distilled", "ltxVersion": "v1.4.2",
  "residency": "page_cache", "quantization": "fp8-cast",
  "width": 1920, "height": 1088, "fps": 24, "numFrames": 121, "durationSec": 5.041667,
  "seed": 42, "bytes": 123456, "codec": "h264",
  "sha256": "9f2c…64 lowercase hex chars…",
  "timings": { "loadSec": 0.0, "generateSec": 81.2, "validateSec": 0.6, "totalSec": 82.0 } }
```

`sha256` is the lowercase-hex SHA-256 of the published file, computed by the worker after
ffprobe validation and before the atomic rename (same bytes). Callers verify downloads against
`bytes` + `sha256`, never an S3 ETag.

Never media, base64, absolute paths, secrets or tracebacks. Failures return
`{"error": "<code>: <message>"}` (Runpod marks the job FAILED), with codes
`invalid_input`, `invalid_path`, `weights_unavailable`, `engine_failed`, `invalid_output`, `internal`.

Runpod keeps `/run` results for 30 minutes; the clip itself is on the volume, which is the
durable copy. The caller must fetch it from there.

## Paths and the volume

The volume is mounted at `/runpod-volume` (override: `RUNPOD_VOLUME_MOUNT`, for tests/local).
Rejected: absolute paths, `~`, drive letters, backslashes, NUL, empty/`.`/`..` segments,
symlinks resolving outside the mount, an output path that is a symlink or a directory, and
output == input. Output parent directories are created one component at a time after checking
each existing one, so a symlinked directory cannot make the worker write outside the mount.

## Atomic output

The engine writes `.<name>.partial-<hex>.mp4` next to `outputPath`; ffprobe must confirm a
single video stream, the exact resolution, exactly `numFrames` decoded frames, a duration of
`numFrames/fps` (± one frame), and no audio stream. Then fsync and `rename` onto `outputPath`.
Any failure deletes the partial file and leaves a previous `outputPath` untouched.

## Model lifecycle

`LtxEngine` (`ltx_worker/engine.py`): `load()` once at worker start (before `runpod.serverless.start`),
`generate()` per job under a lock (one generation per worker; scale = more workers), `info()`.
The CLI is never spawned per job.

| Env | Values | Meaning |
|---|---|---|
| `LTX_RESIDENCY` | `page_cache` (default) / `gpu` / `cpu` | where weights live between jobs — see engine.py docstring |
| `LTX_QUANTIZATION` | `fp8-cast` (default) / `none` (bf16) | transformer quantization; FP8 Cast is LTX's documented low-memory mode |
| `PYTORCH_CUDA_ALLOC_CONF` | `expandable_segments:True` (image default) | allocator setting LTX recommends with FP8 |
| `LTX_ALLOW_WEIGHT_DOWNLOAD` | `0` (default) / `1` | allow the one-time weight download |
| `HF_TOKEN` | secret | required only with downloads (gated repo); never logged or returned |
| `HF_HOME` | `/root/.cache/huggingface` | HF cache = the directory mirrored by VolumeCache |
| `LTX_VOLUME_CACHE` | `1` (default) / `0` | wrap model loading in `runpod.serverless.VolumeCache` |
| `RUNPOD_VOLUME_MOUNT` | `/runpod-volume` | volume root |

GPU choice and GPU fallback are **endpoint configuration on Runpod**, not worker code.
The default (`page_cache` + `fp8-cast`) roughly halves the transformer's VRAM versus bf16
(39.13 GiB on disk); exact peaks are an estimate until the first real run. `LTX_QUANTIZATION=none`
selects bf16 explicitly.

**Audio:** LTX-2.5 is a joint audio-video model; `DistilledPipeline` always computes audio and
offers no supported switch to skip it. The worker does not patch internals — it writes a
video-only file through the documented `encode_video(audio=None)`. Conveyer strips audio anyway.

## Weights & cache

Five files, 66.23 GiB, never in the image:
`diffusion_models/ltx-2.5-22b-distilled-transformer-bf16` (39.13), `text_encoders/gemma4-12b-with-proj-ltx-2.5-bf16`
(24.46), `vae/ltx-2.5-video-vae-bf16` (1.37), `vae/ltx-2.5-audio-vae-bf16` (0.34),
`latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0` (0.93).

They are fetched per file with `hf_hub_download` into `HF_HOME`, which `VolumeCache` mirrors to
`/runpod-volume/.cache/<RUNPOD_ENDPOINT_ID>/`: first cold start downloads + syncs, later cold starts
hydrate from the volume. Runpod's endpoint "model caching" was not used: it caches the whole repo
(> 160 GiB, every variant). Container disk must hold the hydrated 66 GiB.

## Tests (no GPU, no network, no weights)

```bash
cd workers/ltx
python3 -m venv .venv && .venv/bin/pip install -r requirements-test.txt
.venv/bin/python -m pytest
```

A fake engine writes real tiny MP4s with the system `ffmpeg`, so the ffprobe checks run for real
(tests needing ffmpeg skip if it is absent).

## Local test with a GPU (later, manual)

```bash
docker build -t conveyer-ltx-worker workers/ltx
mkdir -p /tmp/vol/jobs/t1 && cp still.png /tmp/vol/jobs/t1/input.png
docker run --gpus all -e RUNPOD_VOLUME_MOUNT=/vol -v /tmp/vol:/vol \
  -e LTX_VOLUME_CACHE=0 -v /path/to/hf-cache:/root/.cache/huggingface \
  conveyer-ltx-worker python -m ltx_worker.handler --test_input '{"input": {...}}'
```

(`--test_input` is the Runpod SDK's local mode.)

## Deploy (later — not done in this phase)

Push the image to a registry; create a queue-based Serverless endpoint with a network volume,
max concurrency 1 per worker, allowed CUDA ≥ 13.2, GPU priority list on the endpoint, the env
above, and `HF_TOKEN` as a secret for the first, download-enabled cold start. Then set
`RUNPOD_LTX_ENDPOINT_ID` in Conveyer.

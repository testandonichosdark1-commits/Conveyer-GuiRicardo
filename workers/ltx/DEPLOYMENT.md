# LTX worker — deployment plan (Phase 6C-A)

Status: **plan only.** Nothing in this file has been applied: no image built, no Runpod
resource created, no job sent. Runpod facts were checked against docs.runpod.io on 2026-10-02;
prices change — re-read them before creating anything.

Goal of the first real test:

```
local image ─upload─▶ network volume ─▶ LTX worker ─▶ MP4 on the volume ─download─▶ local
```

---

## 1. Dockerfile audit (static — no Docker available locally)

| Item | State | Proven only by a build/run |
|---|---|---|
| Base | `nvidia/cuda:${CUDA_BASE_TAG}`, default `13.2.0-base-ubuntu24.04` (tag exists on Docker Hub; amd64 ≈ 176 MiB compressed). "base" = no system cuDNN, as LTX's pyproject warns system cuDNN can shadow the wheel's | — |
| Python | Ubuntu 24.04 `python3.12` + venv at `/opt/venv` | — |
| FFmpeg | apt `ffmpeg` (ffprobe used by output validation) | version is Ubuntu's (6.1.x) |
| torch / torchvision / torchaudio | `2.13.0` / `0.28.0` / `2.11.0` `+${TORCH_CUDA}` (default cu132) — the set LTX v1.4.2 resolves; full set resolved with `uv pip compile` for linux/x86_64/py3.12 | torchaudio 2.11 loading against torch 2.13 (now asserted by an import step at build) |
| NATTEN | `0.21.7+torch2130${TORCH_CUDA}` from whl.natten.org | that it loads on the GPU (not imported at build: no driver there) |
| cuDNN | `overrides.txt` → `nvidia-cudnn-cu13==9.24.0.43` (LTX's own override), applied by `uv --override` | that uv applied it over torch's pin |
| LTX | git commit `9ec55f9f…` (tag v1.4.2) for both packages in one command; build asserts `ltx-core`/`ltx-pipelines` == 1.4.2 and imports `ltx_pipelines.distilled` | the git build with `uv_build` |
| Runpod SDK | `runpod==1.12.0` (has `VolumeCache.hydrate()` / `sync(background=)`), `huggingface_hub==1.33.0` | — |
| Entrypoint | `CMD python -u -m ltx_worker.handler` → `main()` → **CUDA preflight** → hydrate → load → sync → `runpod.serverless.start` | first cold start |
| COPY | `overrides.txt`, `requirements.txt`, `ltx_worker/` — all exist (pinned by a test) | — |
| WORKDIR | `/app` | — |
| ENV | `HF_HOME=/root/.cache/huggingface`, `RUNPOD_VOLUME_MOUNT=/runpod-volume`, `LTX_QUANTIZATION=fp8-cast`, `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True`, `HF_HUB_DISABLE_TELEMETRY=1`, provenance `CONVEYER_WORKER_REVISION`, `CONVEYER_BUILD_TIMESTAMP`, `LTX_TORCH_CUDA` | — |
| VolumeCache | `dirs=[HF_HOME]`, namespace = `RUNPOD_ENDPOINT_ID` (Runpod-injected), mirror at `/runpod-volume/.cache/<endpoint-id>/`; sync is **inline** before "ready" (a background sync could be cut by the idle timeout) | hydrate/sync throughput on a real volume |
| Cache paths | weights in `/root/.cache/huggingface/hub/models--Lightricks--LTX-2.5/` on **container disk** after hydrate | container disk size (see §4) |
| User | root (Runpod workers run as root; `HF_HOME` is under `/root`) | — |
| Secrets | none in the image; a test rejects any `ENV`/`ARG` naming `HF_TOKEN`/`API_KEY` | — |

Expected layer sizes (uncompressed, from the resolved wheels' real sizes): base ~0.2 GB ·
apt ~0.6 GB · **torch + CUDA wheels ~6 GB** (≈ 2.9 GiB compressed: torch 0.49, cuDNN 0.52, cuBLAS 0.38, …) ·
LTX + transformers/av/openimageio/scipy ~0.8 GB · SDK < 0.1 GB · worker code < 1 MB.
**Total ≈ 7.5–8 GB uncompressed, ≈ 3–3.5 GB to pull.** Estimates — the build prints the truth.

## 2. Build & registry

`.github/workflows/build-ltx-worker.yml` — **manual** (`workflow_dispatch`), never on push.
Runs the worker tests first, frees runner disk, then builds `workers/ltx` for linux/amd64.

| Input | Image tag |
|---|---|
| `torch_cuda=cu132` (default) | `ghcr.io/testandonichosdark1-commits/conveyer-guiricardo/ltx-worker:<git-sha>` |
| `torch_cuda=cu130` | `…/ltx-worker:<git-sha>-cu130` |
| `staging_tag=true` | additionally `…:staging` / `…:staging-cu130` (mutable; never a production reference) |

No `latest`. Endpoints reference the SHA tag or the digest from the run summary.

**Build secrets:** only the job's `GITHUB_TOKEN` (`packages: write`). No HF token, Runpod key or
S3 credential. Every build download is anonymous (PyPI, download.pytorch.org, whl.natten.org,
github.com/Lightricks/LTX-2 — public). Actions are pinned to commit SHAs.

**Pulling from Runpod:** GHCR packages are private by default. Either make the package public,
or add a GHCR read-only token (`read:packages`) as a Runpod container-registry credential.
That token is a *pull* credential for the endpoint, not a build secret.

## 3. Provenance

Every job result carries `workerRevision` (git SHA via build arg), `ltxVersion` (`v1.4.2`),
`ltxCommit`, `weightsRevision` (`2356ce76…`), `torchCuda`, and `buildTimestamp` (commit time,
informational only — never an identity). Also as OCI labels on the image.

## 4. Endpoint configuration (proposed, not applied)

| Setting | Value | Why |
|---|---|---|
| Type | **Queue-based** | async jobs, built-in retries, `/run` + `/status` (what RunpodManager speaks) |
| Image | `…/ltx-worker:<git-sha>` | immutable |
| Active (min) workers | **0** | no idle billing |
| Max workers | **1** | first test: one worker, measurable |
| GPUs per worker | **1** | |
| GPU types | **one category only** (see §5) — no fallback list yet | know exactly what ran |
| Allowed CUDA versions | **13.0** (see §6 — cu132 expected-compatible, pending validation) | |
| Data center | the network volume's (attaching a volume pins the endpoint to its DC) | |
| Network volume | the one from §7 | |
| Container disk | **≥ 100 GB** | hydrated weights 66.2 GiB (≈ 71 GB) + image ≈ 8 GB + HF temp + headroom |
| Idle timeout | **5 s** (allowed 1–3600) | cold starts are dominated by weights, not by idle reuse |
| FlashBoot | on (default) | |
| Execution timeout | **1800 s** for the first test | must cover a cold-start model load if it ever lands inside a job, plus generation; the 600 s default is not enough margin for an unmeasured first run. Lower once timings are known |
| Job TTL | **7200 s** for the first test | > execution timeout + queue + a first cold start that downloads 66 GiB |
| Env | `LTX_RESIDENCY=page_cache`, `LTX_QUANTIZATION=fp8-cast`, `LTX_VOLUME_CACHE=1`, `LTX_ALLOW_WEIGHT_DOWNLOAD=1` **for the warm-up only**, `HF_TOKEN` as a Runpod **secret** for the warm-up only | after the first successful sync: `LTX_ALLOW_WEIGHT_DOWNLOAD=0`, remove `HF_TOKEN` |

`executionTimeoutMs` / `ttlMs` can also be sent per request via RunpodManager's `policy`
(Runpod bounds: execution ≥ 5 s, ttl ≥ 10 s, both ≤ 7 days).

## 5. GPU for the first smoke test

Memory model with `fp8-cast` + `page_cache`: components are built on the GPU one stage at a
time. FP8 Cast quantizes the **transformer** (39.13 GiB bf16 → ≈ 20 GiB); the **Gemma text
encoder stays bf16 (24.46 GiB)** and is the largest single component. So the floor is
≈ 25 GiB + activations, before any margin.

| Category | VRAM | Flex price (pricing page, 2026-10-02) | Fit for the first test |
|---|---|---|---|
| RTX 5090 | 32 GB | $1.58/h | Blackwell, native FP8 — but ~25 GiB Gemma + activations leaves almost no headroom. Not first. |
| A6000 / A40 | 48 GB | $1.22/h | cheapest 48 GB, but **Ampere has no FP8 hardware**; LTX documents fp8-cast for "any GPU with FP8 support". Risky as a first proof. |
| **L40 / L40S / RTX 6000 Ada** | 48 GB | $1.75/h | **Ada: native FP8**, 48 GB margin over the ~25 GiB floor. |
| A100 | 80 GB | $2.72/h | most VRAM, but Ampere (same FP8 caveat); fallback if 48 GB proves short. |

**Recommendation: the 48 GB Ada category (L40 / L40S / RTX 6000 Ada), alone, no fallback.** It is
the cheapest option that has both native FP8 and real headroom. Peak VRAM is reported per job
(`peakCudaMemoryBytes`), so the next choice will be measured, not guessed. Runpod groups those
Ada 48 GB cards as one pricing category; if the console only lets you select them as a group,
that still counts as one category for this test.

## 6. CUDA

Runpod currently exposes **13.0** as the highest selectable `allowedCudaVersions` value for an
endpoint (the host driver generation). That does **not** by itself mean a cu132 runtime is
incompatible: per NVIDIA, CUDA 13.x applications have **minor-version compatibility** with any
driver of the 13.x family (driver ≥ 580), with limitations only for features that need a newer
driver (e.g. JIT-compiling PTX newer than the driver understands).

Status of the primary image (cu132, exactly what LTX v1.4.2 pins):
**expected-compatible under CUDA 13.x minor-version compatibility, pending runtime validation.**
Not guaranteed.

- Primary: **cu132**. The default does not change.
- Fallback: **cu130** (`torch_cuda=cu130` workflow input: same torch/torchvision/torchaudio/natten
  versions as cu130 wheels, `13.0.2-base` image — wheels verified to exist, but not the variant
  LTX tests against). Use it **only on real evidence** of a cu132 incompatibility.
- The evidence comes from the worker's **CUDA preflight** (§11): it runs before any weight is
  touched and exercises real CUDA (allocation, matmul, synchronize) plus the NATTEN import. A host
  is never rejected because `nvidia-smi` prints "CUDA Version: 13.0" — that text is the driver's
  generation, not a verdict on the runtime.

## 7. Network volume

Contents: VolumeCache mirror of the weights (66.23 GiB ≈ 71 GB) · inputs/outputs under
`conveyer/` (stills < 5 MB, short clips < 50 MB each) · smoke files · room for one future
weights revision to coexist briefly during a switch.

**Recommendation: 150 GB** (≈ $10.50/month at $0.07/GB/month under 1 TB). Not 66 GiB: the mirror
alone is ~71 GB, VolumeCache's large-file layout and the HF cache structure add overhead, and a
full volume fails the sync mid-copy. 150 GB leaves ~75 GB for assets and a partial second
revision. Runpod volumes have a fixed capacity; size up rather than run out.

## 8. Data center (S3 API required)

S3-compatible API data centers (docs, 2026-10-02): EU-CZ-1, EU-RO-1, EUR-IS-1, EUR-NO-1, US-CA-2,
US-GA-2, US-IL-1, US-KS-2, US-MD-1, US-MO-1, US-MO-2, US-NC-1, US-NC-2.

Candidates, **to be confirmed against the console's live availability of the §5 GPU before
creating the volume** (the volume pins the endpoint to its DC; availability is not knowable
from the docs): **EU-RO-1**, **US-KS-2**, **US-IL-1**. Latency to Brazil is irrelevant here —
GPU time and model load dominate. S3 endpoint = `https://s3api-<dc-lowercase>.runpod.io`,
region = the DC id (e.g. `EU-RO-1`).

## 9. S3 smoke test (when a volume exists)

Settings: `RUNPOD_NETWORK_VOLUME_ID`, `RUNPOD_S3_ENDPOINT`, `RUNPOD_S3_REGION`,
`RUNPOD_S3_ACCESS_KEY_ID`, `RUNPOD_S3_SECRET_ACCESS_KEY` (S3 API key from the console's
*S3 API Keys* tab — not the Runpod API key). Then:

```
npx tsx scripts/runpod-s3-smoke.ts --confirm
```

| Step | Action | Validates |
|---|---|---|
| A | create a 256 KiB random local file | — |
| B | `uploadRunpodAsset()` → `conveyer/smoke/s3-<date>-<rand>.bin` | auth, region, bucket = volume id, path-style addressing, PutObject |
| C | `headRunpodAsset()` | HeadObject, read-after-write via S3 |
| D | *(needs the endpoint)* the worker sees `/runpod-volume/<same path>` | S3 ↔ filesystem mapping |
| E | `downloadRunpodAsset()` with expected bytes + sha256 | GetObject streaming, atomic download |
| F | SHA-256 of original == uploaded == downloaded | integrity end to end |

The script refuses to run without `--confirm`, deletes its object afterwards, never prints a credential.

## 10. First LTX job (not executed)

Fixture: any real photo, converted locally to `768×512` PNG
(`ffmpeg -i photo.jpg -vf "scale=768:512:force_original_aspect_ratio=increase,crop=768:512" input.png`),
uploaded to `conveyer/smoke/ltx-001/input.png`.

```json
{ "input": {
  "prompt": "The camera slowly pushes in. Gentle natural motion. No text.",
  "imagePath": "conveyer/smoke/ltx-001/input.png",
  "imageStrength": 1.0,
  "outputPath": "conveyer/smoke/ltx-001/output.mp4",
  "width": 768, "height": 512, "fps": 24, "numFrames": 25, "seed": 42
} }
```

Checks: 768 = 12×64, 512 = 8×64 (two-stage rule); (25 − 1) % 8 = 0 (temporal grid) → 4 latent
frames, 1.04 s at 24 fps — the smallest clip that still shows motion. `imageStrength` 1.0 = the
still pinned as frame 0 (LTX's `ImageConditioningInput.strength`). Submit with RunpodManager,
`policy: { executionTimeoutMs: 1_800_000, ttlMs: 7_200_000 }`; poll `waitForRunpodTerminalStatus`;
then `downloadRunpodAsset(output.path, local, { expectedBytes: output.bytes, expectedSha256: output.sha256 })`.

Success = worker starts → weights hydrated/downloaded → CUDA visible → LTX generates → ffprobe-valid
MP4 → it is back on the Mac with a matching SHA-256.

## 11. Observability

Worker stdout (Runpod endpoint logs), INFO level, nothing secret:
`startup` (workerRevision, ltxVersion, ltxCommit, weightsRevision, torchCuda, residency,
quantization, download allowed/disabled, volume cache on/off) ·
`cuda preflight ok: gpu_name=… gpu_count=… total_vram_gib=… compute_capability=… torch_version=…
torch_cuda=… driver_version=… natten_version=…` (or `cuda preflight failed at <stage>: …` and the
worker exits **before** any weight is hydrated, downloaded or loaded) · `volume cache hydrated in Xs` ·
`resolving weights` · `model loaded in Xs` ·
`volume cache synced in Xs` · `ready for jobs` · per job: `start` (id, size, frames, fps, seed,
**prompt length only**) and `done` (bytes, generate s, total s, **peak CUDA memory**) or `failed`
(code + scrubbed message). Tokens, S3 keys, Runpod key and HF token are never logged; known secret
env values are redacted from error text.

## 12. Cost of the first test

```
GPU cost     = billed worker seconds × (hourly price / 3600)
               billed = worker start → full stop, rounded up to the second (includes cold start,
               model load and the idle timeout tail)
Storage cost = volume GB × $/GB/month × (days kept / 30)
Disk         = container disk is ~$0.10/GB/month while workers exist
```

Record per run: **cold start** (worker start → `ready for jobs`; first run includes the 66 GiB
download + sync), **model load** (`model loaded in`), **generation** (`generateSec`), **total
worker time** (billed seconds). Example: an L40S at $1.75/h running 25 min end to end ≈ $0.73;
the 150 GB volume ≈ $0.35/day.

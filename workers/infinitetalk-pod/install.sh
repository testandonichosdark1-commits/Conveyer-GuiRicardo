#!/usr/bin/env bash
# InfiniteTalk test-round installer. Runs INSIDE the rented Pod only, after the
# independent guardian (see guardian.py, adapted from workers/ltx-pod) is armed.
# Separate from workers/ltx-pod on purpose — never shares environment or weights
# with the LTX setup. Pinned to the commit reviewed in the prep session so this
# always installs the exact code that was evaluated, not whatever is on main today.
#
# Two corrections versus the official README, both measured against real file
# sizes/wheel availability before this round was authorized:
#   1. flash-attn installs from the Dao-AILab PREBUILT wheel (cu12/torch2.4/cp310)
#      instead of `pip install flash_attn==2.7.4.post1`, which compiles from
#      source (20-45+ min). The prebuilt wheel is ~1-2 min.
#   2. MeiGen-AI/InfiniteTalk downloads ONLY single/infinitetalk.safetensors
#      (9.95 GB) via --include, instead of the whole repo (168.5 GB of
#      multi/comfyui/fp8/int8/lora variants this single-image test never uses).
#
# Every step times itself and logs to stdout so progress is visible against the
# authorized 65-minute early-stop, and the script fails LOUD (set -e) rather than
# silently continuing after a broken step on billed GPU time.
#
# Incident 2026-10-10: `--quiet`/`-qq` on the network-heavy steps below produced
# several SILENT minutes (zero bytes over the SSH connection) during the torch wheel
# download, and some network path between the controller and the Pod dropped the
# connection as "idle" — neither end noticed until the round's time was already spent.
# Every pip/apt call below now runs WITHOUT quiet flags so its own natural progress
# output keeps the connection visibly alive; this is a second, independent layer under
# the SSH keepalive the controller now sets (run_round.py's SSH_OPTS).

set -euo pipefail

INFINITETALK_COMMIT="50aa0a94184315407a991ae804d9b58d6d311ba8"
WORK_DIR="${INFINITETALK_WORK_DIR:-/workspace/infinitetalk}"
WEIGHTS_DIR="$WORK_DIR/weights"
VENV_DIR="$WORK_DIR/.venv"
FLASH_ATTN_WHEEL_URL="https://github.com/Dao-AILab/flash-attention/releases/download/v2.7.4.post1/flash_attn-2.7.4.post1+cu12torch2.4cxx11abiFALSE-cp310-cp310-linux_x86_64.whl"

step() { echo; echo "=== [$(date -u +%H:%M:%S)] $* ==="; }
t0=$(date +%s)
elapsed() { echo "    (elapsed so far: $(( ($(date +%s) - t0) / 60 ))m $(( ($(date +%s) - t0) % 60 ))s)"; }

mkdir -p "$WORK_DIR"
cd "$WORK_DIR"

step "0/9 Base OS packages (bare nvidia/cuda:12.1.1-devel image has no Python/git/huggingface-cli)"
apt-get update
apt-get install -y python3.10 python3.10-venv python3-pip git curl ca-certificates
pip install -U "huggingface_hub[cli]"
elapsed

step "1/9 Cloning InfiniteTalk @ $INFINITETALK_COMMIT"
if [ ! -d "$WORK_DIR/repo/.git" ]; then
  git clone https://github.com/MeiGen-AI/InfiniteTalk.git "$WORK_DIR/repo"
fi
git -C "$WORK_DIR/repo" checkout "$INFINITETALK_COMMIT"
elapsed

step "2/9 Python 3.10 venv"
if [ ! -x "$VENV_DIR/bin/python" ]; then
  python3.10 -m venv "$VENV_DIR"
fi
# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"
python -m pip install --upgrade pip
elapsed

step "3/9 PyTorch 2.4.1 / torchvision / torchaudio (cu121) — skipped if already correct"
CURRENT_TORCH="$(python -c 'import torch; print(torch.__version__)' 2>/dev/null || echo none)"
if [[ "$CURRENT_TORCH" == 2.4.1* ]]; then
  echo "    torch $CURRENT_TORCH already present — skipping (saves the ~2.5GB wheel download)"
else
  pip install torch==2.4.1 torchvision==0.19.1 torchaudio==2.4.1 \
    --index-url https://download.pytorch.org/whl/cu121
fi
elapsed

step "4/9 xformers 0.0.28 (cu121, prebuilt wheel)"
pip install -U xformers==0.0.28 --index-url https://download.pytorch.org/whl/cu121
elapsed

step "5/9 flash-attn 2.7.4.post1 — PREBUILT WHEEL (correction #1, not a source compile)"
pip install misaki[en] psutil packaging wheel
pip install "$FLASH_ATTN_WHEEL_URL"
python -c "import flash_attn; print('flash_attn', flash_attn.__version__, 'OK (no compile)')"
elapsed

step "6/9 Repo requirements.txt + librosa + ffmpeg + huggingface-cli (inside the venv, not just system Python)"
pip install -r "$WORK_DIR/repo/requirements.txt"
# Incident 2026-10-10 (round 3): requirements.txt pins diffusers/transformers/accelerate with NO
# upper bound ("diffusers>=0.31.0" etc), so pip grabbed today's latest (diffusers 0.41.0,
# transformers 5.19.0 — a major version jump). diffusers' import-time get_device() now calls
# torch.accelerator.is_available(), an API that doesn't exist on the torch 2.4.1 this repo
# requires — crashing `import wan` before generation ever starts.
#
# Round 4: pinning diffusers==0.31.0 (the repo's own stated floor) fixed that crash but traded
# it for another — xfuser (also unbounded: "xfuser>=0.4.1") imports
# diffusers.models.transformers.sana_transformer.SanaAttnProcessor2_0, a class diffusers added
# in 0.32.0, one minor release after 0.31.0. diffusers==0.33.1 is the version actually pinned
# here: it has sana_transformer (verified against the real source at that tag) AND still predates
# diffusers' torch.accelerator-dependent get_device() entirely (verified: no get_device/
# torch.accelerator symbol anywhere in utils/torch_utils.py at this tag, so the crashing code
# path doesn't exist yet, not just a different branch of it).
pip install "diffusers==0.33.1" "transformers==4.49.0" "accelerate==1.1.1"
pip install librosa "huggingface_hub[cli]"
apt-get install -y ffmpeg

# Round 5 fix: every xfuser version satisfying the repo's own "xfuser>=0.4.1" floor (checked
# 0.4.1 through 0.7.0 against the real source — all of them) imports
# torch.distributed.tensor.experimental._attention at xfuser/__init__ import time, via its
# Lumina2 pipeline wrapper (a model this test never uses) reaching xfuser/model_executor/
# layers/usp.py. That submodule genuinely does not exist in torch 2.4.1 (verified against the
# real torch source at tag v2.4.1 — torch.distributed.tensor itself IS real there, only its
# .experimental submodule is missing) — PyTorch added it later for DTensor ring attention. No
# xfuser version avoids this import, so there is no version pin that fixes it the way pinning
# diffusers fixed the earlier failure.
#
# Read from usp.py's own source: the stubbed function is called ONLY from ring_attn(), which
# USP() only reaches when sequence-parallel world_size > 1 (multi-GPU). This test is single-GPU,
# single-process (--mode clip, no torchrun) — world_size is 1, so USP() takes its first branch
# and ring_attn is never entered. The stub existing but never executing is the intended outcome;
# it exists only so the unconditional top-level `from ... import _templated_ring_attention`
# succeeds at import time. Written as the venv's own sitecustomize.py (auto-loaded by Python at
# interpreter start, scoped to this venv only) so no InfiniteTalk/xfuser source is patched.
#
# Round 6/7/8 all tried a sitecustomize.py-based stub (auto-loaded by Python's `site` module at
# interpreter start) and ALL THREE hit the identical bare
# `ModuleNotFoundError: No module named 'torch.distributed.tensor.experimental'` at the
# verification line, with zero sitecustomize output even though round 8 added explicit
# print(..., flush=True) statements as the very FIRST lines of that file. Round 8 proved
# `'sitecustomize' in sys.modules` was True yet none of its prints ever fired — meaning SOME
# sitecustomize module was loaded (no ModuleNotFoundError on the name itself), but not the one
# this heredoc wrote: something else on this image's Python search path is shadowing it. Rather
# than keep chasing why `site` auto-loading behaves unexpectedly here, this is rewritten to not
# depend on it at all: the stub lives in its own plain file, imported BY EXPLICIT PATH from a
# tiny wrapper that run_test.sh invokes instead of generate_infinitetalk.py directly — the stub
# runs in the same interpreter, right before the target script, with no reliance on `site`.
cat > "$WORK_DIR/torch_dtensor_experimental_stub.py" <<'PYEOF'
"""Stub for torch.distributed.tensor.experimental._attention — see install.sh step 6 for the
full incident writeup (rounds 5-8). xfuser (every version satisfying InfiniteTalk's own
"xfuser>=0.4.1" floor) imports this at xfuser/__init__ time via its Lumina2 pipeline wrapper (a
model this test never uses), reaching xfuser/model_executor/layers/usp.py. The submodule
genuinely does not exist in torch 2.4.1 (verified against the real torch source at tag v2.4.1).
Read from usp.py's own source: the stubbed function is called ONLY from ring_attn(), which
USP() only reaches when sequence-parallel world_size > 1 (multi-GPU). This test is single-GPU,
single-process (--mode clip, no torchrun) — world_size is 1, so ring_attn is never entered; the
stub existing but never executing is the intended outcome, it only needs to satisfy the
unconditional top-level `from ... import _templated_ring_attention`.
"""
import sys
import types

import torch.distributed.tensor as _dtensor

_experimental = types.ModuleType("torch.distributed.tensor.experimental")
_attention = types.ModuleType("torch.distributed.tensor.experimental._attention")


def _templated_ring_attention(*_args, **_kwargs):
    raise NotImplementedError(
        "torch.distributed.tensor.experimental._attention is a stub (absent in torch "
        "2.4.1); only reachable with sequence-parallel world_size > 1, which this "
        "single-GPU run never has."
    )


class _CpOptions:
    enable_load_balance = True


_attention._templated_ring_attention = _templated_ring_attention
_attention._cp_options = _CpOptions()
_experimental._attention = _attention
_dtensor.experimental = _experimental

sys.modules["torch.distributed.tensor.experimental"] = _experimental
sys.modules["torch.distributed.tensor.experimental._attention"] = _attention
PYEOF
python -c "
import sys
sys.path.insert(0, '$WORK_DIR')
import torch_dtensor_experimental_stub
from torch.distributed.tensor.experimental._attention import _templated_ring_attention
print('stub OK (explicit import, no site/sitecustomize):', _templated_ring_attention, flush=True)
"

# Wrapper run_test.sh invokes instead of generate_infinitetalk.py directly: applies the stub
# above by explicit import (not by relying on it being auto-loaded), then runs the real script
# in the same process via runpy so its own argv/behavior is unchanged. Adds both $WORK_DIR (for
# the stub module) and the current directory (run_test.sh already cd's into the repo, where
# generate_infinitetalk.py's own `import wan` expects its package to resolve from) to sys.path,
# since invoking this wrapper instead of generate_infinitetalk.py directly changes sys.path[0].
cat > "$WORK_DIR/run_generate_patched.py" <<'PYEOF'
import os
import sys

sys.path.insert(0, os.environ.get("INFINITETALK_WORK_DIR", "/workspace/infinitetalk"))
sys.path.insert(0, os.getcwd())
import torch_dtensor_experimental_stub  # noqa: F401 (import applies the stub as a side effect)

sys.argv[0] = "generate_infinitetalk.py"
import runpy
runpy.run_path("generate_infinitetalk.py", run_name="__main__")
PYEOF
elapsed

step "7/9 Weights: Wan2.1-I2V-14B-480P (82.3 GB, every file is actually used — VAE + 7 diffusion shards + T5 + CLIP)"
hf download Wan-AI/Wan2.1-I2V-14B-480P --local-dir "$WEIGHTS_DIR/Wan2.1-I2V-14B-480P"
elapsed

step "8/9 Weights: chinese-wav2vec2-base (1.5 GB)"
hf download TencentGameMate/chinese-wav2vec2-base --local-dir "$WEIGHTS_DIR/chinese-wav2vec2-base"
hf download TencentGameMate/chinese-wav2vec2-base model.safetensors \
  --revision refs/pr/1 --local-dir "$WEIGHTS_DIR/chinese-wav2vec2-base"
elapsed

step "9/9 Weights: MeiGen-AI/InfiniteTalk — SELECTIVE (correction #2: 9.95 GB, not the 168.5 GB full repo)"
hf download MeiGen-AI/InfiniteTalk \
  --include "single/infinitetalk.safetensors" \
  --local-dir "$WEIGHTS_DIR/InfiniteTalk"
elapsed

echo
echo "=== Install complete. Total: $(( ($(date +%s) - t0) / 60 ))m $(( ($(date +%s) - t0) % 60 ))s ==="
echo "Next: run generate_infinitetalk.py with the prepared test input — see run_test.sh"

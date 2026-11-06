#!/usr/bin/env bash
# Runs the ONE prepared test generation (Finn's reference photo + the 10.14s
# narration clip) after install.sh has finished. Single GPU, low-VRAM mode
# (--num_persistent_param_in_dit 0) because a single RTX 4090 (24GB) is tight
# for this 14B-parameter model otherwise — an OOM here would waste the round.
# --mode clip (not streaming): this is one short 10s clip, not a long-form video.

set -euo pipefail

WORK_DIR="${INFINITETALK_WORK_DIR:-/workspace/infinitetalk}"
REPO_DIR="$WORK_DIR/repo"
WEIGHTS_DIR="$WORK_DIR/weights"
TEST_INPUTS_SRC="${INFINITETALK_TEST_INPUTS:-$WORK_DIR/test-inputs}"

# shellcheck disable=SC1091
source "$WORK_DIR/.venv/bin/activate"
cd "$REPO_DIR"

mkdir -p inputs
cp "$TEST_INPUTS_SRC/finn-referencia.jpg" inputs/
cp "$TEST_INPUTS_SRC/narracao-teste.wav" inputs/
cp "$TEST_INPUTS_SRC/entrada-infinitetalk.json" ./test_input.json

echo "=== [$(date -u +%H:%M:%S)] Starting generation (480p, clip mode, low-VRAM) ==="
t0=$(date +%s)

# Runs through run_generate_patched.py (written by install.sh step 6), not
# generate_infinitetalk.py directly — it applies the torch.distributed.tensor.experimental
# stub by explicit import before running the real script in the same process via runpy, then
# the args below reach generate_infinitetalk.py's own argparse completely unchanged.
python "$WORK_DIR/run_generate_patched.py" \
  --ckpt_dir "$WEIGHTS_DIR/Wan2.1-I2V-14B-480P" \
  --wav2vec_dir "$WEIGHTS_DIR/chinese-wav2vec2-base" \
  --infinitetalk_dir "$WEIGHTS_DIR/InfiniteTalk/single/infinitetalk.safetensors" \
  --input_json test_input.json \
  --size infinitetalk-480 \
  --sample_steps 40 \
  --mode clip \
  --num_persistent_param_in_dit 0 \
  --motion_frame 9 \
  --save_file infinitetalk_res_test

echo "=== [$(date -u +%H:%M:%S)] Generation finished — $(( ($(date +%s) - t0) / 60 ))m $(( ($(date +%s) - t0) % 60 ))s ==="
echo "Output: $REPO_DIR/infinitetalk_res_test.mp4 (or the extension generate_infinitetalk.py writes)"

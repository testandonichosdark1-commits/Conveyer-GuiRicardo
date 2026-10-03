# Downloads the checkpoints InfiniteTalk's official I2V example workflow needs, into
# ComfyUI's model folders. All public on HuggingFace (no token/login required). Folder
# paths below are taken from (a) the exact relative paths stored in the official
# workflow's widgets_values and (b) folder_paths.add_model_folder_path() calls read
# directly out of the installed custom node source (multitalk/nodes.py for wav2vec2).
#
# Deliberately NOT the Q8_0 main checkpoint the example workflow shipped with (18.1 GB) —
# Q4_K_M (11.3 GB) is used instead. WanVideoBlockSwap already offloads blocks between
# GPU/CPU for an 8GB card either way, so a smaller quant means less to swap, not just a
# smaller download. Same reasoning for UMT5-XXL: fp8 (6.7 GB) instead of bf16 (11.4 GB).
#
# Usage: powershell -File scripts/download-infinitetalk-checkpoints.ps1 -DataDir "C:\path\to\data\dir"

param(
  [Parameter(Mandatory = $true)]
  [string]$DataDir
)

$ErrorActionPreference = "Stop"
$ComfyDir = Join-Path $DataDir "comfyui"
$ModelsDir = Join-Path $ComfyDir "models"

function Download-IfMissing($Url, $OutPath, $Label) {
  $dir = Split-Path $OutPath -Parent
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  if (Test-Path $OutPath) {
    $sizeGB = [math]::Round((Get-Item $OutPath).Length / 1GB, 2)
    Write-Output "$Label already present ($sizeGB GB), skipping: $OutPath"
    return
  }
  Write-Output "Downloading $Label to $OutPath ..."
  & curl.exe -L --fail -o $OutPath $Url
  if ($LASTEXITCODE -ne 0) {
    Remove-Item -Force -ErrorAction SilentlyContinue $OutPath
    throw "$Label download failed (curl exit $LASTEXITCODE)"
  }
  $sizeGB = [math]::Round((Get-Item $OutPath).Length / 1GB, 2)
  Write-Output "$Label done ($sizeGB GB)."
}

# 1. Main WanVideo 2.1 I2V 14B diffusion model (GGUF Q4_K_M, ~11.3 GB)
Download-IfMissing `
  "https://huggingface.co/city96/Wan2.1-I2V-14B-480P-gguf/resolve/main/wan2.1-i2v-14b-480p-Q4_K_M.gguf" `
  (Join-Path $ModelsDir "diffusion_models\WanVideo\wan2.1-i2v-14b-480p-Q4_K_M.gguf") `
  "WanVideo 2.1 I2V 14B (Q4_K_M)"

# 2. InfiniteTalk model (GGUF Q8, ~2.65 GB)
Download-IfMissing `
  "https://huggingface.co/Kijai/WanVideo_comfy_GGUF/resolve/main/InfiniteTalk/Wan2_1-InfiniteTalk_Single_Q8.gguf" `
  (Join-Path $ModelsDir "diffusion_models\WanVideo\InfiniteTalk\Wan2_1-InfiniteTalk_Single_Q8.gguf") `
  "InfiniteTalk (Q8)"

# 3. VAE (~253 MB)
Download-IfMissing `
  "https://huggingface.co/Kijai/WanVideo_comfy/resolve/main/Wan2_1_VAE_bf16.safetensors" `
  (Join-Path $ModelsDir "vae\wanvideo\Wan2_1_VAE_bf16.safetensors") `
  "WanVideo VAE"

# 4. CLIP Vision (~1.26 GB)
Download-IfMissing `
  "https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/clip_vision/clip_vision_h.safetensors" `
  (Join-Path $ModelsDir "clip_vision\clip_vision_h.safetensors") `
  "CLIP Vision H"

# 5. Lightx2v distillation LoRA (~738 MB) — lets the distilled checkpoint run in fewer steps
Download-IfMissing `
  "https://huggingface.co/Kijai/WanVideo_comfy/resolve/main/Lightx2v/lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors" `
  (Join-Path $ModelsDir "loras\WanVideo\Lightx2v\lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors") `
  "Lightx2v distill LoRA"

# 6. UMT5-XXL text encoder (fp8, ~6.73 GB)
Download-IfMissing `
  "https://huggingface.co/Kijai/WanVideo_comfy/resolve/main/umt5-xxl-enc-fp8_e4m3fn.safetensors" `
  (Join-Path $ModelsDir "text_encoders\umt5-xxl-enc-fp8_e4m3fn.safetensors") `
  "UMT5-XXL text encoder (fp8)"

# 7. Wav2Vec2 audio model (~190 MB) — folder registered by multitalk/nodes.py in WanVideoWrapper
Download-IfMissing `
  "https://huggingface.co/Kijai/wav2vec2_safetensors/resolve/main/wav2vec2-chinese-base_fp16.safetensors" `
  (Join-Path $ModelsDir "wav2vec2\wav2vec2-chinese-base_fp16.safetensors") `
  "Wav2Vec2 (Chinese base, fp16)"

# 8. MelBandRoFormer vocal separator (~456 MB) — loads from models/diffusion_models per its own docs
Download-IfMissing `
  "https://huggingface.co/Kijai/MelBandRoFormer_comfy/resolve/main/MelBandRoformer_fp16.safetensors" `
  (Join-Path $ModelsDir "diffusion_models\MelBandRoformer\MelBandRoformer_fp16.safetensors") `
  "MelBandRoFormer vocal separator"

Write-Output "=== Done. ~23.6 GB total. Checkpoints ready for the InfiniteTalk I2V workflow. ==="

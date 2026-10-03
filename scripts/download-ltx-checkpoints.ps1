# Downloads the two checkpoints the LTX-Video 2B distilled workflow needs, straight into
# ComfyUI's model folders. Both are public on HuggingFace (no token/login required).
#  - ltxv-2b-0.9.6-distilled-04-25.safetensors (~6.3 GB) - the LTX-Video diffusion+VAE
#    checkpoint, the DISTILLED 2B tier chosen specifically because it fits an 8GB GPU
#    (needs as few as 8 sampling steps vs the base model's ~30+).
#  - t5xxl_fp16.safetensors (~9.8 GB) - the T5 text encoder LTX-Video conditions on,
#    the same shared file several other open models (Flux etc.) also use.
#
# Usage: powershell -File scripts/download-ltx-checkpoints.ps1 -DataDir "C:\path\to\data\dir"

param(
  [Parameter(Mandatory = $true)]
  [string]$DataDir
)

$ErrorActionPreference = "Stop"
$ComfyDir = Join-Path $DataDir "comfyui"
$CheckpointDir = Join-Path $ComfyDir "models\checkpoints"
$ClipDir = Join-Path $ComfyDir "models\clip"

New-Item -ItemType Directory -Force -Path $CheckpointDir | Out-Null
New-Item -ItemType Directory -Force -Path $ClipDir | Out-Null

$LtxPath = Join-Path $CheckpointDir "ltxv-2b-0.9.6-distilled-04-25.safetensors"
$T5Path = Join-Path $ClipDir "t5xxl_fp16.safetensors"

function Download-IfMissing($Url, $OutPath, $Label) {
  if (Test-Path $OutPath) {
    $sizeGB = [math]::Round((Get-Item $OutPath).Length / 1GB, 2)
    Write-Output "$Label already present ($sizeGB GB), skipping: $OutPath"
    return
  }
  Write-Output "Downloading $Label to $OutPath ..."
  # curl.exe (the real one, not the PowerShell alias) follows redirects and shows progress.
  & curl.exe -L --fail -o $OutPath $Url
  if ($LASTEXITCODE -ne 0) {
    Remove-Item -Force -ErrorAction SilentlyContinue $OutPath
    throw "$Label download failed (curl exit $LASTEXITCODE)"
  }
  $sizeGB = [math]::Round((Get-Item $OutPath).Length / 1GB, 2)
  Write-Output "$Label done ($sizeGB GB)."
}

Download-IfMissing "https://huggingface.co/Lightricks/LTX-Video/resolve/main/ltxv-2b-0.9.6-distilled-04-25.safetensors" $LtxPath "LTX-Video 2B distilled checkpoint"
Download-IfMissing "https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp16.safetensors" $T5Path "T5-XXL text encoder"

Write-Output "=== Done. Checkpoints ready for the LTXV text-to-video workflow. ==="

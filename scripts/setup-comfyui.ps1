# Installs ComfyUI into DATA_DIR/comfyui (same convention as the rest of the app's data:
# outside the project source tree, per-branch isolated). Idempotent: re-running updates
# an existing checkout instead of re-cloning. Does NOT download any LTX-Video/InfiniteTalk
# checkpoints - that is a separate, much larger step (download-ltx-checkpoints.ps1).
#
# Usage: powershell -File scripts/setup-comfyui.ps1 -DataDir "C:\path\to\data\dir"

param(
  [Parameter(Mandatory = $true)]
  [string]$DataDir
)

$ErrorActionPreference = "Stop"
$ComfyDir = Join-Path $DataDir "comfyui"

Write-Output "=== ComfyUI install target: $ComfyDir ==="

if (-not (Test-Path $ComfyDir)) {
  Write-Output "Cloning ComfyUI..."
  git clone --depth 1 https://github.com/comfyanonymous/ComfyUI.git $ComfyDir
} else {
  Write-Output "ComfyUI checkout already exists, pulling latest..."
  Push-Location $ComfyDir
  git pull --ff-only
  Pop-Location
}

$VenvDir = Join-Path $ComfyDir ".venv"
if (-not (Test-Path $VenvDir)) {
  Write-Output "Creating venv..."
  python -m venv $VenvDir
}

$VenvPython = Join-Path $VenvDir "Scripts\python.exe"
$VenvPip = Join-Path $VenvDir "Scripts\pip.exe"

Write-Output "Upgrading pip..."
& $VenvPython -m pip install --upgrade pip

Write-Output "Installing PyTorch (CUDA 12.4 wheel - matches driver 617.x)..."
& $VenvPip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu124

Write-Output "Installing ComfyUI requirements..."
& $VenvPip install -r (Join-Path $ComfyDir "requirements.txt")

$ManagerDir = Join-Path $ComfyDir "custom_nodes\ComfyUI-Manager"
if (-not (Test-Path $ManagerDir)) {
  Write-Output "Cloning ComfyUI-Manager (custom node install UI)..."
  git clone --depth 1 https://github.com/ltdrdata/ComfyUI-Manager.git $ManagerDir
  & $VenvPip install -r (Join-Path $ManagerDir "requirements.txt")
}

Write-Output "=== Done. Start with: $VenvPython $ComfyDir\main.py ==="

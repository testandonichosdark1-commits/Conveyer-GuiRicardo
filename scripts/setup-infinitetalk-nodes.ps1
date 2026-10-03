# Installs the 4 custom node packs InfiniteTalk's official example workflow needs
# (kijai/ComfyUI-WanVideoWrapper for the actual InfiniteTalk/MultiTalk/WanVideo nodes,
# Kosinkadink/ComfyUI-VideoHelperSuite for VHS_VideoCombine, kijai/ComfyUI-KJNodes for
# ImageResizeKJv2/GetImageSizeAndCount, kijai/ComfyUI-MelBandRoFormer for the vocal
# separator used to clean the input audio), into the SAME ComfyUI checkout
# setup-comfyui.ps1 already provisioned. Idempotent.
#
# Usage: powershell -File scripts/setup-infinitetalk-nodes.ps1 -DataDir "C:\path\to\data\dir"

param(
  [Parameter(Mandatory = $true)]
  [string]$DataDir
)

$ErrorActionPreference = "Stop"
$ComfyDir = Join-Path $DataDir "comfyui"
$CustomNodesDir = Join-Path $ComfyDir "custom_nodes"
$VenvPip = Join-Path $ComfyDir ".venv\Scripts\pip.exe"

function Install-Node($RepoUrl, $DirName) {
  $target = Join-Path $CustomNodesDir $DirName
  if (-not (Test-Path $target)) {
    Write-Output "Cloning $DirName..."
    git clone --depth 1 $RepoUrl $target
  } else {
    Write-Output "$DirName already cloned, pulling latest..."
    Push-Location $target
    git pull --ff-only
    Pop-Location
  }
  $req = Join-Path $target "requirements.txt"
  if (Test-Path $req) {
    Write-Output "Installing $DirName requirements..."
    & $VenvPip install -r $req
  }
}

Install-Node "https://github.com/kijai/ComfyUI-WanVideoWrapper" "ComfyUI-WanVideoWrapper"
Install-Node "https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite" "ComfyUI-VideoHelperSuite"
Install-Node "https://github.com/kijai/ComfyUI-KJNodes" "ComfyUI-KJNodes"
Install-Node "https://github.com/kijai/ComfyUI-MelBandRoFormer" "ComfyUI-MelBandRoFormer"

Write-Output "=== Done. Restart ComfyUI to load the new nodes. ==="

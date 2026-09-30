<#
  Installs Ultron's optional add-ons into %USERPROFILE%\UltronTools (or $env:ULTRON_TOOLS_DIR).
  Ultron works without them; each one adds abilities:

    browser   - browser-use: an autonomous agent for many-step jobs on one website
    youtube   - yt-dlp + feedparser (from Agent-Reach): YouTube transcripts and RSS feeds
    memory    - Hindsight: a second, learning memory (needs Ollama running a local model; ~1 GB of RAM while on)
    skills    - Scientific Agent Skills + Lateral Thinking: guides the agents look up by themselves

  Usage (PowerShell, from the Ultron folder):
    powershell -ExecutionPolicy Bypass -File scripts\install-addons.ps1            # everything
    powershell -ExecutionPolicy Bypass -File scripts\install-addons.ps1 youtube skills

  Needs uv (a Python installer - it fetches Python 3.12 by itself): winget install --id astral-sh.uv -e
  Tested versions are pinned; each add-on gets its own isolated environment, nothing is installed system-wide.
#>
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Only)

$ErrorActionPreference = 'Stop'
# Windows PowerShell's download progress bar makes Invoke-WebRequest many times slower.
$ProgressPreference = 'SilentlyContinue'
$root = if ($env:ULTRON_TOOLS_DIR) { $env:ULTRON_TOOLS_DIR } else { Join-Path $HOME 'UltronTools' }
$want = if ($Only -and $Only.Count) { $Only } else { @('browser', 'youtube', 'memory', 'skills') }

function Need-Uv {
  $uv = Get-Command uv -ErrorAction SilentlyContinue
  if (-not $uv) {
    Write-Host ''
    Write-Host 'uv is not installed. Install it with:' -ForegroundColor Yellow
    Write-Host '  winget install --id astral-sh.uv -e'
    Write-Host 'then open a NEW PowerShell window and run this script again.'
    exit 1
  }
  return $uv.Source
}

function New-Venv([string]$name, [string[]]$packages) {
  $uv = Need-Uv
  $dir = Join-Path $root "py\$name"
  Write-Host "`n== $name -> $dir" -ForegroundColor Cyan
  if (-not (Test-Path (Join-Path $dir 'Scripts\python.exe'))) { & $uv venv $dir --python 3.12 }
  & $uv pip install --python (Join-Path $dir 'Scripts\python.exe') @packages
  if ($LASTEXITCODE -ne 0) { throw "Installing $name failed." }
}

function Get-Skills([string]$name, [string]$repo, [string]$commit) {
  $dest = Join-Path $root "skills\$name"
  Write-Host "`n== $name -> $dest" -ForegroundColor Cyan
  if (Test-Path $dest) { Write-Host 'already there - delete the folder to reinstall'; return }
  $zip = Join-Path $env:TEMP "$name.zip"
  $tmp = Join-Path $env:TEMP "$name-unzip"
  # A fixed commit: the exact files Ultron was tested with.
  Invoke-WebRequest "https://github.com/$repo/archive/$commit.zip" -OutFile $zip -UseBasicParsing
  if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
  Expand-Archive $zip $tmp
  New-Item -ItemType Directory -Force (Split-Path $dest) | Out-Null
  Move-Item (Get-ChildItem $tmp -Directory | Select-Object -First 1).FullName $dest
  Remove-Item $zip, $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

New-Item -ItemType Directory -Force $root | Out-Null
if ($want -contains 'browser') { New-Venv 'browser-use' @('browser-use==0.13.10') }
if ($want -contains 'youtube') { New-Venv 'agent-reach' @('yt-dlp', 'feedparser==6.0.14') }
if ($want -contains 'memory') { New-Venv 'hindsight' @('hindsight-api-slim[local-onnx,embedded-db]==0.10.2') }
if ($want -contains 'skills') {
  Get-Skills 'scientific-agent-skills' 'K-Dense-AI/scientific-agent-skills' '65d6e786832e2c52832713117bbbf5096b56f77f'
  Get-Skills 'lateral-thinking' 'danium/lateral-thinking' 'bde713dcbb9b2dab53cbca900b057db1fc46f398'
}

Write-Host "`nDone. Restart Ultron, then check Apps -> Add-ons." -ForegroundColor Green
if ($want -contains 'youtube') { Write-Host 'YouTube transcripts also need Node.js (nodejs.org) - yt-dlp uses it to read YouTube pages.' }
if ($want -contains 'memory') { Write-Host 'Hindsight memory runs on the local model: install Ollama (ollama.com) and download a model in Settings.' }

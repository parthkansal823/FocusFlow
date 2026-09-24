<#
.SYNOPSIS
  Sets up FocusFlow's thinking AI on this Windows PC: free, unlimited, offline,
  running on your NVIDIA GPU.

.DESCRIPTION
  1. Installs Ollama (with winget) if it isn't installed.
  2. Tunes it for speed: model kept loaded, 2 parallel requests, flash attention,
     compact context memory, and permission for the browser extension.
  3. Restarts Ollama, downloads the model and checks that it runs on the GPU.
  4. Runs a speed test with two real FocusFlow-style judgements (thinking on).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\windows\setup-ollama.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\windows\setup-ollama.ps1 -Model qwen3:1.7b
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\windows\setup-ollama.ps1 -TestOnly
#>
[CmdletBinding()]
param(
  # qwen3:4b: the best thinking model that runs fully on a 4 GB GPU (e.g. RTX A500).
  # qwen3:1.7b answers faster; qwen3:8b judges a little better but needs 6+ GB of GPU memory.
  [string]$Model = "qwen3:4b",
  [string]$Server = "http://localhost:11434",
  # Skip setup and only run the speed test.
  [switch]$TestOnly,
  # Print what would be changed without changing anything.
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue" # progress bars make downloads very slow in Windows PowerShell 5.1

function Write-Step([string]$Text) { Write-Host ""; Write-Host "==> $Text" -ForegroundColor Cyan }
function Write-Note([string]$Text) { Write-Host "    $Text" }
function Write-Warn([string]$Text) { Write-Host "    ! $Text" -ForegroundColor Yellow }

$OllamaDir = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA "Programs\Ollama" } else { "" }

# Settings Ollama reads when it starts.
$OllamaSettings = [ordered]@{
  OLLAMA_ORIGINS         = "chrome-extension://*,moz-extension://*" # let the extension talk to Ollama
  OLLAMA_KEEP_ALIVE      = "-1"   # keep the model loaded: no waiting for it to load again
  OLLAMA_NUM_PARALLEL    = "2"    # the page you open never waits behind a background judgement
  OLLAMA_FLASH_ATTENTION = "1"    # faster attention on NVIDIA GPUs
  OLLAMA_KV_CACHE_TYPE   = "q8_0" # half-size context memory, so everything stays on a 4 GB GPU
}

function Find-Ollama {
  $command = Get-Command ollama -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  if ($OllamaDir) {
    $exe = Join-Path $OllamaDir "ollama.exe"
    if (Test-Path $exe) { return $exe }
  }
  return $null
}

function Install-Ollama {
  Write-Step "Installing Ollama"
  if ($DryRun) { Write-Note "[dry run] winget install --id Ollama.Ollama"; return "ollama" }
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Write-Warn "winget is not available. Install Ollama from https://ollama.com/download/windows and run this script again."
    exit 1
  }
  winget install --id Ollama.Ollama -e --accept-source-agreements --accept-package-agreements
  $exe = Find-Ollama
  if (-not $exe) {
    Write-Warn "Ollama was installed but not found yet. Close this window, open a new one and run the script again."
    exit 1
  }
  return $exe
}

function Set-OllamaSettings {
  Write-Step "Tuning Ollama for speed"
  foreach ($name in $OllamaSettings.Keys) {
    $value = $OllamaSettings[$name]
    Write-Note ("{0,-24} = {1}" -f $name, $value)
    if (-not $DryRun) {
      [Environment]::SetEnvironmentVariable($name, $value, "User")
      Set-Item -Path "env:$name" -Value $value
    }
  }
}

function Test-Server {
  try {
    Invoke-RestMethod -Uri "$Server/api/version" -TimeoutSec 2 | Out-Null
    return $true
  } catch {
    return $false
  }
}

function Restart-Ollama([string]$Exe) {
  Write-Step "Restarting Ollama with the new settings"
  if ($DryRun) { Write-Note "[dry run] stop 'ollama app' and 'ollama', start them again"; return }
  Get-Process -Name "ollama app", "ollama" -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 2
  $app = if ($OllamaDir) { Join-Path $OllamaDir "ollama app.exe" } else { "" }
  if ($app -and (Test-Path $app)) {
    Start-Process -FilePath $app
  } else {
    Start-Process -FilePath $Exe -ArgumentList "serve" -WindowStyle Hidden
  }
  for ($i = 0; $i -lt 60; $i++) {
    if (Test-Server) { Write-Note "Ollama is running."; return }
    Start-Sleep -Seconds 1
  }
  Write-Warn "Ollama did not start within a minute. Start it from the Start menu, then run: setup-ollama.ps1 -TestOnly"
  exit 1
}

function Get-Model([string]$Exe) {
  Write-Step "Downloading $Model (only the first time)"
  if ($DryRun) { Write-Note "[dry run] ollama pull $Model"; return }
  & $Exe pull $Model
  if ($LASTEXITCODE -ne 0) { Write-Warn "Could not download $Model."; exit 1 }
}

$SystemPrompt = @"
You are FocusFlow, a strict study filter for a computer-science student preparing for software engineering placements.
Only study and tech content may open. Everything else is blocked.
ALLOW only clearly educational or technical content. BLOCK entertainment, music, movies, sports, gaming, vlogs, comedy, memes, social feeds, shopping, and anything you are unsure about.
Think briefly: a few short sentences are enough. Then give the final answer as one line of JSON:
{"verdict": "ALLOW" or "BLOCK", "site": "study" or "mixed" or "distraction", "reason": "at most 12 words"}
"@

# One FocusFlow-style judgement. Returns seconds taken and the verdict.
function Invoke-Judgement([string]$Title, [string]$Channel, [string]$Category) {
  $user = "Website: youtube.com`nType: YouTube video`nVideo title: $Title`nChannel: $Channel`nYouTube category: $Category`n`nIs this study/tech content? Answer with the JSON line.`n/think"
  $body = @{
    model       = $Model
    messages    = @(@{ role = "system"; content = $SystemPrompt }, @{ role = "user"; content = $user })
    temperature = 0.6
    max_tokens  = 1536
    stream      = $false
  } | ConvertTo-Json -Depth 5
  $clock = [Diagnostics.Stopwatch]::StartNew()
  $response = Invoke-RestMethod -Uri "$Server/v1/chat/completions" -Method Post -ContentType "application/json" `
    -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 300
  $clock.Stop()
  $answer = [regex]::Replace([string]$response.choices[0].message.content, "(?s)<think>.*?</think>", "")
  $verdicts = [regex]::Matches($answer.ToUpper(), "\b(ALLOW|BLOCK)\b")
  $verdict = if ($verdicts.Count) { $verdicts[$verdicts.Count - 1].Value } else { "?" }
  return [pscustomobject]@{ Seconds = [math]::Round($clock.Elapsed.TotalSeconds, 1); Verdict = $verdict }
}

function Test-Speed([string]$Exe) {
  Write-Step "Speed test (thinking on, like FocusFlow)"
  if ($DryRun -and -not (Test-Server)) { Write-Note "[dry run] no server to test"; return }
  $first = Invoke-Judgement "Binary Search Introduction | Striver A2Z DSA Course" "take U forward" "Education"
  Write-Note ("First answer (loads the model): {0,5} s  -> {1} (expected ALLOW)" -f $first.Seconds, $first.Verdict)
  $warm = Invoke-Judgement "Try not to laugh challenge #42" "LOL Central" "Comedy"
  Write-Note ("Next answer (model loaded):     {0,5} s  -> {1} (expected BLOCK)" -f $warm.Seconds, $warm.Verdict)

  if ($Exe -and -not $DryRun) {
    $status = (& $Exe ps) -join "`n"
    if ($status -match "GPU") {
      Write-Note "Running on the GPU."
    } elseif ($status -match "CPU") {
      Write-Warn "The model is running on the CPU. Update the NVIDIA driver and restart Ollama for full speed."
    }
    Write-Host ($status -replace "(?m)^", "    ")
  }
  if ($warm.Seconds -gt 10) {
    Write-Warn "Slower than expected. Plug in the charger, use the 'Best performance' power mode, or try -Model qwen3:1.7b."
    Write-Warn "If you install several models, remove the ones you don't want: FocusFlow's 'auto' picks the biggest Qwen3."
  }
}

Write-Host "FocusFlow: thinking AI setup ($Model)" -ForegroundColor Green
$exe = Find-Ollama
if (-not $TestOnly) {
  if (-not $exe) { $exe = Install-Ollama } else { Write-Step "Ollama found"; Write-Note $exe }
  Set-OllamaSettings
  Restart-Ollama $exe
  Get-Model $exe
}
Test-Speed $exe

Write-Step "Done"
Write-Note "In FocusFlow -> Settings -> Thinking AI: choose 'This computer' and Save."
Write-Note "Model 'auto' picks $Model (the best thinking model installed)."

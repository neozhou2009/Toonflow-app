# Toonflow Windows 启动脚本
# 用法：在本目录（Toonflow-app\）打开 PowerShell，执行
#   .\start-toonflow.ps1
#   .\start-toonflow.ps1 -Background    后台运行
#   .\start-toonflow.ps1 -ForceBuild    强制重新构建
# 注意：本文件必须是 UTF-8 with BOM 编码，否则 PowerShell 5.1 会把中文读成乱码。

param(
    [switch]$Background,
    [switch]$ForceBuild
)

$ErrorActionPreference = "Stop"
$AppDir  = $PSScriptRoot
$Build   = Join-Path $AppDir "build"
$DataDir = Join-Path $AppDir "data"
$LogDir  = Join-Path $AppDir "logs"
$BunVer  = "1.3.14"
$Url     = "http://127.0.0.1:3000"

function Step($msg) { Write-Host "[toonflow] $msg" -ForegroundColor Cyan }
function Fail($msg) { Write-Host "[toonflow] ERROR: $msg" -ForegroundColor Red; exit 1 }

# --- 1. Bun ---
$bunCmd = Get-Command bun -ErrorAction SilentlyContinue
if (-not $bunCmd) {
    $guess = Join-Path $env:USERPROFILE ".bun\bin\bun.exe"
    if (Test-Path $guess) {
        $env:Path = "$env:USERPROFILE\.bun\bin;" + $env:Path
        $bunCmd = Get-Command bun -ErrorAction SilentlyContinue
    }
}
if (-not $bunCmd) {
    Fail "No bun found. Open a NEW PowerShell (PATH refresh) and run: bun --version"
}
Step ("Bun " + (& bun --version))

# --- 2. ffmpeg (optional) ---
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    Step "ffmpeg not found - video compose/audio disabled (image gen unaffected)"
    Step "  install with: winget install Gyan.FFmpeg"
}

# --- 3. Dependencies ---
# The bundled build/ does NOT need node_modules - `bun build\server\index.js` works standalone.
# Only reinstall if you edit source code. And note: upstream pins bun to 1.3.14
# (package.json "packageManager"). A newer bun may rewrite bun.lock - if bun install
# misbehaves, downgrade first: bun upgrade --version 1.3.14   (or: powershell -c "irm bun.sh/install.ps1 | iex -v 1.3.14")
if (-not (Test-Path (Join-Path $AppDir "node_modules\.bun"))) {
    Step "Installing deps (bun install) ..."
    Push-Location $AppDir
    try { & bun install }
    finally { Pop-Location }
}

# --- 4. Build ---
$needBuild = $ForceBuild
foreach ($p in @("build\server\index.js", "build\web", "build\nodes", "build\tools", "build\ext")) {
    if (-not (Test-Path (Join-Path $AppDir $p))) { $needBuild = $true }
}
if ($needBuild) {
    Step "Building (3-8 min, do not interrupt) ..."
    Push-Location $AppDir
    try {
        $env:NODE_ENV = "production"
        & bun apps\server\scripts\buildStandalone.ts
    } finally { Pop-Location }
    if (-not (Test-Path (Join-Path $AppDir "build\server\index.js"))) {
        Fail "Build failed: build\server\index.js not generated"
    }
    Step "Build done"
} else {
    Step "Build artifacts exist, skipping build (use -ForceBuild to rebuild)"
}

# --- 5. Data dir ---
$ws = Join-Path $DataDir "workspaces\myProject"
if (-not (Test-Path $ws)) { New-Item -ItemType Directory -Path $ws -Force | Out-Null }
Step ("Data dir: " + $DataDir)

$env:NODE_ENV = "production"
$env:TOONFLOW_DATA_DIR = $DataDir
$serverJs = Join-Path $Build "server\index.js"

# --- 6. Port check ---
$inUse = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if ($inUse) {
    Fail ("Port 3000 in use (PID " + $inUse[0].OwningProcess + "). Stop it first.")
}

Set-Location $AppDir

if ($Background) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
    $outLog = Join-Path $LogDir "toonflow.log"
    # ampersands inside a cmd command line must be escaped as ^&
    $cmdLine = ('/c ""' + $bunCmd.Source + '" "' + $serverJs + '" > "' + $outLog + '" 2>&1"')
    Start-Process -FilePath "cmd.exe" -ArgumentList $cmdLine -WorkingDirectory $AppDir -WindowStyle Hidden
    Step ("Started in background, log: " + $outLog)
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Seconds 1
        try {
            if ((Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200) { break }
        } catch {}
    }
} else {
    Step "Starting server (Ctrl+C to stop) ..."
    & bun $serverJs
    exit $LASTEXITCODE
}

Step "-------------------------------------------"
Step "Open: $Url"
Step "First time: Settings -> Media Model -> ComfyUI, set your URL and model filenames"
Step "Stop: .\stop-toonflow.ps1     Log: Get-Content logs\toonflow.log -Wait"
Step "-------------------------------------------"

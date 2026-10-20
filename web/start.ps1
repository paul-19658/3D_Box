# One-click launcher for the Xiaobaihe web app.
#
# Double-click start.cmd for the true one-click path, or run this script:
#   .\start.ps1                  production mode: build once, single process
#   .\start.ps1 -Dev             dev mode: backend 8000 + hot-reload frontend 8080
#   .\start.ps1 -Rebuild         force a frontend rebuild before starting
#   .\start.ps1 -Port 8081       change the port
#   .\start.ps1 -NoBrowser       do not open a browser window
#
# Production mode is the default because it needs only ONE process: FastAPI
# serves the built frontend from web/frontend/dist. Dev mode is for editing
# the UI with hot reload.
#
# All messages are ASCII on purpose: Windows PowerShell 5.1 decodes .ps1 files
# using the system code page unless they carry a UTF-8 BOM.

param(
    [int]$Port = 8000,
    [int]$DevPort = 8080,
    [switch]$Dev,
    [switch]$Rebuild,
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$backendDir = Join-Path $root 'backend'
$frontendDir = Join-Path $root 'frontend'
$distIndex = Join-Path $frontendDir 'dist\index.html'

# ----------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------

function Resolve-Python {
    # Python 3.10.11 (final) is required. Alpha builds such as 3.10.0a7 lack
    # types.UnionType, which makes Uvicorn crash on import, so probe for it.
    $local = Join-Path $env:LOCALAPPDATA 'Programs\Python\Python310\python.exe'
    $candidates = @()
    if (Test-Path $local) { $candidates += $local }
    $candidates += 'python'

    foreach ($candidate in $candidates) {
        try {
            $version = & $candidate -c "import sys; print('%d.%d.%d' % sys.version_info[:3])" 2>$null
        } catch {
            continue
        }
        if ($version -match '^3\.10\.\d+$') {
            & $candidate -c "import types, sys; sys.exit(0 if hasattr(types, 'UnionType') else 1)" 2>$null
            if ($LASTEXITCODE -eq 0) { return $candidate }
            Write-Host "Skipping $candidate (version $version lacks types.UnionType)." -ForegroundColor Yellow
        }
    }
    throw 'No usable Python 3.10.x found. Install Python 3.10.11 and retry.'
}

function Test-PortInUse {
    param([int]$Port)
    # Dependency-free check: Get-NetTCPConnection is not available on every
    # SKU, but a plain TCP connect always works.
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $client.Connect('127.0.0.1', $Port)
        $client.Close()
        return $true
    } catch {
        return $false
    }
}

function Assert-PortFree {
    param([int]$Port)
    if (Test-PortInUse -Port $Port) {
        throw "Port $Port is already in use. If the app is already running, just open http://127.0.0.1:$Port . Otherwise stop the process on that port, or pass -Port <other>."
    }
}

function Ensure-NodeModules {
    if (Test-Path (Join-Path $frontendDir 'node_modules')) { return }
    Write-Host 'Installing frontend dependencies (first run, a few minutes)...' -ForegroundColor Yellow
    Push-Location $frontendDir
    try {
        npm install --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw "npm install failed (exit code $LASTEXITCODE)" }
    } finally { Pop-Location }
}

function Ensure-Build {
    $needsBuild = $Rebuild -or -not (Test-Path $distIndex)

    if (-not $needsBuild) {
        # Rebuild when any source file is newer than the built entry point,
        # otherwise the user would silently keep looking at a stale bundle.
        $built = (Get-Item $distIndex).LastWriteTimeUtc
        $newer = Get-ChildItem (Join-Path $frontendDir 'src') -Recurse -File -ErrorAction SilentlyContinue |
            Where-Object { $_.LastWriteTimeUtc -gt $built } |
            Select-Object -First 1
        if ($newer) {
            Write-Host "Frontend source changed ($($newer.Name)); rebuilding..." -ForegroundColor Yellow
            $needsBuild = $true
        }
    }

    if (-not $needsBuild) {
        Write-Host 'Frontend build is up to date.' -ForegroundColor DarkGray
        return
    }

    Write-Host 'Building frontend...' -ForegroundColor Cyan
    Push-Location $frontendDir
    try {
        npm run build
        if ($LASTEXITCODE -ne 0) { throw "npm run build failed (exit code $LASTEXITCODE)" }
    } finally { Pop-Location }
}

function Open-Browser {
    param([string]$Url)
    if ($NoBrowser) { return }
    # Delayed in a detached shell so the browser opens after the server is up,
    # without blocking the foreground server process.
    $command = "Start-Sleep -Seconds 3; Start-Process '$Url'"
    Start-Process powershell -ArgumentList '-NoProfile', '-Command', $command -WindowStyle Hidden
    Write-Host "Opening $Url" -ForegroundColor DarkGray
}

function Wait-Health {
    param([string]$Url, [int]$Seconds = 40)
    for ($i = 0; $i -lt ($Seconds * 2); $i++) {
        Start-Sleep -Milliseconds 500
        try {
            $response = Invoke-WebRequest -UseBasicParsing "$Url/api/health" -TimeoutSec 2
            if ($response.StatusCode -eq 200) { return $true }
        } catch { }
    }
    return $false
}

function Assert-BackendDeps {
    param([string]$Python)
    & $Python -c "import importlib.util, sys; sys.exit(0 if importlib.util.find_spec('fastapi') else 1)" 2>$null
    if ($LASTEXITCODE -eq 0) { return }
    Write-Host 'Installing backend dependencies...' -ForegroundColor Yellow
    Push-Location $backendDir
    try {
        & $Python -m pip install -r requirements.txt
        if ($LASTEXITCODE -ne 0) { throw "pip install failed (exit code $LASTEXITCODE)" }
    } finally { Pop-Location }
}

# ----------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------

# Everything below runs inside this try so the user sees a short, actionable
# message instead of a raw PowerShell stack trace (start.cmd pauses on failure).
try {
    $pythonPath = Resolve-Python
    Write-Host "Python: $pythonPath" -ForegroundColor DarkGray
    Assert-BackendDeps -Python $pythonPath
    Ensure-NodeModules

    if ($Dev) {
        Assert-PortFree -Port $Port
        Assert-PortFree -Port $DevPort

        Write-Host "Starting backend on $Port (hidden)..." -ForegroundColor Cyan
        $env:PYTHONIOENCODING = 'utf-8'
        $backendProcess = Start-Process -FilePath $pythonPath `
            -ArgumentList '-m', 'uvicorn', 'app.main:app', '--port', "$Port" `
            -WorkingDirectory $backendDir -WindowStyle Hidden -PassThru

        try {
            if (-not (Wait-Health -Url "http://127.0.0.1:$Port")) {
                throw "Backend did not become ready on port $Port."
            }
            Write-Host 'Backend ready.' -ForegroundColor Green

            $url = "http://localhost:$DevPort"
            Write-Host "Dev server: $url  (Ctrl+C stops both)" -ForegroundColor Green
            Open-Browser -Url $url

            Push-Location $frontendDir
            try {
                npx webpack serve --mode development --port $DevPort
            } finally { Pop-Location }
        } finally {
            if ($backendProcess -and -not $backendProcess.HasExited) {
                Stop-Process -Id $backendProcess.Id -Force -ErrorAction SilentlyContinue
                Write-Host 'Backend stopped.' -ForegroundColor DarkGray
            }
        }
        return
    }

    Assert-PortFree -Port $Port
    Ensure-Build

    $prodUrl = "http://127.0.0.1:$Port"
    Write-Host "Serving on $prodUrl  (Ctrl+C to stop)" -ForegroundColor Green
    Open-Browser -Url $prodUrl

    Push-Location $backendDir
    try {
        $env:PYTHONIOENCODING = 'utf-8'
        & $pythonPath -m uvicorn app.main:app --port $Port
    } finally {
        Pop-Location
    }
} catch {
    # exit 1 instead of rethrowing: a rethrow prints the raw ErrorRecord
    # (file/line/stack), which buries the one line the user actually needs.
    Write-Host ''
    Write-Host "Startup failed: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host ''
    exit 1
}

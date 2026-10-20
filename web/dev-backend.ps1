# Start the backend (development mode, with auto-reload).
#
# Usage:
#   .\dev-backend.ps1
#   .\dev-backend.ps1 -Port 8010
#
# Notes:
# - Python 3.10.11 (final release) is required. 3.10.0a7 and other alpha
#   builds lack types.UnionType, which makes Uvicorn crash on import.
#   This script probes for that attribute before starting.
# - All messages are ASCII on purpose: Windows PowerShell 5.1 decodes .ps1
#   files using the system code page unless they carry a UTF-8 BOM.

param(
    [int]$Port = 8000,
    [string]$Python = ''
)

$ErrorActionPreference = 'Stop'
$backend = Join-Path $PSScriptRoot 'backend'

function Resolve-Python {
    param([string]$Explicit)

    if ($Explicit) {
        if (-not (Test-Path $Explicit)) { throw "Python not found: $Explicit" }
        return $Explicit
    }

    $candidates = @()
    $local = Join-Path $env:LOCALAPPDATA 'Programs\Python\Python310\python.exe'
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
            Write-Host "Skipping $candidate (version $version lacks types.UnionType; alpha/beta build?)" -ForegroundColor Yellow
        }
    }

    throw 'No usable Python 3.10.x found. Pass -Python <path> to point at one.'
}

$pythonPath = Resolve-Python -Explicit $Python
Write-Host "Using Python: $pythonPath" -ForegroundColor Cyan

$hasFastapi = & $pythonPath -c "import importlib.util,sys; sys.exit(0 if importlib.util.find_spec('fastapi') else 1)"
if ($LASTEXITCODE -ne 0) {
    Write-Host 'FastAPI not found. Installing dependencies...' -ForegroundColor Yellow
    Push-Location $backend
    try { & $pythonPath -m pip install -r requirements.txt } finally { Pop-Location }
}

Write-Host "Backend: http://127.0.0.1:$Port" -ForegroundColor Green
Write-Host 'Press Ctrl+C to stop.' -ForegroundColor DarkGray

Push-Location $backend
try {
    & $pythonPath -m uvicorn app.main:app --reload --port $Port
} finally {
    Pop-Location
}

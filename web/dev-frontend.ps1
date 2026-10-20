# Start the frontend dev server (webpack-dev-server, port 8080).
#
# Usage:
#   .\dev-frontend.ps1
#   .\dev-frontend.ps1 -Port 8081
#
# The backend must be running on port 8000 (see dev-backend.ps1);
# the dev server proxies /api to it.
#
# All messages are ASCII on purpose: Windows PowerShell 5.1 decodes .ps1
# files using the system code page unless they carry a UTF-8 BOM.

param(
    [int]$Port = 8080
)

$ErrorActionPreference = 'Stop'
$frontend = Join-Path $PSScriptRoot 'frontend'

Push-Location $frontend
try {
    if (-not (Test-Path 'node_modules')) {
        Write-Host 'First run: installing dependencies...' -ForegroundColor Yellow
        npm install --no-audit --no-fund
    }

    Write-Host "Frontend: http://localhost:$Port" -ForegroundColor Green
    Write-Host 'Press Ctrl+C to stop.' -ForegroundColor DarkGray
    npx webpack serve --mode development --port $Port
} finally {
    Pop-Location
}

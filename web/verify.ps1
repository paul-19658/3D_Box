# One-shot build + full verification.
#
# Steps:
#   1. Frontend: ESLint, Vitest, production build
#   2. Backend: pytest
#   3. Start a temporary backend on a spare port, run the end-to-end smoke
#      checks, then shut it down
#
# Usage:
#   .\verify.ps1
#   .\verify.ps1 -SkipSmoke      # static checks + unit tests only
#
# All messages are ASCII on purpose: Windows PowerShell 5.1 decodes .ps1
# files using the system code page unless they carry a UTF-8 BOM.

param(
    [switch]$SkipSmoke
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$failed = @()

function Step {
    param([string]$Name, [scriptblock]$Action)
    Write-Host ''
    Write-Host "==> $Name" -ForegroundColor Cyan
    # 先清零：$LASTEXITCODE 会跨命令残留，不重置的话上一步的失败会污染本步判定。
    $global:LASTEXITCODE = 0

    # 关键：判断成败只认退出码，不要理会 stderr 上的文字。
    # npm / npx 会把 "npm notice ..." 写到 stderr，而 PowerShell 5.1 会把它
    # 包装成 ErrorRecord。在 $ErrorActionPreference = 'Stop' 下，这些提示
    # 会直接变成终止性错误——只要输出被重定向（例如 .\verify.ps1 2>&1 | ...）
    # 整步就会被误判为失败。这里临时降级为 Continue，让真正的失败
    # 只通过 $LASTEXITCODE 暴露。
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $Action
    } catch {
        Write-Host "FAIL  $Name : $_" -ForegroundColor Red
        $script:failed += $Name
        $ErrorActionPreference = $previousPreference
        return
    } finally {
        $ErrorActionPreference = $previousPreference
    }

    if ($LASTEXITCODE -ne 0) {
        Write-Host "FAIL  $Name : exit code $LASTEXITCODE" -ForegroundColor Red
        $script:failed += $Name
    }
}

$local = Join-Path $env:LOCALAPPDATA 'Programs\Python\Python310\python.exe'
$pythonPath = if (Test-Path $local) { $local } else { 'python' }

Step 'frontend lint' {
    Push-Location (Join-Path $root 'frontend')
    try { npx eslint src --ext .js,.vue } finally { Pop-Location }
}

Step 'frontend unit tests' {
    Push-Location (Join-Path $root 'frontend')
    try { npx vitest run } finally { Pop-Location }
}

Step 'frontend production build' {
    Push-Location (Join-Path $root 'frontend')
    try { npx webpack --mode production } finally { Pop-Location }
}

Step 'backend unit tests' {
    Push-Location (Join-Path $root 'backend')
    try {
        $env:PYTHONIOENCODING = 'utf-8'
        & $pythonPath -m pytest -q
    } finally { Pop-Location }
}

if (-not $SkipSmoke) {
    Step 'end-to-end smoke' {
        $port = 8099
        $backend = Join-Path $root 'backend'
        $process = Start-Process -FilePath $pythonPath `
            -ArgumentList '-m', 'uvicorn', 'app.main:app', '--port', "$port" `
            -WorkingDirectory $backend -WindowStyle Hidden -PassThru

        try {
            # Poll for readiness (max 20s). A fixed sleep is flaky on slow machines.
            $ready = $false
            for ($i = 0; $i -lt 40; $i++) {
                Start-Sleep -Milliseconds 500
                try {
                    $response = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$port/api/health" -TimeoutSec 2
                    if ($response.StatusCode -eq 200) { $ready = $true; break }
                } catch { }
            }
            if (-not $ready) { throw "backend not ready within 20s (port $port)" }

            Push-Location $backend
            try {
                $env:PYTHONIOENCODING = 'utf-8'
                & $pythonPath -m app.smoke "http://127.0.0.1:$port"
                if ($LASTEXITCODE -ne 0) { throw 'smoke checks did not all pass' }
            } finally { Pop-Location }
        } finally {
            if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force }
        }
    }
}

Write-Host ''
if ($failed.Count -eq 0) {
    Write-Host 'All checks passed.' -ForegroundColor Green
    # 不显式 exit：正常返回时宿主退出码天然为 0，避免与 $LASTEXITCODE 语义纠缠。
} else {
    Write-Host ("Failed: " + ($failed -join ', ')) -ForegroundColor Red
    throw ("Verification failed: " + ($failed -join ', '))
}

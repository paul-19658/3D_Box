@echo off
rem One-click launcher: double-click this file to start the Xiaobaihe web app.
rem
rem Passes all arguments through to start.ps1, e.g.:
rem   start.cmd -Dev
rem   start.cmd -Port 8081
rem   start.cmd -Rebuild
rem
rem Runs in production mode by default: a single process serves both the API
rem and the built frontend, so there is nothing else to start.

setlocal
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
set EXITCODE=%ERRORLEVEL%

if not "%EXITCODE%"=="0" (
    echo.
    echo Startup failed with exit code %EXITCODE%.
    pause
)

endlocal & exit /b %EXITCODE%

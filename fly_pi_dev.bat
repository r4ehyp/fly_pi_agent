@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "POWERSHELL_EXE=powershell.exe"

where %POWERSHELL_EXE% >nul 2>nul
if errorlevel 1 (
	>&2 echo powershell.exe not found. Install PowerShell or run fly_pi_dev.ps1 directly.
	exit /b 1
)

%POWERSHELL_EXE% -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%fly_pi_dev.ps1" %*
exit /b %ERRORLEVEL%

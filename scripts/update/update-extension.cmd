@echo off
chcp 65001 >nul
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 20+ from https://nodejs.org and try again.
  pause
  exit /b 1
)
node "%~dp0update-extension.mjs" %*
set "ABL_UPDATE_EXIT=%ERRORLEVEL%"
if "%~1"=="" pause
exit /b %ABL_UPDATE_EXIT%

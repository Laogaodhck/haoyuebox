@echo off
rem Zunhong Toolbox - start local offline server and open the browser.
title Zunhong Toolbox (node/python server)
cd /d "%~dp0"

where node >nul 2>nul
if %errorlevel%==0 (
    start "" "http://localhost:8410/"
    node tools\server.js
    goto :end
)

where python >nul 2>nul
if %errorlevel%==0 (
    start "" "http://localhost:8410/"
    python -m http.server 8410
    goto :end
)

echo [ERROR] Node.js or Python is required to start the local server.
echo Please install Node.js from https://nodejs.org and try again.
pause

:end

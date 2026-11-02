@echo off
rem Windows: double-click to start. Serves this folder on http://localhost:8765 and opens the browser.
cd /d "%~dp0"
start "" "http://localhost:8765"
python tools\serve.py 8765
if errorlevel 1 py tools\serve.py 8765
pause

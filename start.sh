#!/bin/sh
# Linux: run ./start.sh — serves this folder on http://localhost:8765 and opens the browser.
cd "$(dirname "$0")" || exit 1
(sleep 1; xdg-open "http://localhost:8765" >/dev/null 2>&1) &
python3 tools/serve.py 8765

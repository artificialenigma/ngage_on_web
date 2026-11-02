#!/bin/bash
# macOS: double-click to start. Serves this folder on http://localhost:8765 and opens the browser.
cd "$(dirname "$0")" || exit 1
(sleep 1; open "http://localhost:8765") &
python3 tools/serve.py 8765

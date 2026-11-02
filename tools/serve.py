#!/usr/bin/env python3
"""Static dev server for port/web-emu with caching disabled (so edited JS modules always reload).

Usage: python3 port/web-emu/tools/serve.py [port]
"""
import functools
import http.server
import os
import sys


class NoCache(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm'}

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    handler = functools.partial(NoCache, directory=root)
    with http.server.ThreadingHTTPServer(('', port), handler) as httpd:
        print(f'serving {root} on http://localhost:{port}', flush=True)
        httpd.serve_forever()


if __name__ == '__main__':
    main()

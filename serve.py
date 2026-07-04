#!/usr/bin/env python3
"""Tiny local dev server that disables caching, so edits show up on refresh.
Usage:  python3 serve.py [port]   (default 8080, localhost only)
This file is only for local development — GitHub Pages ignores it."""
import http.server
import socketserver
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, *args):
        pass  # keep the terminal quiet


if __name__ == "__main__":
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("127.0.0.1", PORT), NoCacheHandler) as httpd:
        print(f"Serving http://localhost:{PORT}  (no-cache dev server)")
        httpd.serve_forever()

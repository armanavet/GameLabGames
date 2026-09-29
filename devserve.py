#!/usr/bin/env python3
"""Serve this folder for development with caching disabled.

    python devserve.py            # http://127.0.0.1:8011
    python devserve.py 9000       # another port

Plain `python -m http.server` lets the browser cache HTML/CSS/JS, so edits can
appear not to have landed — and an iframe is worse, because it can survive a
reload of the page around it. Production uses real cache headers; this is only
for local iteration.
"""
import http.server, functools, pathlib, sys

class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        super().end_headers()
    def log_message(self, fmt, *a):
        sys.stderr.write("  %s\n" % (fmt % a))

root = pathlib.Path(__file__).parent
port = int(sys.argv[1]) if len(sys.argv) > 1 else 8011
handler = functools.partial(NoCache, directory=str(root))
print("serving %s at http://127.0.0.1:%d  (no-store)\nCtrl-C to stop" % (root, port))
http.server.ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()

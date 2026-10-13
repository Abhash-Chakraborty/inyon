#!/usr/bin/env python3
"""A stand-in for the GitHub releases, for the container tests.

Serves a folder the way the installers and updaters read a release: each file under
/releases/latest/download/<name>, and /releases/latest answering with the redirect to
/releases/tag/v<version> that `inyon update` reads the newest version from. get.sh is served at
the root too, as the download page does.

    mock-release.py --dir <folder> --version 0.13.0 --port 8000
"""
import argparse
import http.server
import os
import sys


class Release(http.server.SimpleHTTPRequestHandler):
    version = ""

    def do_GET(self):
        if self.path.rstrip("/") == "/releases/latest":
            self.send_response(302)
            self.send_header("Location", f"http://{self.headers.get('Host', 'release')}/releases/tag/v{self.version}")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        prefix = "/releases/latest/download/"
        if self.path.startswith(prefix):
            self.path = "/" + self.path[len(prefix):]
        return super().do_GET()

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--dir", required=True)
    p.add_argument("--version", required=True)
    p.add_argument("--port", type=int, default=8000)
    a = p.parse_args()
    Release.version = a.version
    handler = lambda *args, **kw: Release(*args, directory=os.path.abspath(a.dir), **kw)
    http.server.ThreadingHTTPServer(("0.0.0.0", a.port), handler).serve_forever()


if __name__ == "__main__":
    main()

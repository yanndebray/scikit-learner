"""Serve the bundled static frontend on localhost."""
from __future__ import annotations

import argparse
import http.server
import socketserver
import webbrowser
from functools import partial
from importlib import resources
from pathlib import Path


def _resolve_static_dir() -> Path:
    # Installed wheel: frontend/ is mapped to scikit_learner/static/ via
    # hatchling's force-include (see pyproject.toml).
    bundled = Path(str(resources.files("scikit_learner"))) / "static"
    if bundled.is_dir():
        return bundled

    # Editable install (pip install -e .): force-include is a build-time
    # directive and doesn't apply, so resolve frontend/ from the source tree.
    source_fallback = Path(__file__).resolve().parent.parent / "frontend"
    if source_fallback.is_dir():
        return source_fallback

    raise RuntimeError(
        "Could not locate Scikit-Learner static assets. Looked for "
        f"{bundled} and {source_fallback}."
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="scikit-learner",
        description="Launch Scikit-Learner in your browser.",
    )
    parser.add_argument("--host", default="127.0.0.1", help="Host to bind (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8080, help="Port to serve on (default: 8080)")
    parser.add_argument("--no-browser", action="store_true", help="Do not open the browser automatically")
    args = parser.parse_args()

    static_dir = _resolve_static_dir()
    handler = partial(http.server.SimpleHTTPRequestHandler, directory=str(static_dir))

    with socketserver.TCPServer((args.host, args.port), handler) as httpd:
        url = f"http://{args.host}:{args.port}/"
        print(f"Scikit-Learner is running at {url} (Ctrl-C to stop)")
        print(f"Serving from: {static_dir}")
        if not args.no_browser:
            webbrowser.open(url)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down.")

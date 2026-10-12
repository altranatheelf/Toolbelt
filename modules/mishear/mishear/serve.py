"""`mishear serve`: the local engine behind the Toolbelt Mishear module.

Binds 127.0.0.1 only and refuses anything else. The module page is the
controls; this process does the listening on this computer and nothing leaves
it. Serves the page too, so http://127.0.0.1:8766/ works on its own.

API (JSON): GET /api/health · GET /api/ears?mode=&deep= · POST /api/upload?name=<file> (raw body)
· POST /api/listen {names, mode, deep, keep} -> {job} · GET /api/jobs/<id> · GET /api/sheets
· GET /api/sheets/<name>/sheet.md · GET /api/sheets/<name>/sidecar.json
"""

from __future__ import annotations

import json
import shutil
import threading
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from . import __version__
from .audio import BREW_COMMAND, sha256
from .config import load_config
from .run import AUDIO_SUFFIXES, grid, listen_source

JOBS: dict[str, dict] = {}
LISTENING = threading.Lock()  # one job at a time: the models are big
OUT = Path("sheets")
INBOX = Path("inbox")
SITE = "https://altranatheelf.github.io"  # the Toolbelt app
ORIGINS: set[str] = set()  # pages allowed to talk to this engine; filled by make_server
UI = Path(__file__).with_name("ui.html")
CHUNK = 1 << 20


def ffmpeg_missing() -> list[str]:
    return [tool for tool in ("ffmpeg", "ffprobe") if shutil.which(tool) is None]


def models_cached(sizes: list[str]) -> dict[str, bool]:
    from faster_whisper.utils import download_model

    cached = {}
    for size in sizes:
        try:
            download_model(size, local_files_only=True)
            cached[size] = True
        except Exception:  # noqa: BLE001 - not in the cache yet
            cached[size] = False
    return cached


def health() -> dict:
    import faster_whisper

    config = load_config()
    sizes = list(dict.fromkeys(config.models_default + config.models_quick + config.models_all + config.models_deep))
    return {
        "ok": True,
        "mishear": __version__,
        "faster_whisper": faster_whisper.__version__,
        "ffmpeg": not ffmpeg_missing(),
        "brew": BREW_COMMAND,
        "models": models_cached(sizes),
        "config": str(config.path),
        "languages": list(config.languages),
        "out": str(OUT.resolve()),
        "inbox": str(INBOX.resolve()),
    }


def safe_name(name: str) -> str | None:
    name = Path(name).name
    if not name or name.startswith(".") or name in ("..",):
        return None
    return name


def sheets() -> list[dict]:
    out = []
    if not OUT.exists():
        return out
    for sidecar_path in OUT.glob("*/sidecar.json"):
        try:
            sidecar = json.loads(sidecar_path.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            continue
        ears = sidecar.get("ears") or []
        out.append({
            "name": sidecar_path.parent.name,
            "source": (sidecar.get("source") or {}).get("name"),
            "duration": (sidecar.get("source") or {}).get("duration"),
            "timestamp": sidecar.get("timestamp"),
            "ears": len(ears),
            "lines": sum(int(e.get("lines") or 0) for e in ears),
            "lyrics": bool(sidecar.get("lyrics")),
        })
    out.sort(key=lambda s: s.get("timestamp") or "", reverse=True)
    return out


def run_job(job: dict, req: dict) -> None:
    def log(message: str) -> None:
        job["log"] += message + "\n"

    try:
        with LISTENING:
            config = load_config()
            mode = req.get("mode") or "default"
            ears = grid(config, mode if mode in ("quick", "default", "all") else "default", bool(req.get("deep")))
            job["ears"] = [e.label for e in ears]
            for name in job["names"]:
                source = INBOX / name
                log(f"— {name}: {len(ears)} ears")
                outdir = listen_source(source, ears, config, OUT, keep=bool(req.get("keep")), log=log)
                job["results"].append({
                    "name": name,
                    "sheet": outdir.name,
                    "markdown": (outdir / "sheet.md").read_text(encoding="utf-8"),
                })
                log(f"wrote {outdir / 'sheet.md'}")
        job["status"] = "done"
    except Exception:  # noqa: BLE001
        job["log"] += "\n" + traceback.format_exc()
        job["status"] = "error"


class Handler(BaseHTTPRequestHandler):
    def _local(self) -> bool:
        host = (self.headers.get("Host") or "").split(":")[0]
        return self.client_address[0] in ("127.0.0.1", "::1") and host in ("127.0.0.1", "localhost", "[::1]", "")

    def _origin_ok(self) -> bool:
        """No Origin (curl, same-origin page) or an allowed one. Any other website's tab is refused."""
        origin = self.headers.get("Origin")
        return origin is None or origin in ORIGINS

    def _cors(self) -> None:
        origin = self.headers.get("Origin")
        if origin in ORIGINS:  # only the Toolbelt app and the engine's own page may read answers
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Private-Network", "true")

    def _json(self, code: int, obj) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self._cors()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _text(self, body: bytes, content_type: str) -> None:
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self._cors()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):  # noqa: N802
        if not self._local() or not self._origin_ok():
            return self._json(403, {"error": "local only"})
        self.send_response(204)
        self._cors()
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()

    def do_GET(self):  # noqa: N802
        if not self._local():
            return self._json(403, {"error": "mishear serve answers 127.0.0.1 only"})
        if not self._origin_ok():
            return self._json(403, {"error": "this page is not allowed to use the engine"})
        url = urlparse(self.path)
        path = unquote(url.path)
        if path == "/api/health":
            return self._json(200, health())
        if path == "/api/ears":
            query = parse_qs(url.query)
            mode = (query.get("mode") or ["default"])[0]
            deep = (query.get("deep") or ["0"])[0] in ("1", "true", "yes")
            config = load_config()
            return self._json(200, [e.label for e in grid(config, mode if mode in ("quick", "default", "all") else "default", deep)])
        if path.startswith("/api/jobs/"):
            job = JOBS.get(path.rsplit("/", 1)[-1])
            return self._json(200 if job else 404, job or {"error": "no such job"})
        if path == "/api/sheets":
            return self._json(200, sheets())
        if path.startswith("/api/sheets/"):
            parts = path[len("/api/sheets/"):].split("/")
            if len(parts) == 2 and parts[1] in ("sheet.md", "sidecar.json") and safe_name(parts[0]) == parts[0]:
                file = OUT / parts[0] / parts[1]
                if file.is_file():
                    kind = "text/markdown; charset=utf-8" if parts[1].endswith(".md") else "application/json; charset=utf-8"
                    return self._text(file.read_bytes(), kind)
            return self._json(404, {"error": "not found"})
        if path in ("/", "/index.html", "/mishear.html"):
            body = UI.read_bytes() if UI.exists() else b"<p>ui.html missing: run from the Toolbelt checkout</p>"
            return self._text(body, "text/html; charset=utf-8")
        return self._json(404, {"error": "not found"})

    def do_POST(self):  # noqa: N802
        if not self._local():
            return self._json(403, {"error": "mishear serve answers 127.0.0.1 only"})
        if not self._origin_ok():
            return self._json(403, {"error": "this page is not allowed to use the engine"})
        url = urlparse(self.path)
        path = unquote(url.path)
        length = int(self.headers.get("Content-Length") or 0)
        if path == "/api/upload":
            name = safe_name((parse_qs(url.query).get("name") or [""])[0])
            if name is None:
                return self._json(400, {"error": "upload needs ?name=<file name>"})
            INBOX.mkdir(parents=True, exist_ok=True)
            dest = INBOX / name
            remaining = length
            with open(dest, "wb") as handle:
                while remaining > 0:
                    chunk = self.rfile.read(min(CHUNK, remaining))
                    if not chunk:
                        break
                    handle.write(chunk)
                    remaining -= len(chunk)
            return self._json(200, {"name": name, "path": str(dest.resolve()), "bytes": dest.stat().st_size, "sha256": sha256(dest)})
        try:
            req = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            return self._json(400, {"error": "bad json"})
        if path == "/api/listen":
            missing = ffmpeg_missing()
            if missing:
                return self._json(400, {"error": f"{' and '.join(missing)} missing on this computer. Install with: {BREW_COMMAND}"})
            names = [safe_name(n) for n in (req.get("names") or [])]
            names = [n for n in names if n and (INBOX / n).is_file() and Path(n).suffix.lower() in AUDIO_SUFFIXES]
            if not names:
                return self._json(400, {"error": "no uploaded audio files to listen to"})
            jid = uuid.uuid4().hex[:10]
            job = {"id": jid, "status": "running", "log": "", "names": names, "mode": req.get("mode") or "default",
                   "deep": bool(req.get("deep")), "keep": bool(req.get("keep")), "ears": [], "results": []}
            JOBS[jid] = job
            threading.Thread(target=run_job, args=(job, req), daemon=True).start()
            return self._json(202, {"job": jid})
        return self._json(404, {"error": "not found"})

    def log_message(self, fmt, *a):  # quiet
        pass


def make_server(port: int, out: Path, inbox: Path, origins: list[str] | None = None) -> ThreadingHTTPServer:
    global OUT, INBOX
    OUT = Path(out).expanduser()
    INBOX = Path(inbox).expanduser()
    OUT.mkdir(parents=True, exist_ok=True)
    INBOX.mkdir(parents=True, exist_ok=True)
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    bound = srv.server_address[1]
    ORIGINS.clear()
    ORIGINS.update({SITE, f"http://127.0.0.1:{bound}", f"http://localhost:{bound}", *(origins or [])})
    return srv


def serve(port: int = 8766, out: str = "sheets", inbox: str = "inbox", open_browser: bool = True, origins: list[str] | None = None) -> None:
    srv = make_server(port, Path(out), Path(inbox), origins)
    url = f"http://127.0.0.1:{port}/"
    print(f"mishear serve · {url} · sheets in {OUT.resolve()} · uploads in {INBOX.resolve()} · local only · Ctrl-C to stop")
    if open_browser:
        import webbrowser

        webbrowser.open(url)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass

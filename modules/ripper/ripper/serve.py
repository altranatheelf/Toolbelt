"""`ripper serve`: the local engine behind the Toolbelt Ripper module. Binds 127.0.0.1 only and
refuses anything else. Serves the module page too, so http://127.0.0.1:8765/ works on its own.

API (JSON): GET /api/health · POST /api/formats {url, cookies} · POST /api/rip {url, mode, bits,
rate, sections, handles, cookies, analyze} -> {job} · GET /api/jobs/<id> · GET /api/captures
"""
from __future__ import annotations

import json
import threading
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlparse

from . import __version__

JOBS: dict[str, dict] = {}
CAPTURES = Path("captures")
UI = Path(__file__).with_name("ui.html")


def _formats(req: dict) -> dict:
    from . import cli, select
    from .sources import find_better_sources, notice_lines
    args = SimpleNamespace(cookies_from_browser=req.get("cookies") or None, playlist=False)
    info = cli.extract(args, req["url"])
    ch = select.choose_audio(info.get("formats") or [])
    v = select.choose_video(info.get("formats") or [])
    rows = []
    for f in info.get("formats") or []:
        if not select.has_audio(f):
            continue
        rows.append({"id": f.get("format_id"), "codec": select.codec_family(f), "kbps": select.bitrate(f), "rate": f.get("asr"),
                     "ch": f.get("audio_channels"), "drc": select.is_drc(f), "ext": f.get("ext"), "note": f.get("format_note"),
                     "lang": f.get("language"), "muxed": not select.is_audio_only(f), "chosen": bool(ch and f.get("format_id") == ch.fmt.get("format_id"))})
    links = [info.get("uploader_url"), info.get("channel_url")]
    better = find_better_sources(info.get("description"), links)
    return {"title": info.get("title"), "uploader": info.get("uploader") or info.get("channel"), "id": info.get("id"), "extractor": info.get("extractor_key"),
            "license": info.get("license") or "not reported", "duration": info.get("duration"), "thumbnail": info.get("thumbnail"),
            "formats": rows, "why": ch.why if ch else [], "warnings": ch.warnings if ch else ["no audio streams"],
            "video": {"id": v.get("format_id"), "height": v.get("height"), "fps": v.get("fps"), "vcodec": v.get("vcodec")} if v else None,
            "better": notice_lines(better), "chapters": [{"title": c.get("title"), "start": c.get("start_time"), "end": c.get("end_time")} for c in (info.get("chapters") or [])]}


def _rip(job: dict, req: dict) -> None:
    import io
    import contextlib
    from . import cli
    args = SimpleNamespace(url=req["url"], mode=req.get("mode") or "native", out=str(CAPTURES), rate=req.get("rate") or None,
                           bits=str(req.get("bits") or "float"), section=req.get("sections") or None, handles=float(req.get("handles", 10)),
                           analyze=bool(req.get("analyze", True)), cookies_from_browser=req.get("cookies") or None, archive=None, playlist=False)
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            cli.cmd_rip(args)
        job.update(status="done", log=buf.getvalue())
    except SystemExit as e:
        job.update(status="error", log=buf.getvalue() + "\n" + str(e))
    except Exception:  # noqa: BLE001
        job.update(status="error", log=buf.getvalue() + "\n" + traceback.format_exc())


def _captures() -> list[dict]:
    out = []
    if not CAPTURES.exists():
        return out
    for j in sorted(CAPTURES.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            sc = json.loads(j.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            continue
        if "output" not in sc:
            continue
        out.append({"file": sc["output"].get("file"), "mode": sc["output"].get("mode"), "title": sc["source"].get("title"), "uploader": sc["source"].get("uploader"),
                    "license": sc["source"].get("license"), "url": sc["source"].get("url"), "retrieved": sc.get("retrieved_at_utc"), "format": sc["format"].get("chosen_id"),
                    "drc": sc["format"].get("drc"), "quality": sc.get("quality"), "warnings": sc.get("warnings"), "thumbnail": sc.get("thumbnail"), "sidecar": j.name})
    return out


class Handler(BaseHTTPRequestHandler):
    def _local(self) -> bool:
        host = (self.headers.get("Host") or "").split(":")[0]
        return self.client_address[0] in ("127.0.0.1", "::1") and host in ("127.0.0.1", "localhost", "[::1]", "")

    def _json(self, code: int, obj) -> None:
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")   # the Toolbelt page may be served from its own origin
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):  # noqa: N802
        if not self._local():
            return self._json(403, {"error": "local only"})
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.end_headers()

    def do_GET(self):  # noqa: N802
        if not self._local():
            return self._json(403, {"error": "ripper serve answers 127.0.0.1 only"})
        path = urlparse(self.path).path
        if path == "/api/health":
            import yt_dlp
            return self._json(200, {"ok": True, "ripper": __version__, "yt_dlp": yt_dlp.version.__version__, "captures": str(CAPTURES.resolve())})
        if path.startswith("/api/jobs/"):
            job = JOBS.get(path.rsplit("/", 1)[-1])
            return self._json(200 if job else 404, job or {"error": "no such job"})
        if path == "/api/captures":
            return self._json(200, _captures())
        if path.startswith("/captures/"):
            f = CAPTURES / Path(path[len("/captures/"):]).name
            if f.exists() and f.is_file():
                data = f.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "application/octet-stream" if f.suffix != ".jpg" else "image/jpeg")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                return self.wfile.write(data)
            return self._json(404, {"error": "not found"})
        if path in ("/", "/index.html", "/ripper.html"):
            body = UI.read_bytes() if UI.exists() else b"<p>ui.html missing: run from the Toolbelt checkout</p>"
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            return self.wfile.write(body)
        return self._json(404, {"error": "not found"})

    def do_POST(self):  # noqa: N802
        if not self._local():
            return self._json(403, {"error": "ripper serve answers 127.0.0.1 only"})
        n = int(self.headers.get("Content-Length") or 0)
        try:
            req = json.loads(self.rfile.read(n) or b"{}")
        except json.JSONDecodeError:
            return self._json(400, {"error": "bad json"})
        path = urlparse(self.path).path
        if path == "/api/formats":
            try:
                return self._json(200, _formats(req))
            except SystemExit as e:
                return self._json(400, {"error": str(e)})
        if path == "/api/rip":
            jid = uuid.uuid4().hex[:10]
            job = {"id": jid, "status": "running", "log": "", "url": req.get("url"), "mode": req.get("mode")}
            JOBS[jid] = job
            threading.Thread(target=_rip, args=(job, req), daemon=True).start()
            return self._json(202, {"job": jid})
        return self._json(404, {"error": "not found"})

    def log_message(self, fmt, *a):  # quiet
        pass


def serve(port: int = 8765, captures: str = "captures", open_browser: bool = True) -> None:
    global CAPTURES
    CAPTURES = Path(captures).expanduser()
    CAPTURES.mkdir(parents=True, exist_ok=True)
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    url = f"http://127.0.0.1:{port}/"
    print(f"ripper serve · {url} · captures in {CAPTURES.resolve()} · local only · Ctrl-C to stop")
    if open_browser:
        import webbrowser
        webbrowser.open(url)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass

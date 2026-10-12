"""The local engine: 127.0.0.1 only, uploads, a listening job, the sheet back."""

import json
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from mishear import serve as engine


@pytest.fixture
def server(tmp_path):
    srv = engine.make_server(0, tmp_path / "sheets", tmp_path / "inbox")
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    port = srv.server_address[1]
    yield f"http://127.0.0.1:{port}"
    srv.shutdown()


def get(url, headers=None):
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=120) as resp:
        return resp.status, resp.headers.get("Content-Type", ""), resp.read()


def post_json(url, body):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=120) as resp:
        return resp.status, json.loads(resp.read())


def upload(base, path: Path):
    req = urllib.request.Request(f"{base}/api/upload?name={path.name}", data=path.read_bytes(), headers={"Content-Type": "application/octet-stream"}, method="POST")
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read())


def test_health_and_ears(server):
    status, kind, body = get(server + "/api/health")
    health = json.loads(body)
    assert status == 200 and health["ok"] and health["mishear"] and health["faster_whisper"]
    assert health["ffmpeg"] is True and "models" in health and health["brew"] == "brew install ffmpeg"
    _, _, ears = get(server + "/api/ears?mode=quick")
    assert json.loads(ears) == ["clean · tiny · en", "wall · tiny · en", "sideways · tiny · en"]


def test_refuses_other_hosts(server):
    with pytest.raises(urllib.error.HTTPError) as exc:
        get(server + "/api/health", headers={"Host": "evil.example"})
    assert exc.value.code == 403


def test_serves_the_module_page(server):
    status, kind, body = get(server + "/")
    assert status == 200 and kind.startswith("text/html") and b"<title>Mishear</title>" in body


def test_upload_rejects_bad_names(server):
    for bad in ("", ".hidden", "..", "a/../b"):
        req = urllib.request.Request(f"{server}/api/upload?name={bad}", data=b"x", method="POST")
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                result = json.loads(resp.read())
                assert bad == "a/../b" and result["name"] == "b"  # only the base name is kept
        except urllib.error.HTTPError as err:
            assert err.code == 400


def test_upload_listen_and_fetch_sheet(server, standin, tmp_path):
    up = upload(server, standin)
    assert up["name"] == "standin.wav" and up["bytes"] == standin.stat().st_size
    assert (tmp_path / "inbox" / "standin.wav").read_bytes() == standin.read_bytes()
    upload(server, standin.with_suffix(".txt"))
    status, job = post_json(server + "/api/listen", {"names": ["standin.wav"], "mode": "quick", "keep": True})
    assert status == 202 and job["job"]
    deadline = time.time() + 180
    while True:
        _, _, body = get(f"{server}/api/jobs/{job['job']}")
        state = json.loads(body)
        if state["status"] != "running" or time.time() > deadline:
            break
        time.sleep(1)
    assert state["status"] == "done", state["log"]
    assert state["ears"] == ["clean · tiny · en", "wall · tiny · en", "sideways · tiny · en"]
    result = state["results"][0]
    assert result["sheet"] == "standin" and "## Dissent" in result["markdown"] and "| time | real line |" in result["markdown"]
    assert (tmp_path / "sheets" / "standin" / "degraded" / "wall.wav").exists()
    _, _, listing = get(server + "/api/sheets")
    sheets = json.loads(listing)
    assert sheets[0]["name"] == "standin" and sheets[0]["ears"] == 3 and sheets[0]["lyrics"] is True
    _, kind, md = get(server + "/api/sheets/standin/sheet.md")
    assert kind.startswith("text/markdown") and md.decode("utf-8") == result["markdown"]
    _, kind, sidecar = get(server + "/api/sheets/standin/sidecar.json")
    assert json.loads(sidecar)["source"]["name"] == "standin.wav"
    with pytest.raises(urllib.error.HTTPError) as exc:
        get(server + "/api/sheets/../sheet.md")
    assert exc.value.code == 404


def test_listen_needs_an_uploaded_audio_file(server):
    with pytest.raises(urllib.error.HTTPError) as exc:
        post_json(server + "/api/listen", {"names": ["nothing.wav"], "mode": "quick"})
    assert exc.value.code == 400

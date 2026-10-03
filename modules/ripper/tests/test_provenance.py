import json
from pathlib import Path

import pytest

from ripper import provenance as P

SCHEMA = json.loads((Path(__file__).parent.parent / "schema" / "sidecar.schema.json").read_text())


def test_slug_and_name():
    assert P.slug("Café del Mar — Live!! (2024)") == "cafe-del-mar-live-2024"
    assert P.capture_name("20240912", "Blender Foundation", "Big Buck Bunny", "aqz-KE-bpKQ") == "2024-09-12_blender-foundation_big-buck-bunny_aqz-ke-bpkq"
    assert P.capture_name(None, None, None, None).startswith("undated_unknown_untitled_noid")


def fake_info():
    return {"webpage_url": "https://example.org/v/abc", "extractor_key": "Example", "id": "abc", "title": "T", "uploader": "U",
            "channel_id": "C", "upload_date": "20240101", "duration": 12.5, "license": "Creative Commons Attribution license (reuse allowed)",
            "description": "hello", "tags": ["a"]}


def test_sidecar_roundtrip_and_verify(tmp_path):
    media = tmp_path / "2024-01-01_u_t_abc.opus"
    media.write_bytes(b"\x00\x01\x02" * 1000)
    chosen = {"format_id": "251", "acodec": "opus", "abr": 160.0, "asr": 48000, "audio_channels": 2, "ext": "webm", "protocol": "https", "_drc": False, "language": "en", "format_note": "medium"}
    sc = P.build_sidecar(info=fake_info(), output=media, chosen=chosen, selection_reason=["audio-only", "not DRC", "opus over aac"], mode="native",
                         tool_version="0.1.0", ytdlp_version="2026.08.19", quality=None, processing={"normalized": False}, sections=None,
                         better_sources=[{"kind": "bandcamp", "url": "https://x.bandcamp.com/album/y", "note": "likely lossless"}], thumbnail=None, warnings=[])
    j, t = P.write_sidecars(sc, media)
    assert j.exists() and t.exists()
    txt = t.read_text()
    assert "LICENSE (as the source reports it): Creative Commons" in txt and "DRC: no" in txt and "bandcamp" in txt
    # schema: required keys and shapes (a tiny validator so the test needs no extra dependency)
    def check(obj, sch, path="$"):
        if "const" in sch:
            assert obj == sch["const"], path
        t = sch.get("type")
        if t:
            types = t if isinstance(t, list) else [t]
            ok = {"object": dict, "array": list, "string": str, "number": (int, float), "integer": int, "boolean": bool, "null": type(None)}
            assert any(isinstance(obj, ok[x]) and not (x == "integer" and isinstance(obj, bool)) for x in types), f"{path}: {type(obj)} not {types}"
        if "enum" in sch:
            assert obj in sch["enum"], path
        if isinstance(obj, dict):
            for r in sch.get("required", []):
                assert r in obj, f"{path}.{r} missing"
            for k, v in sch.get("properties", {}).items():
                if k in obj:
                    check(obj[k], v, f"{path}.{k}")
        if isinstance(obj, list) and "items" in sch:
            for i, it in enumerate(obj):
                check(it, sch["items"], f"{path}[{i}]")
    check(json.loads(j.read_text()), SCHEMA)
    assert P.verify_folder(tmp_path)[0]["status"] == "ok"
    media.write_bytes(b"changed")
    assert P.verify_folder(tmp_path)[0]["status"] == "changed"

"""Provenance: the sidecar files written next to every capture, the filename rule, hashing and verify.

<name>.json is the machine record (validated against schema/sidecar.schema.json),
<name>.txt the same facts for a person. Nothing in here touches the audio.
"""
from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

SIDECAR_VERSION = 1


def sha256_file(path: Path, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            b = f.read(chunk)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def slug(text: str, max_len: int = 60) -> str:
    """ASCII, lowercase, hyphen-separated; safe on every filesystem."""
    text = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode()
    text = re.sub(r"[^A-Za-z0-9]+", "-", text).strip("-").lower()
    text = re.sub(r"-{2,}", "-", text)
    return text[:max_len].rstrip("-") or "untitled"


def capture_name(upload_date: str | None, uploader: str | None, title: str | None, video_id: str | None) -> str:
    """YYYY-MM-DD_<uploader>_<title>_<videoID>, slugified per part. Unknown date -> 'undated'."""
    d = "undated"
    if upload_date and re.fullmatch(r"\d{8}", upload_date):
        d = f"{upload_date[:4]}-{upload_date[4:6]}-{upload_date[6:]}"
    parts = [d, slug(uploader or "unknown", 40), slug(title or "untitled", 60), slug(video_id or "noid", 40)]
    return "_".join(parts)


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def build_sidecar(*, info: dict, output: Path, chosen: dict, selection_reason: list[str],
                  mode: str, tool_version: str, ytdlp_version: str, quality: dict | None,
                  processing: dict, sections: list[dict] | None, better_sources: list[dict],
                  thumbnail: str | None, warnings: list[str]) -> dict:
    """Assemble the JSON sidecar. `info` is the yt-dlp info dict (already extracted)."""
    license_text = info.get("license") or "not reported by the source"
    return {
        "sidecar_version": SIDECAR_VERSION,
        "tool": {"name": "toolbelt-ripper", "version": tool_version, "yt_dlp": ytdlp_version},
        "retrieved_at_utc": utc_now(),
        "source": {
            "url": info.get("webpage_url") or info.get("original_url"),
            "extractor": info.get("extractor_key") or info.get("extractor"),
            "id": info.get("id"),
            "title": info.get("title"),
            "uploader": info.get("uploader") or info.get("channel"),
            "uploader_id": info.get("uploader_id"),
            "channel_id": info.get("channel_id"),
            "upload_date": info.get("upload_date"),
            "duration_s": info.get("duration"),
            "license": license_text,
            "description": info.get("description"),
            "tags": info.get("tags") or [],
        },
        "format": {
            "chosen_id": chosen.get("format_id"),
            "codec": chosen.get("acodec"),
            "bitrate_kbps": chosen.get("abr") or chosen.get("tbr"),
            "sample_rate": chosen.get("asr"),
            "channels": chosen.get("audio_channels"),
            "container": chosen.get("ext"),
            "protocol": chosen.get("protocol"),
            "drc": bool(chosen.get("_drc")),
            "language": chosen.get("language"),
            "note": chosen.get("format_note"),
            "why": selection_reason,
        },
        "output": {
            "file": output.name,
            "mode": mode,
            "sha256": sha256_file(output) if output.exists() else None,
            "bytes": output.stat().st_size if output.exists() else None,
        },
        "processing": processing,
        "sections": sections or [],
        "quality": quality,
        "better_sources": better_sources,
        "thumbnail": thumbnail,
        "warnings": warnings,
    }


def sidecar_text(sc: dict) -> str:
    s, f, o, q = sc["source"], sc["format"], sc["output"], sc.get("quality") or {}
    lines = [
        f"{s.get('title')}",
        f"by {s.get('uploader')}  ·  uploaded {s.get('upload_date')}  ·  {s.get('extractor')} id {s.get('id')}",
        f"source: {s.get('url')}",
        f"LICENSE (as the source reports it): {s.get('license')}",
        "",
        f"captured {sc['retrieved_at_utc']} with {sc['tool']['name']} {sc['tool']['version']} (yt-dlp {sc['tool']['yt_dlp']})",
        f"output: {o.get('file')}  ·  mode {o.get('mode')}  ·  {o.get('bytes')} bytes  ·  sha256 {o.get('sha256')}",
        "",
        f"chosen stream: {f.get('chosen_id')}  {f.get('codec')} {f.get('bitrate_kbps')} kbps {f.get('sample_rate')} Hz "
        f"{f.get('channels')} ch  container {f.get('container')}  DRC: {'YES' if f.get('drc') else 'no'}",
    ]
    lines += [f"  why: {w}" for w in f.get("why") or []]
    p = sc.get("processing") or {}
    if p:
        lines += ["", "processing: " + ", ".join(f"{k}={v}" for k, v in p.items() if v not in (None, False, [], ""))]
    if sc.get("sections"):
        lines += ["", "sections:"] + [f"  {x.get('start')} - {x.get('end')}  (handles {x.get('handles_ms')} ms)" for x in sc["sections"]]
    if q:
        lines += ["", "quality report:",
                  f"  integrated {q.get('integrated_lufs')} LUFS  ·  range {q.get('loudness_range_lu')} LU  ·  true peak {q.get('true_peak_dbtp')} dBTP",
                  f"  sample peak {q.get('sample_peak_dbfs')} dBFS  ·  samples over 0 dBFS: {q.get('samples_over_0dbfs')}",
                  f"  bandwidth ~{q.get('bandwidth_hz')} Hz: {q.get('bandwidth_note')}",
                  f"  stereo: {q.get('stereo_note')} (side/mid {q.get('side_to_mid_db')} dB)"]
    if sc.get("better_sources"):
        lines += ["", "better sources found in the description / links:"] + [f"  {b.get('kind')}: {b.get('url')}  — {b.get('note')}" for b in sc["better_sources"]]
    if sc.get("warnings"):
        lines += ["", "warnings:"] + [f"  ! {w}" for w in sc["warnings"]]
    if s.get("description"):
        lines += ["", "description:", s["description"]]
    return "\n".join(lines) + "\n"


def write_sidecars(sc: dict, output: Path) -> tuple[Path, Path]:
    j = output.with_suffix(".json")
    t = output.with_suffix(".txt")
    j.write_text(json.dumps(sc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    t.write_text(sidecar_text(sc), encoding="utf-8")
    return j, t


def verify_folder(folder: Path) -> list[dict]:
    """Re-hash every media file that has a .json sidecar. Returns one result per sidecar."""
    results = []
    for j in sorted(folder.glob("*.json")):
        try:
            sc = json.loads(j.read_text(encoding="utf-8"))
        except Exception as e:  # noqa: BLE001
            results.append({"sidecar": j.name, "status": "unreadable", "detail": str(e)})
            continue
        if sc.get("sidecar_version") is None or "output" not in sc:
            continue
        media = folder / (sc["output"].get("file") or "")
        if not media.exists():
            results.append({"sidecar": j.name, "status": "missing", "detail": f"{media.name} not found"})
            continue
        have = sha256_file(media)
        want = sc["output"].get("sha256")
        results.append({"sidecar": j.name, "status": "ok" if have == want else "changed",
                        "detail": media.name if have == want else f"{media.name}: sha256 differs"})
    return results

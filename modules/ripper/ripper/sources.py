"""Better-source check: scan a description and the uploader's links for places that may hold a
higher-fidelity copy (Bandcamp, SoundCloud, Internet Archive). Surfaced only, never acted on."""
from __future__ import annotations

import re

URL_RE = re.compile(r"https?://[^\s<>()\"']+", re.I)

KINDS = (
    ("bandcamp", re.compile(r"(^|\.)bandcamp\.com$", re.I), "Bandcamp sells lossless (FLAC/WAV) downloads; the artist's own upload"),
    ("soundcloud", re.compile(r"(^|\.)soundcloud\.com$", re.I), "SoundCloud: the uploader may allow downloading the original file"),
    ("internet_archive", re.compile(r"(^|\.)archive\.org$", re.I), "Internet Archive items often keep the original upload (FLAC/WAV) next to derivatives"),
)


def _host(url: str) -> str:
    m = re.match(r"https?://([^/]+)", url, re.I)
    return (m.group(1) if m else "").lower().split(":")[0]


def find_better_sources(description: str | None, links: list[str] | None = None) -> list[dict]:
    """Return [{kind, url, note}] for every distinct Bandcamp/SoundCloud/Internet Archive URL."""
    text = description or ""
    urls = URL_RE.findall(text) + [u for u in (links or []) if u]
    out, seen = [], set()
    for u in urls:
        u = u.rstrip(".,;:!?)")
        host = _host(u)
        for kind, pat, note in KINDS:
            if pat.search(host) and u not in seen:
                seen.add(u)
                out.append({"kind": kind, "url": u, "note": note})
    return out


def notice_lines(found: list[dict]) -> list[str]:
    """Plain sentences for the console and the sidecar."""
    lines = []
    for b in found:
        if b["kind"] == "bandcamp":
            lines.append(f"This exists on Bandcamp, which likely offers lossless: {b['url']}")
        elif b["kind"] == "soundcloud":
            lines.append(f"This is on SoundCloud; the original file may be downloadable if the uploader allows it: {b['url']}")
        else:
            lines.append(f"This is on the Internet Archive; check the item for original FLAC/WAV files: {b['url']}")
    return lines

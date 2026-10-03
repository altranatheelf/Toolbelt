"""Stream selection. "Best" means highest fidelity to the original master, not the biggest number.

Rules, in order (each one is logged as the reason the winner won):
1. audio-only streams over muxed streams
2. never DRC (dynamic-range-compressed variants) unless nothing else exists, and say so loudly
3. the original language track over auto-dubbed tracks
4. Opus over AAC at comparable bitrates (YouTube's Opus ~160k beats its AAC 128k)
5. higher bitrate within a codec (Premium ~256k Opus wins when cookies expose it)
6. tie-break: lossless/original uploads (Internet Archive 'original', SoundCloud original) first
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

CODEC_RANK = {"flac": 100, "alac": 100, "pcm": 100, "wav": 100, "opus": 60, "vorbis": 50, "aac": 40, "mp4a": 40, "mp3": 30}


@dataclass
class Choice:
    fmt: dict
    why: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


AUDIO_EXTS = ("mp3", "flac", "ogg", "oga", "opus", "m4a", "wav", "aiff", "aif", "alac", "wma", "aac")


def is_audio_only(f: dict) -> bool:
    # extractors like Internet Archive report acodec None for files they did not probe: judge by extension then
    if f.get("vcodec") not in (None, "none"):
        return False
    if f.get("acodec") not in (None, "none"):
        return True
    return str(f.get("ext") or "").lower() in AUDIO_EXTS


def has_audio(f: dict) -> bool:
    if f.get("acodec") == "none":
        return False
    if f.get("acodec"):
        return True
    return str(f.get("ext") or "").lower() in AUDIO_EXTS or f.get("vcodec") in (None, "none") and bool(f.get("ext"))


def is_drc(f: dict) -> bool:
    fid = str(f.get("format_id") or "").lower()
    note = str(f.get("format_note") or "").lower()
    return fid.endswith("-drc") or "-drc-" in fid or "drc" in note.split()


def is_dubbed(f: dict) -> bool:
    note = str(f.get("format_note") or "").lower()
    if "dubbed" in note or "auto-dub" in note:
        return True
    lp = f.get("language_preference")
    return isinstance(lp, (int, float)) and lp < 0


def is_original_track(f: dict) -> bool:
    note = str(f.get("format_note") or "").lower()
    lp = f.get("language_preference")
    return "original" in note or (isinstance(lp, (int, float)) and lp >= 10)


def codec_family(f: dict) -> str:
    a = str(f.get("acodec") or "").lower()
    for k in CODEC_RANK:
        if a.startswith(k):
            return "aac" if k == "mp4a" else k
    if not a:
        ext = str(f.get("ext") or "").lower()
        return {"mp3": "mp3", "flac": "flac", "wav": "pcm", "aiff": "pcm", "aif": "pcm", "opus": "opus", "ogg": "vorbis", "oga": "vorbis", "m4a": "aac"}.get(ext, "unknown")
    return a


def is_lossless_original(f: dict) -> bool:
    note = str(f.get("format_note") or "").lower()
    fid = str(f.get("format_id") or "").lower()
    return codec_family(f) in ("flac", "alac", "pcm", "wav") or note == "original" or fid in ("download", "original")


def bitrate(f: dict) -> float:
    return float(f.get("abr") or f.get("tbr") or 0)


def describe(f: dict) -> str:
    return (f"{f.get('format_id')}: {codec_family(f)} {bitrate(f):.0f} kbps {f.get('asr') or '?'} Hz "
            f"{f.get('audio_channels') or '?'} ch {f.get('ext')} {('DRC ' if is_drc(f) else '')}{(f.get('format_note') or '')}".strip())


def choose_audio(formats: list[dict]) -> Choice | None:
    cands = [f for f in formats if has_audio(f)]
    if not cands:
        return None
    why: list[str] = []
    warnings: list[str] = []
    audio_only = [f for f in cands if is_audio_only(f)]
    if audio_only:
        cands = audio_only
        why.append("audio-only stream (no muxed video)")
    else:
        warnings.append("no audio-only stream exists; taking the audio track of a muxed file")
    non_drc = [f for f in cands if not is_drc(f)]
    if non_drc:
        cands = non_drc
        why.append("not a DRC (dynamic-range-compressed) variant")
    else:
        warnings.append("ONLY DRC (dynamic-range-compressed) audio is offered for this item: the capture is NOT the original dynamics")
    originals = [f for f in cands if not is_dubbed(f)]
    if originals and len(originals) < len(cands):
        cands = originals
        why.append("original language track, not an auto-dub")
    langs = {f.get("language") for f in cands if f.get("language")}
    orig_pref = [f for f in cands if is_original_track(f)]
    if len(langs) > 1 and orig_pref and len(orig_pref) < len(cands):
        cands = orig_pref
        why.append("the track marked original")

    def key(f: dict):
        lossless = 1 if is_lossless_original(f) else 0
        fam = codec_family(f)
        rank = CODEC_RANK.get(fam, 0)
        br = bitrate(f)
        # Opus over AAC at comparable bitrate: treat AAC as needing ~1.3x the bitrate to match
        eff = br * (1.0 if fam == "opus" else 0.75 if fam in ("aac", "mp3") else 0.9 if fam == "vorbis" else 1.0)
        return (lossless, eff if not lossless else 1e9, rank, br, int(f.get("asr") or 0))

    cands.sort(key=key, reverse=True)
    best = cands[0]
    if is_lossless_original(best):
        why.append("an original/lossless upload is available: it wins outright")
    else:
        fam = codec_family(best)
        others = [f for f in cands[1:] if codec_family(f) != fam]
        if fam == "opus" and any(codec_family(f) == "aac" for f in others):
            why.append(f"Opus {bitrate(best):.0f} kbps over AAC {max(bitrate(f) for f in others if codec_family(f) == 'aac'):.0f} kbps (Opus is the more efficient codec at comparable bitrates)")
        same = [f for f in cands[1:] if codec_family(f) == fam]
        if same:
            why.append(f"highest bitrate within {fam}: {bitrate(best):.0f} kbps (next {bitrate(same[0]):.0f})")
        if bitrate(best) >= 200 and fam in ("opus", "aac"):
            why.append("a Premium-tier (~256 kbps) stream is present and chosen")
    return Choice(fmt=best, why=why, warnings=warnings)


def choose_video(formats: list[dict]) -> dict | None:
    vids = [f for f in formats if f.get("vcodec") not in (None, "none") and f.get("acodec") in (None, "none")]
    if not vids:
        vids = [f for f in formats if f.get("vcodec") not in (None, "none")]
    if not vids:
        return None
    def eff(f):
        v = str(f.get("vcodec") or "").lower()
        return 3 if v.startswith("av01") else 2 if v.startswith("vp09") or v.startswith("vp9") else 1 if v.startswith("avc") else 0
    def hdr(f):
        return 1 if str(f.get("dynamic_range") or "").upper() in ("HDR", "HDR10", "HLG", "DV") else 0
    vids.sort(key=lambda f: (f.get("height") or 0, f.get("fps") or 0, hdr(f), eff(f), f.get("tbr") or 0), reverse=True)
    return vids[0]


def format_table(formats: list[dict], chosen_id: str | None) -> str:
    rows = [f for f in formats if has_audio(f)]
    rows.sort(key=lambda f: (not is_audio_only(f), -bitrate(f)))
    head = f"{'':2} {'id':>14} {'codec':<8} {'kbps':>6} {'rate':>6} {'ch':>3} {'DRC':<3} {'ext':<5} note"
    out = [head, "-" * len(head)]
    for f in rows:
        mark = "->" if f.get("format_id") == chosen_id else "  "
        out.append(f"{mark} {str(f.get('format_id')):>14} {codec_family(f):<8} {bitrate(f):>6.0f} {str(f.get('asr') or '?'):>6} "
                   f"{str(f.get('audio_channels') or '?'):>3} {'yes' if is_drc(f) else '':<3} {str(f.get('ext')):<5} "
                   f"{'muxed ' if not is_audio_only(f) else ''}{f.get('format_note') or ''}{(' lang=' + str(f.get('language'))) if f.get('language') else ''}")
    return "\n".join(out)

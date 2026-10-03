"""Decoding and conversion for the DAW. Rules:

* native: the chosen stream as it is, remuxed only when the container needs it. No decode.
* wav/flac: decode once to 32-bit float at the source sample rate. Never resample unless --rate
  is set; then soxr at its highest precision (28-bit), noted in the sidecar.
* Float output keeps inter-sample overs a lossy decoder can produce. --bits 24 warns when the
  decoded audio exceeds 0 dBFS (integer output clips it). --bits 16 adds TPDF dither, noted.
* No normalisation, limiting or loudness processing, ever, unless explicitly requested.
* mp3: LAME V0, lossy-to-lossy, only on request.
* Sections: cut on the decoded audio with sample-accurate boundaries plus handles, never
  keyframe-snapped stream copies.
"""
from __future__ import annotations

import math
import subprocess
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .analysis import decode_float, peaks, probe
from .tools import ffmpeg_path


@dataclass
class ConvertResult:
    output: Path
    processing: dict
    warnings: list[str]
    decoded_peak_dbfs: float | None
    overs: int


def _resample_args(src_rate: int, rate: int | None) -> tuple[list[str], dict | None]:
    if not rate or rate == src_rate:
        return [], None
    # soxr, highest precision; the default "-ar" path would use swresample's lower quality
    return ["-af", f"aresample=resampler=soxr:precision=28:osr={rate}"], {"from": src_rate, "to": rate, "method": "soxr precision 28"}


def _codec_args(mode: str, bits: int | str) -> tuple[list[str], str]:
    if mode == "wav":
        if bits == "float":
            return ["-c:a", "pcm_f32le"], "float32"
        if bits == 24:
            return ["-c:a", "pcm_s24le"], "24"
        if bits == 16:
            return ["-c:a", "pcm_s16le"], "16"
    if mode == "flac":
        # FLAC holds integer PCM only: float means 24-bit here (noted), with the same peak check
        if bits in ("float", 24):
            return ["-c:a", "flac", "-sample_fmt", "s32", "-compression_level", "8"], "24"
        if bits == 16:
            return ["-c:a", "flac", "-sample_fmt", "s16", "-compression_level", "8"], "16"
    if mode == "mp3":
        return ["-c:a", "libmp3lame", "-q:a", "0"], "lossy"
    raise ValueError(f"unsupported mode/bits: {mode}/{bits}")


def convert(src: Path, out: Path, mode: str, *, bits: int | str = "float", rate: int | None = None,
            sections: list[tuple[float, float]] | None = None, handles_ms: float = 10.0,
            decoded: np.ndarray | None = None, src_rate: int | None = None) -> ConvertResult:
    """Decode `src` into `out` per the rules above. `sections` is a list of (start, end) seconds;
    when given, the output is the concatenation of those ranges plus handles on each side."""
    warnings: list[str] = []
    facts = probe(src)
    sr = src_rate or facts.sample_rate or 48000
    if decoded is None:
        decoded, sr = decode_float(src)
    peak_db, overs = peaks(decoded)
    processing: dict = {"normalized": False, "source_sample_rate": sr}
    codec_args, bits_label = _codec_args(mode, bits)
    processing["bits"] = bits_label
    if bits_label in ("24", "16") and overs > 0:
        warnings.append(f"decoded audio exceeds 0 dBFS ({overs} samples, peak {peak_db:.2f} dBFS): {bits_label}-bit output clips them; use float")
        processing["clipped_on_output"] = True
    else:
        processing["clipped_on_output"] = False if bits_label != "float" else None
    if mode == "mp3":
        warnings.append("mp3 is a lossy-to-lossy conversion of an already lossy stream")
    filters: list[str] = []
    rs_args, rs_note = _resample_args(sr, rate)
    processing["resampled"] = rs_note
    if rs_args:
        filters.append(rs_args[1])
    if bits_label == "16":
        # TPDF dither at the final word length: ffmpeg's aresample does the quantisation with dither
        filters.append("aresample=dither_method=triangular")
        processing["dither"] = "TPDF (triangular), 16-bit"
    else:
        processing["dither"] = None
    cmd = [ffmpeg_path(), "-v", "error", "-y"]
    if sections:
        # cut on decoded samples: feed float PCM from memory so boundaries are exact to the sample
        h = int(round(handles_ms / 1000 * sr))
        pieces = []
        n = len(decoded)
        for (a, b) in sections:
            i0 = max(0, int(round(a * sr)) - h)
            i1 = min(n, int(round(b * sr)) + h)
            pieces.append(decoded[i0:i1])
        cut = np.concatenate(pieces) if pieces else decoded[:0]
        ch = cut.shape[1] if cut.ndim == 2 else 1
        cmd += ["-f", "f32le", "-ar", str(sr), "-ac", str(ch), "-i", "-"]
        stdin = cut.astype(np.float32).tobytes()
        processing["sections"] = [{"start": a, "end": b, "handles_ms": handles_ms} for (a, b) in sections]
    else:
        cmd += ["-i", str(src)]
        stdin = None
    if filters:
        cmd += ["-af", ",".join(filters)]
    cmd += ["-map_metadata", "-1", "-vn"] + codec_args + [str(out)]
    subprocess.run(cmd, input=stdin, check=True, capture_output=True)
    return ConvertResult(output=out, processing=processing, warnings=warnings, decoded_peak_dbfs=peak_db, overs=overs)


def parse_section(text: str) -> tuple[float, float]:
    """'1:23-2:10', '83-130', '0:01:23.5-0:02:10' -> (83.0, 130.0)."""
    def t(s: str) -> float:
        parts = [float(p) for p in s.strip().split(":")]
        v = 0.0
        for p in parts:
            v = v * 60 + p
        return v
    a, b = text.split("-", 1)
    s, e = t(a), t(b)
    if e <= s:
        raise ValueError(f"section end must be after start: {text}")
    return s, e

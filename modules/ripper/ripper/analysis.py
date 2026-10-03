"""Quality report for a decoded capture. Nothing here changes audio; it only measures.

Measurements are made on the decoded signal as 32-bit float at the source sample rate:
loudness (EBU R128 via ffmpeg's ebur128 filter), true peak, sample peak, samples over 0 dBFS,
effective bandwidth (where spectral energy drops off), and near-mono detection (L-R energy).
"""
from __future__ import annotations

import json
import math
import re
import subprocess
from dataclasses import dataclass, asdict
from pathlib import Path

import numpy as np

from .tools import ffmpeg_path, ffprobe_path


@dataclass
class StreamFacts:
    codec: str | None
    bitrate_kbps: float | None
    sample_rate: int | None
    channels: int | None
    channel_layout: str | None
    duration_s: float | None
    container: str | None


@dataclass
class QualityReport:
    integrated_lufs: float | None
    loudness_range_lu: float | None
    true_peak_dbtp: float | None
    sample_peak_dbfs: float | None
    samples_over_0dbfs: int
    bandwidth_hz: int | None
    bandwidth_note: str
    near_mono: bool
    side_to_mid_db: float | None
    stereo_note: str


def probe(path: Path) -> StreamFacts:
    """ffprobe the first audio stream."""
    out = subprocess.run(
        [ffprobe_path(), "-v", "error", "-select_streams", "a:0", "-show_entries",
         "stream=codec_name,bit_rate,sample_rate,channels,channel_layout,duration:format=format_name,bit_rate,duration",
         "-of", "json", str(path)], capture_output=True, text=True, check=True).stdout
    d = json.loads(out)
    st = (d.get("streams") or [{}])[0]
    fmt = d.get("format") or {}
    br = st.get("bit_rate") or fmt.get("bit_rate")
    dur = st.get("duration") or fmt.get("duration")
    return StreamFacts(
        codec=st.get("codec_name"),
        bitrate_kbps=round(int(br) / 1000, 1) if br else None,
        sample_rate=int(st["sample_rate"]) if st.get("sample_rate") else None,
        channels=st.get("channels"),
        channel_layout=st.get("channel_layout"),
        duration_s=float(dur) if dur else None,
        container=fmt.get("format_name"),
    )


def decode_float(path: Path, max_seconds: float | None = None) -> tuple[np.ndarray, int]:
    """Decode to float32 planar-by-column array (frames x channels) at the source rate."""
    facts = probe(path)
    sr = facts.sample_rate or 48000
    ch = facts.channels or 2
    cmd = [ffmpeg_path(), "-v", "error", "-i", str(path)]
    if max_seconds:
        cmd += ["-t", str(max_seconds)]
    cmd += ["-f", "f32le", "-acodec", "pcm_f32le", "-ac", str(ch), "-ar", str(sr), "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    x = np.frombuffer(raw, dtype=np.float32)
    if ch > 1:
        x = x.reshape(-1, ch)
    else:
        x = x.reshape(-1, 1)
    return x, sr


def loudness(path: Path) -> dict:
    """EBU R128 integrated loudness, loudness range and true peak from ffmpeg's ebur128 filter."""
    res = subprocess.run(
        [ffmpeg_path(), "-v", "info", "-nostats", "-i", str(path), "-filter_complex",
         "ebur128=peak=true", "-f", "null", "-"], capture_output=True, text=True)
    log = res.stderr
    tail = log[log.rfind("Summary:"):] if "Summary:" in log else log
    def grab(label: str) -> float | None:
        m = re.search(label + r":\s*(-?[\d.]+|-inf)", tail)
        if not m:
            return None
        v = m.group(1)
        return None if v == "-inf" else float(v)
    return {"integrated_lufs": grab(r"I"), "loudness_range_lu": grab(r"LRA"), "true_peak_dbtp": grab(r"Peak")}


def peaks(x: np.ndarray) -> tuple[float | None, int]:
    """Sample peak in dBFS and the count of samples at or above 0 dBFS (|x| >= 1.0)."""
    if x.size == 0:
        return None, 0
    a = np.abs(x)
    peak = float(a.max())
    overs = int((a >= 1.0).sum())
    return (20 * math.log10(peak) if peak > 0 else None), overs


def bandwidth(x: np.ndarray, sr: int, seconds: float = 30.0, drop_db: float = 30.0) -> tuple[int | None, str]:
    """Effective bandwidth: the highest frequency at which the long-term spectrum is still within
    `drop_db` of the mid-band level (median power over 1-6 kHz), measured from the middle of the
    file on Welch-averaged 4096-point windows. A lossy stage upstream leaves a hard shelf: a
    shelf near 16-17 kHz usually means a 128 kbps MP3 somewhere in the chain; 19-20 kHz is normal
    for a platform encode; near Nyquist means a lossless or high-rate source."""
    if x.size == 0:
        return None, "no audio"
    mono = x.mean(axis=1) if x.ndim == 2 else x
    n = len(mono)
    take = min(n, int(seconds * sr))
    start = max(0, (n - take) // 2)
    seg = mono[start:start + take].astype(np.float64)
    win_n = 4096
    if len(seg) < win_n * 2:
        return None, "too short to measure"
    win = np.hanning(win_n)
    hop = win_n // 2
    acc = np.zeros(win_n // 2 + 1)
    count = 0
    for i in range(0, len(seg) - win_n, hop):
        frame = seg[i:i + win_n] * win
        acc += np.abs(np.fft.rfft(frame)) ** 2
        count += 1
    if count == 0 or acc.sum() == 0:
        return None, "silent"
    psd = acc / count
    freqs = np.fft.rfftfreq(win_n, 1 / sr)
    # smooth across ~7 bins (~80 Hz at 48 kHz) so single-bin dips don't end the band early
    k = 7
    sm = np.convolve(psd, np.ones(k) / k, mode="same")
    mid = sm[(freqs >= 1000) & (freqs <= 6000)]
    if mid.size == 0 or np.median(mid) <= 0:
        return None, "no mid-band energy"
    floor = np.median(mid) / (10 ** (drop_db / 10))
    above = np.nonzero(sm >= floor)[0]
    bw = int(freqs[above[-1]]) if above.size else 0
    nyq = sr / 2
    if bw >= nyq * 0.93:
        note = "extends to the top of the band: lossless or high-rate source"
    elif bw >= 18500:
        note = "normal for a platform encode (Opus/AAC at good bitrate)"
    elif bw >= 15000:
        note = "hard shelf around 16 kHz: likely transcoded upstream from a lossy file"
    elif bw >= 10000:
        note = "rolls off early: low-bitrate or heavily processed source"
    else:
        note = "very limited bandwidth: speech, old transfer, or a tiny bitrate"
    return bw, note


def stereo(x: np.ndarray) -> tuple[bool, float | None, str]:
    """Near-mono detection from side vs mid energy. Below -40 dB side energy is effectively mono."""
    if x.ndim != 2 or x.shape[1] < 2:
        return True, None, "mono file"
    l, r = x[:, 0].astype(np.float64), x[:, 1].astype(np.float64)
    mid = (l + r) / 2
    side = (l - r) / 2
    em, es = float((mid ** 2).mean()), float((side ** 2).mean())
    if em <= 0:
        return True, None, "silent"
    ratio_db = 10 * math.log10(es / em) if es > 0 else -120.0
    if ratio_db < -40:
        return True, ratio_db, "effectively mono (identical channels)"
    if ratio_db < -25:
        return True, ratio_db, "near-mono: very little stereo information; may be fake or narrow stereo"
    return False, ratio_db, "real stereo width"


def analyze(path: Path, decoded: np.ndarray | None = None, sr: int | None = None) -> QualityReport:
    if decoded is None or sr is None:
        decoded, sr = decode_float(path)
    lo = loudness(path)
    sp, overs = peaks(decoded)
    bw, bw_note = bandwidth(decoded, sr)
    near, ratio, st_note = stereo(decoded)
    return QualityReport(
        integrated_lufs=lo["integrated_lufs"], loudness_range_lu=lo["loudness_range_lu"], true_peak_dbtp=lo["true_peak_dbtp"],
        sample_peak_dbfs=round(sp, 2) if sp is not None else None, samples_over_0dbfs=overs,
        bandwidth_hz=bw, bandwidth_note=bw_note, near_mono=near,
        side_to_mid_db=round(ratio, 1) if ratio is not None else None, stereo_note=st_note,
    )


def report_dict(r: QualityReport) -> dict:
    return asdict(r)

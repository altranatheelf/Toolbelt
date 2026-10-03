"""Analysis tests on synthetic audio made with ffmpeg: no network, no third-party media."""
import math
import subprocess
from pathlib import Path

import numpy as np
import pytest

from ripper import analysis
from ripper.tools import ffmpeg_path

FF = ffmpeg_path()


def gen(tmp: Path, name: str, filt: str, seconds: float = 8, sr: int = 48000, extra: list[str] | None = None) -> Path:
    out = tmp / name
    cmd = [FF, "-v", "error", "-y", "-f", "lavfi", "-i", f"{filt}:duration={seconds}:sample_rate={sr}"] + (extra or []) + [str(out)]
    subprocess.run(cmd, check=True)
    return out


def tone(tmp: Path, name: str, amp: float, hz: int = 1000, seconds: float = 8, codec: str = "pcm_f32le", channels: int = 2) -> Path:
    """A sine at an explicit linear amplitude (1.0 = 0 dBFS), identical in every channel."""
    expr = "|".join([f"{amp}*sin(2*PI*{hz}*t)"] * channels)
    out = tmp / name
    subprocess.run([FF, "-v", "error", "-y", "-f", "lavfi", "-i", f"aevalsrc={expr}:s=48000:d={seconds}", "-c:a", codec, str(out)], check=True)
    return out


def test_probe_and_decode(tmp_path):
    f = tone(tmp_path, "tone.wav", 0.5, codec="pcm_s16le")
    facts = analysis.probe(f)
    assert facts.sample_rate == 48000 and facts.channels == 2 and facts.codec == "pcm_s16le"
    x, sr = analysis.decode_float(f)
    assert sr == 48000 and x.shape[1] == 2 and abs(len(x) / sr - 8) < 0.01


def test_peaks_and_overs(tmp_path):
    # pcm_f32le can hold samples above 0 dBFS: a +3 dB sine must count as overs
    f = tone(tmp_path, "hot.wav", 1.41, hz=440)        # +3 dBFS: only float can hold it
    x, _ = analysis.decode_float(f)
    peak, overs = analysis.peaks(x)
    assert peak > 2.5 and overs > 1000
    g = tone(tmp_path, "quiet.wav", 0.501, hz=440)     # -6 dBFS
    y, _ = analysis.decode_float(g)
    peak2, overs2 = analysis.peaks(y)
    assert -6.2 < peak2 < -5.8 and overs2 == 0


def test_bandwidth_flags_a_16k_shelf_not_a_clean_original(tmp_path):
    clean = gen(tmp_path, "noise.wav", "anoisesrc=color=white:seed=1", seconds=12, extra=["-c:a", "pcm_f32le"])
    xc, sr = analysis.decode_float(clean)
    bw, note = analysis.bandwidth(xc, sr)
    assert bw >= 22000 and "lossless or high-rate" in note, (bw, note)
    # the same noise through a 128 kbps MP3 with the 16 kHz lowpass older encoders apply at that rate
    # (this ffmpeg's LAME keeps 20 kHz even at 96 kbps, so the cutoff is forced to emulate those files)
    mp3 = tmp_path / "noise128.mp3"
    subprocess.run([FF, "-v", "error", "-y", "-i", str(clean), "-c:a", "libmp3lame", "-b:a", "128k", "-cutoff", "16000", str(mp3)], check=True)
    back = tmp_path / "noise128.wav"
    subprocess.run([FF, "-v", "error", "-y", "-i", str(mp3), "-c:a", "pcm_f32le", str(back)], check=True)
    xb, sr2 = analysis.decode_float(back)
    bw2, note2 = analysis.bandwidth(xb, sr2)
    assert 14500 <= bw2 <= 18500, (bw2, note2)
    assert "transcoded upstream" in note2 or "rolls off" in note2


def test_near_mono_detection(tmp_path):
    mono2 = tone(tmp_path, "dualmono.wav", 0.5, hz=300)
    x, _ = analysis.decode_float(mono2)
    near, ratio, note = analysis.stereo(x)
    assert near and ratio < -40 and "mono" in note
    # independent noise in each channel: real stereo
    wide = tmp_path / "wide.wav"
    subprocess.run([FF, "-v", "error", "-y", "-f", "lavfi", "-i", "anoisesrc=color=pink:seed=1:duration=6:sample_rate=48000",
                    "-f", "lavfi", "-i", "anoisesrc=color=pink:seed=2:duration=6:sample_rate=48000",
                    "-filter_complex", "[0:a][1:a]join=inputs=2:channel_layout=stereo[a]", "-map", "[a]", "-c:a", "pcm_f32le", str(wide)], check=True)
    y, _ = analysis.decode_float(wide)
    near2, ratio2, note2 = analysis.stereo(y)
    assert not near2 and ratio2 > -6


def test_loudness_via_ebur128(tmp_path):
    f = tone(tmp_path, "lufs.wav", 0.1)                 # -20 dBFS, both channels
    lo = analysis.loudness(f)
    # a -20 dBFS stereo 1 kHz sine reads about -20 LUFS (K-weighting is ~0 dB at 1 kHz, two channels summed)
    assert lo["integrated_lufs"] is not None and -24 < lo["integrated_lufs"] < -18, lo
    assert lo["true_peak_dbtp"] is not None and -21 < lo["true_peak_dbtp"] < -19, lo


def test_full_report(tmp_path):
    f = tone(tmp_path, "r.wav", 0.5, hz=500)
    r = analysis.analyze(f)
    d = analysis.report_dict(r)
    for k in ("integrated_lufs", "true_peak_dbtp", "sample_peak_dbfs", "samples_over_0dbfs", "bandwidth_hz", "near_mono", "stereo_note"):
        assert k in d

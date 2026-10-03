import subprocess
from pathlib import Path

import numpy as np

from ripper import analysis, convert
from ripper.tools import ffmpeg_path

FF = ffmpeg_path()


def hot_opus(tmp: Path) -> Path:
    """A +2 dBFS-ish float tone encoded to Opus at 48 kHz: the decoder will produce samples over 0 dBFS."""
    wav = tmp / "hot.wav"
    subprocess.run([FF, "-v", "error", "-y", "-f", "lavfi", "-i", "aevalsrc=1.25*sin(2*PI*1000*t)|1.25*sin(2*PI*1000*t):s=48000:d=6", "-c:a", "pcm_f32le", str(wav)], check=True)
    opus = tmp / "hot.opus"
    subprocess.run([FF, "-v", "error", "-y", "-i", str(wav), "-c:a", "libopus", "-b:a", "160k", str(opus)], check=True)
    return opus


def test_wav_float_keeps_source_rate_and_overs(tmp_path):
    src = hot_opus(tmp_path)
    out = tmp_path / "out.wav"
    r = convert.convert(src, out, "wav")
    assert r.overs > 0 and r.processing["bits"] == "float32" and r.processing["resampled"] is None and not r.warnings
    f = analysis.probe(out)
    assert f.sample_rate == 48000 and f.codec == "pcm_f32le"
    x, _ = analysis.decode_float(out)
    assert analysis.peaks(x)[1] > 0, "float output preserves the overs"


def test_24_bit_warns_on_overs_and_clips(tmp_path):
    src = hot_opus(tmp_path)
    out = tmp_path / "out24.wav"
    r = convert.convert(src, out, "wav", bits=24)
    assert any("exceeds 0 dBFS" in w for w in r.warnings) and r.processing["clipped_on_output"] is True
    assert analysis.probe(out).codec == "pcm_s24le"
    x, _ = analysis.decode_float(out)
    assert float(np.abs(x).max()) <= 1.0


def test_16_bit_is_dithered_and_recorded(tmp_path):
    src = hot_opus(tmp_path)
    out = tmp_path / "out16.wav"
    r = convert.convert(src, out, "wav", bits=16)
    assert r.processing["dither"].startswith("TPDF") and analysis.probe(out).codec == "pcm_s16le"


def test_resample_only_when_asked_uses_soxr(tmp_path):
    src = hot_opus(tmp_path)
    out = tmp_path / "out441.wav"
    r = convert.convert(src, out, "wav", rate=44100)
    assert r.processing["resampled"] == {"from": 48000, "to": 44100, "method": "soxr precision 28"}
    assert analysis.probe(out).sample_rate == 44100


def test_flac_and_mp3_modes(tmp_path):
    src = hot_opus(tmp_path)
    r = convert.convert(src, tmp_path / "o.flac", "flac", bits=16)
    assert analysis.probe(tmp_path / "o.flac").codec == "flac" and r.processing["bits"] == "16"
    r2 = convert.convert(src, tmp_path / "o.mp3", "mp3")
    assert any("lossy-to-lossy" in w for w in r2.warnings) and analysis.probe(tmp_path / "o.mp3").codec == "mp3"


def test_sections_are_sample_accurate_with_handles(tmp_path):
    wav = tmp_path / "ramp.wav"
    # 10 s stereo file whose left channel is a sample counter ramp, so positions can be read back exactly
    sr, n = 48000, 480000
    ramp = (np.arange(n, dtype=np.float32) / n).reshape(-1, 1)
    data = np.concatenate([ramp, ramp], axis=1)
    subprocess.run([FF, "-v", "error", "-y", "-f", "f32le", "-ar", str(sr), "-ac", "2", "-i", "-", "-c:a", "pcm_f32le", str(wav)], input=data.tobytes(), check=True)
    out = tmp_path / "cut.wav"
    a, b = convert.parse_section("0:01.5-0:03")
    assert (a, b) == (1.5, 3.0)
    r = convert.convert(wav, out, "wav", sections=[(a, b)], handles_ms=10)
    x, sr2 = analysis.decode_float(out)
    h = int(0.010 * sr)
    assert len(x) == int(b * sr) - int(a * sr) + 2 * h, len(x)
    # first sample equals ramp at (1.5 s - 10 ms) exactly, last at (3 s + 10 ms - 1 sample)
    assert abs(x[0, 0] - (int(a * sr) - h) / n) < 1e-6
    assert abs(x[-1, 0] - (int(b * sr) + h - 1) / n) < 1e-6
    r0 = convert.convert(wav, tmp_path / "cut0.wav", "wav", sections=[(a, b)], handles_ms=0)
    y, _ = analysis.decode_float(tmp_path / "cut0.wav")
    assert len(y) == int(b * sr) - int(a * sr)
    assert r.processing["sections"][0]["handles_ms"] == 10

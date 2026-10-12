"""ffmpeg/ffprobe helpers. The source file is only ever read."""

from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import sys
import wave
from dataclasses import dataclass
from pathlib import Path

import numpy as np

BREW_COMMAND = "brew install ffmpeg"
MODEL_RATE = 16000  # what the model hears: 16 kHz mono


def require_ffmpeg() -> None:
    """Exit with the Homebrew command when ffmpeg or ffprobe is missing."""
    missing = [tool for tool in ("ffmpeg", "ffprobe") if shutil.which(tool) is None]
    if missing:
        sys.stderr.write(
            f"mishear needs {' and '.join(missing)} on PATH. Install with:\n\n"
            f"    {BREW_COMMAND}\n\n"
        )
        sys.exit(2)


@dataclass(frozen=True)
class Probe:
    sample_rate: int
    channels: int
    duration: float
    codec: str


def probe(path: Path) -> Probe:
    """Sample rate, channel count, duration and codec of the first audio stream."""
    out = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "a:0",
            "-show_entries", "stream=sample_rate,channels,codec_name:format=duration",
            "-of", "json", str(path),
        ],
        capture_output=True, text=True, check=True,
    ).stdout
    data = json.loads(out)
    streams = data.get("streams") or []
    if not streams:
        raise ValueError(f"no audio stream in {path}")
    stream = streams[0]
    duration = float(data.get("format", {}).get("duration") or 0.0)
    return Probe(int(stream["sample_rate"]), int(stream["channels"]), duration, stream.get("codec_name", ""))


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def ffmpeg_args(source: Path, filter_graph: str | None, out: Path) -> list[str]:
    """The exact ffmpeg command that renders one degraded version as 16 kHz mono PCM."""
    args = ["ffmpeg", "-nostdin", "-hide_banner", "-v", "error", "-y", "-i", str(source)]
    if filter_graph is None:
        args += ["-map", "0:a:0"]
    else:
        args += ["-filter_complex", filter_graph, "-map", "[out]"]
    args += ["-ac", "1", "-ar", str(MODEL_RATE), "-c:a", "pcm_s16le", str(out)]
    return args


def render(source: Path, filter_graph: str | None, out: Path) -> list[str]:
    """Render source through filter_graph into out; returns the argv that ran."""
    args = ffmpeg_args(source, filter_graph, out)
    proc = subprocess.run(args, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg failed ({proc.returncode}): {proc.stderr.strip()}")
    return args


def load_mono16k(path: Path) -> np.ndarray:
    """Read a rendered file as float32 samples in [-1, 1)."""
    with wave.open(str(path), "rb") as handle:
        if handle.getnchannels() != 1 or handle.getframerate() != MODEL_RATE or handle.getsampwidth() != 2:
            raise ValueError(f"{path} is not 16 kHz mono 16-bit")
        frames = handle.readframes(handle.getnframes())
    return np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0

#!/usr/bin/env python3
"""Make the STAND-IN fixture: a synthetic voice over a sine sweep, 20 s, 16 kHz mono.

This is not a recording; it is a placeholder until a real 20-second recording the owner
owns is added as tests/fixtures/sample.wav. On macOS it uses `say`; elsewhere `espeak-ng`.
Usage: python tools/make_standin.py [out.wav]
"""
from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

TEXT = ("This is a stand in. The lighthouse keeper mends a broken radio while the kettle boils. "
        "Count the gulls, then count them again. Seven, eleven, a dozen, none. "
        "The tide writes the same line twice and crosses one of them out.")


def say(wav: Path) -> str:
    if shutil.which("say"):
        aiff = wav.with_suffix(".aiff")
        subprocess.run(["say", "-v", "Samantha", "-r", "165", "-o", str(aiff), TEXT], check=True)
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(aiff), "-ar", "16000", "-ac", "1", str(wav)], check=True)
        aiff.unlink(missing_ok=True)
        return "macOS say (Samantha)"
    if shutil.which("espeak-ng"):
        subprocess.run(["espeak-ng", "-v", "en-us", "-s", "150", "-w", str(wav), TEXT], check=True)
        return "espeak-ng (en-us)"
    sys.exit("need macOS `say` or `espeak-ng` to make the stand-in voice")


def main() -> None:
    out = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "standin.wav")
    out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as td:
        voice = Path(td) / "voice.wav"
        engine = say(voice)
        # sine sweep 200 Hz -> 2 kHz under the voice at -18 dB, padded/trimmed to exactly 20 s
        subprocess.run([
            "ffmpeg", "-v", "error", "-y",
            "-i", str(voice),
            "-f", "lavfi", "-i", "sine=frequency=200:beep_factor=0:duration=20:sample_rate=16000",
            "-filter_complex",
            "[1:a]aeval='sin(2*PI*t*(200+90*t))':c=mono,volume=-18dB[sw];"
            "[0:a]apad=whole_dur=20,atrim=0:20,aformat=sample_rates=16000:channel_layouts=mono[v];"
            "[v][sw]amix=inputs=2:duration=first:normalize=0[a]",
            "-map", "[a]", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", "-t", "20", str(out)], check=True)
    (out.with_suffix(".txt")).write_text(TEXT + "\n")
    (out.parent / "STANDIN.md").write_text(
        f"standin.wav is a STAND-IN, not a recording: synthetic voice ({engine}) over a sine sweep, 20 s, 16 kHz mono, "
        "made by tools/make_standin.py. Replace with a real 20-second recording owned by the maintainer as sample.wav (+ sample.txt lyrics).\n")
    print(f"wrote {out} ({engine}); lyrics in {out.with_suffix('.txt')}")


if __name__ == "__main__":
    main()

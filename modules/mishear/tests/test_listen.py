import json
import wave
from pathlib import Path

import numpy as np
import pytest

from mishear import audio
from mishear.cli import main
from mishear.conditions import CONDITIONS, Settings
from mishear.config import load_config

PROBE = audio.Probe(sample_rate=44100, channels=2, duration=20.0, codec="pcm_s16le")

SIDECAR_FIELDS = {"tool", "timestamp", "source", "seed", "config", "ears"}
SOURCE_FIELDS = {"path", "sha256", "duration", "sample_rate", "channels"}
EAR_FIELDS = {"condition", "model", "language", "task", "filter", "ffmpeg", "model_info", "decode"}


def run(path: Path, out: Path, *flags: str) -> Path:
    assert main(["listen", str(path), "--out", str(out), *flags]) == 0
    return out / path.stem


def sheet_lines(sheet: str) -> list[str]:
    """The heard lines in a sheet: bullets with a time range."""
    return [l for l in sheet.splitlines() if l.startswith("- ") and "–" in l[:16]]


def test_clean_is_no_filter():
    assert CONDITIONS["clean"](PROBE, Settings()) is None


def test_config_created_with_defaults(tmp_path, monkeypatch):
    path = tmp_path / "cfg" / "config.toml"
    monkeypatch.setenv("MISHEAR_CONFIG", str(path))
    config = load_config()
    assert path.exists()
    assert config.languages == ("el", "ro")
    assert config.models_default == ("base", "small")
    assert config.models_all == ("tiny", "base", "small") and config.models_deep == ("medium",)
    assert config.conditions["clean"] is True


def test_missing_ffmpeg_prints_brew_command(monkeypatch, capsys):
    monkeypatch.setattr(audio.shutil, "which", lambda tool: None)
    with pytest.raises(SystemExit) as exc:
        audio.require_ffmpeg()
    assert exc.value.code == 2
    assert "brew install ffmpeg" in capsys.readouterr().err


def test_clean_ear_end_to_end(standin, tmp_path):
    outdir = run(standin, tmp_path / "sheets")
    sheet = (outdir / "sheet.md").read_text(encoding="utf-8")
    assert "### clean · tiny · en" in sheet
    assert sheet_lines(sheet), "the clean ear heard nothing on the stand-in"
    assert (outdir / "ears" / "clean.tiny.en.transcribe.txt").exists()
    assert "stand" in sheet.lower()  # it is a stand-in reading the words "stand in"

    sidecar = json.loads((outdir / "sidecar.json").read_text(encoding="utf-8"))
    assert SIDECAR_FIELDS <= set(sidecar)
    assert SOURCE_FIELDS <= set(sidecar["source"])
    assert sidecar["source"]["sha256"] == audio.sha256(standin)
    assert sidecar["tool"]["version"]
    clean = [e for e in sidecar["ears"] if e["condition"] == "clean"][0]
    assert EAR_FIELDS <= set(clean)
    assert clean["filter"] is None
    assert clean["ffmpeg"][0] == "ffmpeg"
    assert clean["decode"]["temperature"] == 0.0 and clean["decode"]["beam_size"] == 5
    assert clean["model_info"]["size"] == "tiny" and clean["model_info"]["faster_whisper"]
    assert clean["language"] == "en" and clean["task"] == "transcribe"

    record = json.loads((outdir / "ears" / "clean.tiny.en.transcribe.json").read_text(encoding="utf-8"))
    words = [w for line in record["lines"] for w in line["words"]]
    assert words and all(0.0 <= w["probability"] <= 1.0 for w in words)


def test_two_runs_identical_sheet(standin, tmp_path):
    first = (run(standin, tmp_path / "a", "--quick") / "sheet.md").read_bytes()
    second = (run(standin, tmp_path / "b", "--quick") / "sheet.md").read_bytes()
    assert first == second


def test_source_untouched(standin, tmp_path):
    before = audio.sha256(standin)
    run(standin, tmp_path / "sheets", "--quick")
    assert audio.sha256(standin) == before


def test_silence_gives_empty_sheet(tmp_path):
    silent = tmp_path / "silence.wav"
    with wave.open(str(silent), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(16000)
        handle.writeframes(np.zeros(16000 * 4, dtype=np.int16).tobytes())
    outdir = run(silent, tmp_path / "sheets")
    sheet = (outdir / "sheet.md").read_text(encoding="utf-8")
    assert sheet_lines(sheet) == []
    for placeholder in ("nothing", "silence", "no speech", "(empty)", "n/a"):
        assert placeholder not in sheet.lower().replace("silence.wav", "")
    for ear_file in (outdir / "ears").glob("*.txt"):
        body = [l for l in ear_file.read_text(encoding="utf-8").splitlines() if not l.startswith("#")]
        assert body == []

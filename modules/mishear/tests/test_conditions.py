import json

from mishear.audio import Probe, probe
from mishear.cli import main
from mishear.conditions import CONDITIONS, Settings, note

STEREO = Probe(sample_rate=44100, channels=2, duration=20.0, codec="pcm_s16le")
MONO16K = Probe(sample_rate=16000, channels=1, duration=20.0, codec="pcm_s16le")


def run(path, out, *flags):
    assert main(["listen", str(path), "--out", str(out), *flags]) == 0
    return out / path.stem


def test_every_condition_produces_a_file(standin, tmp_path):
    outdir = run(standin, tmp_path / "sheets", "--keep")
    sheet = (outdir / "sheet.md").read_text(encoding="utf-8")
    sidecar = json.loads((outdir / "sidecar.json").read_text(encoding="utf-8"))
    for name in CONDITIONS:
        assert (outdir / "degraded" / f"{name}.wav").exists(), name
        assert (outdir / "ears" / f"{name}.tiny.en.transcribe.txt").exists(), name
        assert f"### {name} · tiny · en" in sheet, name
        ear = [e for e in sidecar["ears"] if e["condition"] == name and e["language"] == "en"][0]
        expected = CONDITIONS[name](probe(standin), Settings())
        assert ear["filter"] == expected
        if expected is not None:
            assert expected in ear["ffmpeg"]
        assert ear["degraded_file"].endswith(f"{name}.wav")


def test_wall():
    assert CONDITIONS["wall"](STEREO, Settings()) == "[0:a:0]lowpass=f=800[out]"

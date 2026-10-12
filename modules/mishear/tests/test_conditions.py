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
    from mishear.audio import load_mono16k
    for name in CONDITIONS:
        assert (outdir / "degraded" / f"{name}.wav").exists(), name
        assert len(load_mono16k(outdir / "degraded" / f"{name}.wav")) > 16000 * 15, f"{name} render is too short"
        ear_text = (outdir / "ears" / f"{name}.tiny.en.transcribe.txt").read_text(encoding="utf-8")
        assert ear_text.startswith(f"# {name} · tiny · en\n# filter: "), name
        assert f"### {name} · tiny · en" in sheet, name
        ear = [e for e in sidecar["ears"] if e["condition"] == name and e["language"] == "en"][0]
        expected = CONDITIONS[name](probe(standin), Settings())
        assert ear["filter"] == expected
        if expected is not None:
            assert expected in ear["ffmpeg"]
        assert ear["degraded_file"].endswith(f"{name}.wav")


def test_wall():
    assert CONDITIONS["wall"](STEREO, Settings()) == "[0:a:0]lowpass=f=800[out]"

def test_radio():
    assert CONDITIONS["radio"](STEREO, Settings()) == "[0:a:0]highpass=f=300,lowpass=f=3400,acompressor[out]"

def test_tape_runs_slow_at_the_source_rate():
    assert CONDITIONS["tape"](STEREO, Settings()) == "[0:a:0]asetrate=41013,aresample=44100[out]"
    assert CONDITIONS["tape"](MONO16K, Settings()) == "[0:a:0]asetrate=14880,aresample=16000[out]"

def test_helium_runs_fast_at_the_source_rate():
    assert CONDITIONS["helium"](STEREO, Settings()) == "[0:a:0]asetrate=49392,aresample=44100[out]"

def test_rain_uses_the_configured_level_and_seed():
    assert CONDITIONS["rain"](STEREO, Settings()) == (
        "anoisesrc=color=pink:seed=0:sample_rate=44100:amplitude=1,volume=-12dB[n];"
        "[0:a:0][n]amix=inputs=2:duration=first:normalize=0[out]"
    )
    assert "seed=7" in CONDITIONS["rain"](STEREO, Settings(noise_db=-20, seed=7))
    assert "volume=-20dB" in CONDITIONS["rain"](STEREO, Settings(noise_db=-20, seed=7))

def test_sideways_is_the_side_channel_or_zero_on_mono():
    assert CONDITIONS["sideways"](STEREO, Settings()) == "[0:a:0]pan=mono|c0=0.5*c0-0.5*c1[out]"
    assert CONDITIONS["sideways"](MONO16K, Settings()) == "[0:a:0]pan=mono|c0=0*c0[out]"
    assert note("sideways", MONO16K) and "mono" in note("sideways", MONO16K)
    assert note("sideways", STEREO) is None


def test_sideways_on_mono_does_not_crash(standin, tmp_path):
    assert probe(standin).channels == 1
    outdir = run(standin, tmp_path / "sheets", "--quick")
    assert (outdir / "ears" / "sideways.tiny.en.transcribe.txt").exists()
    sidecar = json.loads((outdir / "sidecar.json").read_text(encoding="utf-8"))
    ear = [e for e in sidecar["ears"] if e["condition"] == "sideways"][0]
    assert "mono" in ear["note"]

def test_backwards():
    assert CONDITIONS["backwards"](STEREO, Settings()) == "[0:a:0]areverse[out]"

def test_crushed():
    assert CONDITIONS["crushed"](STEREO, Settings()) == "[0:a:0]acrusher=bits=6:mix=0[out]"

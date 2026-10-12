"""Defects found by review, each pinned by a test."""

import json
import os
import shutil
import subprocess

import pytest

from mishear import audio
from mishear.cli import main
from mishear.conditions import CONDITIONS, Settings
from mishear.config import load_config
from mishear.dissent import differs_from, hearing_key, judge, place_words, reference_ear, windows
from mishear.ears import Ear, Hearing, Line, Word
from mishear.run import collect_sources, read_lyrics, recorded_args
from mishear.sheet import fmt_time, render_pile

PROBE = audio.Probe(16000, 1, 20.0, "pcm_s16le")


def hearing(condition, words, language="en", task="transcribe"):
    ws = tuple(Word(s, s + 0.3, f" {t}", p) for s, t, p in words)
    line = Line(ws[0].start, ws[-1].end, "".join(w.text for w in ws), ws)
    return Hearing(Ear(condition, "tiny", language, task), [line], None, [], {}, {})


def test_crushed_changes_the_audio(standin, tmp_path):
    clean = tmp_path / "clean.wav"
    crushed = tmp_path / "crushed.wav"
    audio.render(standin, None, clean)
    audio.render(standin, CONDITIONS["crushed"](audio.probe(standin), Settings()), crushed)
    assert audio.load_mono16k(clean).tobytes() != audio.load_mono16k(crushed).tobytes()


def test_render_refuses_to_overwrite_the_source(standin, tmp_path):
    copy = tmp_path / "standin.wav"
    shutil.copy(standin, copy)
    with pytest.raises(RuntimeError):
        audio.render(copy, None, copy)
    assert copy.read_bytes() == standin.read_bytes()


def test_duration_is_decoded_when_the_container_has_none(standin, tmp_path, monkeypatch):
    assert audio.decoded_duration(standin) == pytest.approx(20.0, abs=0.01)
    original = subprocess.run

    def no_format_duration(args, **kw):
        result = original(args, **kw)
        if args[0] == "ffprobe":
            data = json.loads(result.stdout)
            data["format"].pop("duration", None)
            data["streams"][0].pop("duration", None)
            result.stdout = json.dumps(data)
        return result

    monkeypatch.setattr(audio.subprocess, "run", no_format_duration)
    assert audio.probe(standin).duration == pytest.approx(20.0, abs=0.01)


def test_fmt_time_rolls_the_minute():
    assert fmt_time(59.996) == "1:00.00"
    assert fmt_time(0.004) == "0:00.00"
    assert fmt_time(61.234) == "1:01.23"


def test_differs_from_compares_whole_words_in_sequence():
    real = "The lighthouse keeper mends a broken radio."
    assert differs_from(real, " lighthouse keeper") is False
    assert differs_from(real, " keeper mends a") is False
    assert differs_from(real, " men") is True            # a fragment of "mends"
    assert differs_from(real, " keeper a") is True       # right words, wrong order
    assert differs_from(real, " ♪") is True
    assert differs_from(None, " anything") is False


def test_symbol_hearings_take_part_in_dissent():
    assert hearing_key(" ♪") == "♪" and hearing_key(" Light,") == "light"
    w = windows(place_words([hearing("clean", [(1.0, "♪", 0.9)]), hearing("wall", [(1.0, "light", 0.5)])], PROBE))[0]
    assert judge(w) == (True, 0.9)


def test_reference_ear_prefers_clean_english_transcribe():
    translate = hearing("clean", [(1.0, "a", 0.9), (1.5, "b", 0.9), (2.0, "c", 0.9)], language="el", task="translate")
    english = hearing("clean", [(1.0, "a", 0.9), (1.5, "b", 0.9)])
    wall = hearing("wall", [(1.0, "a", 0.9), (1.5, "b", 0.9), (2.0, "c", 0.9), (2.5, "d", 0.9)])
    assert reference_ear([translate, english, wall]) is english
    assert reference_ear([translate]) is translate


def test_pile_keeps_pipes_as_heard():
    assert render_pile(["a | b"]) == "## Pile\n\n- a | b"


def test_collect_sources_skips_dot_files(tmp_path):
    (tmp_path / "a.wav").write_bytes(b"x")
    (tmp_path / "._a.wav").write_bytes(b"x")
    (tmp_path / "notes.txt").write_bytes(b"x")
    assert [p.name for p in collect_sources(tmp_path)] == ["a.wav"]


def test_recorded_argv_is_stable(tmp_path):
    out = tmp_path / "x" / "wall.wav"
    args = audio.ffmpeg_args(tmp_path / "s.wav", "[0:a:0]lowpass=f=800[out]", out)
    assert recorded_args(args, out, "wall")[-1] == "degraded/wall.wav"


def test_empty_lyrics_file_is_ignored(tmp_path):
    empty = tmp_path / "s.txt"
    empty.write_text("\n\n")
    assert read_lyrics(empty) == (None, None)


def test_duplicate_languages_are_deduped(tmp_path, monkeypatch):
    path = tmp_path / "config.toml"
    path.write_text('languages = ["el", "el", "ro"]\n')
    monkeypatch.setenv("MISHEAR_CONFIG", str(path))
    assert load_config().languages == ("el", "ro")


def test_same_stem_sources_get_separate_sheets_and_stale_files_go(standin, tmp_path):
    folder = tmp_path / "pool"
    folder.mkdir()
    shutil.copy(standin, folder / "a.wav")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(standin), str(folder / "a.flac")], check=True)
    out = tmp_path / "sheets"
    (out / "a" / "ears").mkdir(parents=True)
    (out / "a" / "ears" / "old.tiny.en.transcribe.txt").write_text("stale")
    assert main(["listen", str(folder), "--out", str(out), "--quick"]) == 0
    sheets = {d.name: json.loads((d / "sidecar.json").read_text())["source"]["name"] for d in out.iterdir() if (d / "sheet.md").exists()}
    assert len(sheets) == 2 and set(sheets.values()) == {"a.wav", "a.flac"}
    assert "a" in sheets and (set(sheets) - {"a"}) <= {"a.wav", "a.flac"}  # the second keeps its extension
    assert not (out / "a" / "ears" / "old.tiny.en.transcribe.txt").exists()


def test_a_bad_file_does_not_stop_the_folder(standin, tmp_path, capsys):
    folder = tmp_path / "pool"
    folder.mkdir()
    shutil.copy(standin, folder / "good.wav")
    (folder / "broken.wav").write_text("this is not audio")
    out = tmp_path / "sheets"
    assert main(["listen", str(folder), "--out", str(out), "--quick"]) == 1
    assert (out / "good" / "sheet.md").exists()
    assert "broken.wav" in capsys.readouterr().err


def test_symlinked_source_keeps_its_own_name(standin, tmp_path):
    link = tmp_path / "linked.wav"
    os.symlink(standin, link)
    out = tmp_path / "sheets"
    assert main(["listen", str(link), "--out", str(out), "--quick"]) == 0
    assert (out / "linked" / "sheet.md").exists()
    assert json.loads((out / "linked" / "sidecar.json").read_text())["source"]["name"] == "linked.wav"

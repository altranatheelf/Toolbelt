import json

from mishear.cli import main
from mishear.config import load_config
from mishear.ears import Ear
from mishear.run import grid


def test_default_grid_hears_forced_languages_on_clean_and_wall_only():
    config = load_config()  # the test config: models tiny, languages ["el"]
    ears = grid(config, "default")
    forced = [e for e in ears if e.language != "en"]
    assert {e.condition for e in forced} == {"clean", "wall"}
    assert {e.task for e in forced} == {"transcribe", "translate"}
    assert Ear("clean", "tiny", "el", "transcribe") in ears
    assert Ear("clean", "tiny", "el", "translate") in ears
    assert Ear("wall", "tiny", "el", "translate") in ears
    assert Ear("radio", "tiny", "el", "transcribe") not in ears
    english = [e for e in ears if e.language == "en"]
    assert {e.condition for e in english} == set(config.conditions) and all(e.task == "transcribe" for e in english)


def test_forced_languages_use_the_largest_default_model(tmp_path, monkeypatch):
    path = tmp_path / "config.toml"
    path.write_text('languages = ["el"]\n[models]\ndefault = ["base", "small"]\n')
    monkeypatch.setenv("MISHEAR_CONFIG", str(path))
    ears = grid(load_config(), "default")
    assert {e.model for e in ears if e.language != "en"} == {"small"}
    assert {e.model for e in ears if e.language == "en"} == {"base", "small"}
    deep = grid(load_config(), "default", deep=True)
    assert {e.model for e in deep if e.language != "en"} == {"small", "medium"}


def test_quick_grid_is_english_only_and_all_grid_is_everything():
    config = load_config()
    quick = grid(config, "quick")
    assert [e.condition for e in quick] == ["clean", "wall", "sideways"]
    assert all(e.language == "en" for e in quick)
    everything = grid(config, "all")
    assert len(everything) == len(config.conditions) * len(config.models_all) * (1 + 2 * len(config.languages))
    assert {e.model for e in everything} == set(config.models_all)


def test_forced_language_ears_hear_native_script_and_translate_to_english(standin, tmp_path):
    out = tmp_path / "sheets"
    assert main(["listen", str(standin), "--out", str(out)]) == 0
    outdir = out / standin.stem
    native = json.loads((outdir / "ears" / "clean.tiny.el.transcribe.json").read_text(encoding="utf-8"))
    translated = json.loads((outdir / "ears" / "clean.tiny.el.translate.json").read_text(encoding="utf-8"))
    assert native["language"] == "el" and native["task"] == "transcribe"
    assert translated["language"] == "el" and translated["task"] == "translate"
    native_text = " ".join(line["text"] for line in native["lines"])
    translated_text = " ".join(line["text"] for line in translated["lines"])
    assert any("Ͱ" <= ch <= "Ͽ" for ch in native_text), "a Greek ear writes Greek script"
    assert translated_text and not any("Ͱ" <= ch <= "Ͽ" for ch in translated_text)
    sheet = (outdir / "sheet.md").read_text(encoding="utf-8")
    assert "### clean · tiny · el" in sheet and "### clean · tiny · el → en" in sheet
    assert "| tiny · el → en |" in sheet or "tiny · el → en" in sheet.split("## Ears")[0]

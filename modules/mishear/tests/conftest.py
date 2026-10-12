"""Tests run the real models (tiny only) on the stand-in fixture."""

from pathlib import Path

import pytest

FIXTURES = Path(__file__).parent / "fixtures"
STANDIN = FIXTURES / "standin.wav"

TEST_CONFIG = """\
languages = ["el"]

[models]
default = ["tiny"]
quick = ["tiny"]
all = ["tiny"]
deep = []

[decode]
cpu_threads = 2
"""


@pytest.fixture(autouse=True)
def test_config(tmp_path_factory, monkeypatch):
    path = tmp_path_factory.mktemp("config") / "config.toml"
    path.write_text(TEST_CONFIG, encoding="utf-8")
    monkeypatch.setenv("MISHEAR_CONFIG", str(path))
    return path


@pytest.fixture
def standin() -> Path:
    assert STANDIN.exists(), "tests/fixtures/standin.wav is committed; restore it with git"
    return STANDIN

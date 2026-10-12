"""~/.config/mishear/config.toml, created with defaults on first run."""

from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass
from pathlib import Path

DEFAULT_TOML = """\
# mishear configuration. Created with defaults on first run.

# Forced languages. Each one is heard twice: task = transcribe (native script)
# and task = translate (what the model makes of it in English).
languages = ["el", "ro"]

[models]
default = ["base", "small"]       # the default grid
quick = ["base"]                  # --quick
all = ["tiny", "base", "small"]   # --all
deep = ["medium"]                 # added by --deep

# Switch conditions off here to leave them out of every grid.
[conditions]
clean = true
wall = true
radio = true
tape = true
helium = true
rain = true
sideways = true
backwards = true
crushed = true

[noise]
level_db = -12.0   # gain on the "rain" pink noise generator (amplitude 1, about -14 dBFS RMS before this gain)
seed = 0           # noise generator seed (fixed: same input, same sheet)

[decode]
beam_size = 5
cpu_threads = 4
compute_type = "int8"
"""


@dataclass(frozen=True)
class Config:
    path: Path
    languages: tuple[str, ...]
    models_default: tuple[str, ...]
    models_quick: tuple[str, ...]
    models_all: tuple[str, ...]
    models_deep: tuple[str, ...]
    conditions: dict[str, bool]
    noise_db: float
    seed: int
    beam_size: int
    cpu_threads: int
    compute_type: str
    raw: dict


def config_path() -> Path:
    env = os.environ.get("MISHEAR_CONFIG")
    if env:
        return Path(env)
    return Path.home() / ".config" / "mishear" / "config.toml"


def load_config(path: Path | None = None) -> Config:
    path = path or config_path()
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(DEFAULT_TOML, encoding="utf-8")
    raw = tomllib.loads(path.read_text(encoding="utf-8"))
    defaults = tomllib.loads(DEFAULT_TOML)
    models = {**defaults["models"], **raw.get("models", {})}
    noise = {**defaults["noise"], **raw.get("noise", {})}
    decode = {**defaults["decode"], **raw.get("decode", {})}
    conditions = {**defaults["conditions"], **raw.get("conditions", {})}
    return Config(
        path=path,
        languages=tuple(dict.fromkeys(str(lang) for lang in raw.get("languages", defaults["languages"]))),
        models_default=tuple(models["default"]),
        models_quick=tuple(models["quick"]),
        models_all=tuple(models["all"]),
        models_deep=tuple(models["deep"]),
        conditions={str(k): bool(v) for k, v in conditions.items()},
        noise_db=float(noise["level_db"]),
        seed=int(noise["seed"]),
        beam_size=int(decode["beam_size"]),
        cpu_threads=int(decode["cpu_threads"]),
        compute_type=str(decode["compute_type"]),
        raw=raw,
    )

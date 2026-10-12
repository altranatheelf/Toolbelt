"""Listen to one source with a grid of ears and write its sheet folder."""

from __future__ import annotations

import json
import os
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from .audio import Probe, load_mono16k, probe, render, sha256
from .conditions import CONDITIONS, Settings, note
from .config import Config
from .ears import ENGLISH, Ear, Hearing, Line, Word, decode_params, listen, load_model
from .sheet import fmt_time, render_sheet
from .sidecar import build_sidecar, hearing_json

AUDIO_SUFFIXES = {
    ".wav", ".mp3", ".m4a", ".aac", ".flac", ".aiff", ".aif", ".ogg", ".opus",
    ".wma", ".caf", ".mp4", ".mov", ".m4v", ".webm", ".mkv",
}


def enabled_conditions(config: Config) -> list[str]:
    return [name for name in CONDITIONS if config.conditions.get(name, True)]


def grid(config: Config, mode: str = "default", deep: bool = False) -> list[Ear]:
    """The ears for a mode: default, quick or all. --deep adds the deep models."""
    conditions = enabled_conditions(config)
    forced = [lang for lang in config.languages if lang != ENGLISH]
    ears: list[Ear] = []
    if mode == "quick":
        models = list(config.models_quick) + (list(config.models_deep) if deep else [])
        for condition in [c for c in ("clean", "wall", "sideways") if c in conditions]:
            for model in models:
                ears.append(Ear(condition, model, ENGLISH))
        return ears
    sizes = config.models_all if mode == "all" else config.models_default
    models = list(dict.fromkeys(list(sizes) + (list(config.models_deep) if deep else [])))
    for condition in conditions:
        for model in models:
            ears.append(Ear(condition, model, ENGLISH))
    if mode == "all":
        forced_conditions, forced_models = conditions, models
    else:
        forced_conditions = [c for c in ("clean", "wall") if c in conditions]
        # the largest default model (the last listed) plus any deep model
        forced_models = [m for m in models if m not in config.models_default[:-1]]
    for condition in forced_conditions:
        for model in forced_models:
            for language in forced:
                ears.append(Ear(condition, model, language, "transcribe"))
                ears.append(Ear(condition, model, language, "translate"))
    return ears


def collect_sources(path: Path) -> list[Path]:
    if path.is_dir():
        return sorted(
            p for p in path.iterdir()
            if p.suffix.lower() in AUDIO_SUFFIXES and p.is_file() and not p.name.startswith(".")
        )
    return [path]


def read_lyrics(path: Path | None) -> tuple[Path | None, list[str] | None]:
    if path is None or not path.is_file():
        return None, None
    text = path.read_text(encoding="utf-8", errors="replace")
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    return (path, lines) if lines else (None, None)


def lyrics_for(source: Path) -> tuple[Path | None, list[str] | None]:
    candidate = source.with_suffix(".txt")
    return read_lyrics(candidate if candidate != source else None)


def sheet_dir(out_root: Path, source: Path) -> Path:
    """sheets/<stem>, or sheets/<name> when <stem> already holds another source's sheet."""
    outdir = out_root / source.stem
    sidecar = outdir / "sidecar.json"
    if sidecar.exists():
        try:
            other = json.loads(sidecar.read_text(encoding="utf-8")).get("source", {}).get("name")
        except Exception:  # noqa: BLE001
            other = None
        if other and other != source.name:
            return out_root / source.name
    return outdir


def clear_outputs(outdir: Path) -> None:
    """Drop ear and degraded files from an earlier run so the folder matches its sidecar."""
    for sub, pattern in (("ears", "*.txt"), ("ears", "*.json"), ("degraded", "*.wav")):
        for stale in (outdir / sub).glob(pattern):
            stale.unlink()


def recorded_args(args: list[str], out: Path, name: str) -> list[str]:
    """The ffmpeg argv with the temp output path replaced by its stable place under the sheet folder."""
    return [f"degraded/{name}.wav" if a == str(out) else a for a in args]


def ear_text(hearing: Hearing) -> str:
    """ears/<ear>.txt: timestamped lines, then the words with their probabilities."""
    out = [f"# {hearing.ear.label}", f"# filter: {hearing.filter_graph or 'none'}"]
    if hearing.note:
        out.append(f"# note: {hearing.note}")
    for line in hearing.lines:
        out.append(f"[{fmt_time(line.start)}–{fmt_time(line.end)}] {line.text.strip()}")
        for word in line.words:
            out.append(f"    {fmt_time(word.start)} {word.probability:.3f} {word.text.strip()}")
    return "\n".join(out) + "\n"


def listen_source(
    source: Path,
    ears: list[Ear],
    config: Config,
    out_root: Path,
    keep: bool = False,
    log: Callable[[str], None] = lambda message: print(message, file=sys.stderr),
) -> Path:
    """Render each condition once, run every ear, write sheet.md, sidecar.json and ears/."""
    source = Path(os.path.abspath(source))  # absolute, but a symlink keeps its own name
    out_root = Path(os.path.abspath(out_root))
    info = probe(source)
    digest = sha256(source)
    outdir = sheet_dir(out_root, source)
    ears_dir = outdir / "ears"
    ears_dir.mkdir(parents=True, exist_ok=True)
    clear_outputs(outdir)
    settings = Settings(noise_db=config.noise_db, seed=config.seed)
    conditions = list(dict.fromkeys(ear.condition for ear in ears))
    models = list(dict.fromkeys(ear.model for ear in ears))
    hearings: list[Hearing] = []

    with tempfile.TemporaryDirectory(prefix="mishear-") as tmp:
        degraded_dir = outdir / "degraded" if keep else Path(tmp)
        degraded_dir.mkdir(parents=True, exist_ok=True)
        rendered: dict[str, tuple[str | None, list[str], Path]] = {}
        for name in conditions:
            graph = CONDITIONS[name](info, settings)
            path = degraded_dir / f"{name}.wav"
            log(f"rendering {name}")
            args = render(source, graph, path)
            rendered[name] = (graph, recorded_args(args, path, name), path)

        audio_cache: dict[str, object] = {}
        for size in models:
            log(f"loading {size}")
            model, model_info = load_model(size, config)
            for ear in [e for e in ears if e.model == size]:
                graph, args, path = rendered[ear.condition]
                if ear.condition not in audio_cache:
                    audio_cache[ear.condition] = load_mono16k(path)
                log(f"listening {ear.label}")
                lines = listen(model, audio_cache[ear.condition], ear, config)
                hearings.append(Hearing(
                    ear=ear,
                    lines=lines,
                    filter_graph=graph,
                    ffmpeg_args=args,
                    decode=decode_params(ear, config),
                    model=model_info,
                    note=note(ear.condition, info),
                    degraded_file=str(path) if keep else None,
                ))
            del model

    hearings.sort(key=lambda h: ears.index(h.ear))
    for hearing in hearings:
        (ears_dir / f"{hearing.ear.name}.txt").write_text(ear_text(hearing), encoding="utf-8")
        (ears_dir / f"{hearing.ear.name}.json").write_text(
            json.dumps(hearing_json(hearing), indent=2, ensure_ascii=False, default=str) + "\n", encoding="utf-8",
        )
    lyrics_path, lyrics = lyrics_for(source)
    timestamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
    sidecar = build_sidecar(source, info, digest, hearings, config, lyrics_path, timestamp)
    (outdir / "sidecar.json").write_text(
        json.dumps(sidecar, indent=2, ensure_ascii=False, default=str) + "\n", encoding="utf-8",
    )
    sheet = render_sheet(source.name, info, digest, hearings, lyrics, lyrics_path.name if lyrics_path else None)
    (outdir / "sheet.md").write_text(sheet, encoding="utf-8")
    return outdir


def load_hearing(path: Path) -> Hearing:
    data = json.loads(path.read_text(encoding="utf-8"))
    lines = [
        Line(
            line["start"], line["end"], line["text"],
            tuple(Word(w["start"], w["end"], w["text"], w["probability"]) for w in line["words"]),
        )
        for line in data["lines"]
    ]
    ear = Ear(data["condition"], data["model"], data["language"], data["task"])
    return Hearing(
        ear=ear, lines=lines, filter_graph=data["filter"], ffmpeg_args=data["ffmpeg"],
        decode=data["decode"], model=data["model_info"], note=data.get("note"),
        degraded_file=data.get("degraded_file"),
    )


def rebuild_sheet(sheet_dir: Path) -> Path:
    """Rewrite sheet.md from sidecar.json and ears/*.json without listening again."""
    sidecar = json.loads((sheet_dir / "sidecar.json").read_text(encoding="utf-8"))
    src = sidecar["source"]
    info = Probe(src["sample_rate"], src["channels"], src["duration"], src.get("codec", ""))
    by_name = {h.ear.name: h for h in (load_hearing(p) for p in (sheet_dir / "ears").glob("*.json"))}
    hearings = [by_name[record["ear"]] for record in sidecar["ears"] if record["ear"] in by_name]
    source = Path(src["path"])
    lyrics_path, lyrics = lyrics_for(source) if source.exists() else (None, None)
    if lyrics is None and sidecar.get("lyrics"):
        lyrics_path, lyrics = read_lyrics(Path(sidecar["lyrics"]))  # the source moved; the sidecar remembers
    sheet = render_sheet(src["name"], info, src["sha256"], hearings, lyrics, lyrics_path.name if lyrics_path else None)
    (sheet_dir / "sheet.md").write_text(sheet, encoding="utf-8")
    return sheet_dir / "sheet.md"

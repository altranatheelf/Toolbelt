"""sidecar.json: everything needed to reproduce a sheet."""

from __future__ import annotations

from dataclasses import asdict
from pathlib import Path

from . import __version__
from .audio import Probe
from .config import Config
from .ears import Hearing


def hearing_record(hearing: Hearing) -> dict:
    ear = hearing.ear
    return {
        "ear": ear.name,
        "condition": ear.condition,
        "model": ear.model,
        "language": ear.language,
        "task": ear.task,
        "filter": hearing.filter_graph,
        "ffmpeg": hearing.ffmpeg_args,
        "degraded_file": hearing.degraded_file,
        "model_info": hearing.model,
        "decode": hearing.decode,
        "note": hearing.note,
        "lines": len(hearing.lines),
        "words": sum(len(line.words) for line in hearing.lines),
    }


def build_sidecar(
    source: Path,
    probe: Probe,
    digest: str,
    hearings: list[Hearing],
    config: Config,
    lyrics_path: Path | None,
    timestamp: str,
) -> dict:
    return {
        "tool": {"name": "mishear", "version": __version__},
        "timestamp": timestamp,
        "source": {
            "path": str(source.resolve()),
            "name": source.name,
            "sha256": digest,
            "duration": probe.duration,
            "sample_rate": probe.sample_rate,
            "channels": probe.channels,
            "codec": probe.codec,
        },
        "lyrics": str(lyrics_path.resolve()) if lyrics_path else None,
        "seed": config.seed,
        "noise_db": config.noise_db,
        "config": {"path": str(config.path), "values": config.raw},
        "ears": [hearing_record(h) for h in hearings],
    }


def hearing_json(hearing: Hearing) -> dict:
    """Full record of one ear, lines and words included (ears/<ear>.json)."""
    record = hearing_record(hearing)
    record["lines"] = [asdict(line) for line in hearing.lines]
    return record

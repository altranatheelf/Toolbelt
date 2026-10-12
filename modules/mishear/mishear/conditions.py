"""Listening conditions: one pure function per condition.

Each takes the source Probe and the noise Settings and returns the ffmpeg
filter graph the degraded version is rendered with, or None for no filter.
Graphs read the first audio stream as [0:a:0] and end in [out]; the string
a function returns is recorded verbatim in the sidecar.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from .audio import Probe


@dataclass(frozen=True)
class Settings:
    noise_db: float = -12.0
    seed: int = 0


Condition = Callable[[Probe, Settings], "str | None"]


def chain(filters: str) -> str:
    """Wrap a plain filter chain as a graph from the first audio stream to [out]."""
    return f"[0:a:0]{filters}[out]"


def clean(probe: Probe, settings: Settings) -> str | None:
    """No filter: the model hears the source as it is."""
    return None


CONDITIONS: dict[str, Condition] = {
    "clean": clean,
}


def note(name: str, probe: Probe) -> str | None:
    """A remark about how a condition applied to this source, if anything is unusual."""
    return None

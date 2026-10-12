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
TimeMap = Callable[[float, float], tuple[float, float]]

TAPE_RATE = 0.93
HELIUM_RATE = 1.12


def chain(filters: str) -> str:
    """Wrap a plain filter chain as a graph from the first audio stream to [out]."""
    return f"[0:a:0]{filters}[out]"


def clean(probe: Probe, settings: Settings) -> str | None:
    """No filter: the model hears the source as it is."""
    return None


def wall(probe: Probe, settings: Settings) -> str | None:
    """Through a wall: nothing above 800 Hz gets through."""
    return chain("lowpass=f=800")


def radio(probe: Probe, settings: Settings) -> str | None:
    """A telephone band, 300-3400 Hz, squashed by a compressor."""
    return chain("highpass=f=300,lowpass=f=3400,acompressor")


def tape(probe: Probe, settings: Settings) -> str | None:
    """Tape running slow: 7 % lower and longer, resampled back to the source rate."""
    return chain(f"asetrate={round(probe.sample_rate * TAPE_RATE)},aresample={probe.sample_rate}")


def helium(probe: Probe, settings: Settings) -> str | None:
    """Helium: 12 % higher and shorter, resampled back to the source rate."""
    return chain(f"asetrate={round(probe.sample_rate * HELIUM_RATE)},aresample={probe.sample_rate}")


def rain(probe: Probe, settings: Settings) -> str | None:
    """Pink noise mixed in at the configured level (default -12 dB), fixed seed."""
    return (
        f"anoisesrc=color=pink:seed={settings.seed}:sample_rate={probe.sample_rate}:amplitude=1,"
        f"volume={settings.noise_db:g}dB[n];"
        "[0:a:0][n]amix=inputs=2:duration=first:normalize=0[out]"
    )


def sideways(probe: Probe, settings: Settings) -> str | None:
    """The side channel only. A mono file has no side channel, so the ear gets zero
    (ffmpeg's pan would otherwise ignore the missing c1 and pass the mono at half level)."""
    if probe.channels < 2:
        return chain("pan=mono|c0=0*c0")
    return chain("pan=mono|c0=0.5*c0-0.5*c1")


def backwards(probe: Probe, settings: Settings) -> str | None:
    """Reversed."""
    return chain("areverse")


def crushed(probe: Probe, settings: Settings) -> str | None:
    """6-bit bit crusher. In acrusher's bit reduction mix=0 is fully crushed and mix=1 is
    the dry input (libavfilter/af_acrusher.c: k += (in - k) * mix), so mix=0 here."""
    return chain("acrusher=bits=6:mix=0")


CONDITIONS: dict[str, Condition] = {
    "clean": clean,
    "wall": wall,
    "radio": radio,
    "tape": tape,
    "helium": helium,
    "rain": rain,
    "sideways": sideways,
    "backwards": backwards,
    "crushed": crushed,
}


def note(name: str, probe: Probe) -> str | None:
    """A remark about how a condition applied to this source, if anything is unusual."""
    if name == "sideways" and probe.channels < 2:
        return "mono source: no side channel (the side of a mono signal is zero)"
    return None


def time_map(name: str, probe: Probe) -> TimeMap:
    """Map an ear's (start, end) back onto the source timeline.

    Tape and helium stretch time by their rate; backwards runs it in reverse.
    Every other condition keeps the source clock.
    """
    if name == "tape":
        return lambda start, end: (start * TAPE_RATE, end * TAPE_RATE)
    if name == "helium":
        return lambda start, end: (start * HELIUM_RATE, end * HELIUM_RATE)
    if name == "backwards":
        return lambda start, end: (max(probe.duration - end, 0.0), max(probe.duration - start, 0.0))
    return lambda start, end: (start, end)

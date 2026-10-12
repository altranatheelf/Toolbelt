"""Dissent and Pile: pure functions over a list of hearings.

Words are aligned across ears by time, never by string matching: each word is
placed on the source timeline (tape, helium and backwards ears mapped back),
and a word joins a window when it starts within WINDOW seconds of the window's
first word. Lyrics have no timestamps, so the real line for a window is found
by matching the lyric words to the reference ear's words once, which gives
each lyric line a time span.
"""

from __future__ import annotations

import re
import unicodedata
from collections import Counter
from dataclasses import dataclass, field
from difflib import SequenceMatcher

from .audio import Probe
from .conditions import time_map
from .ears import Ear, Hearing

WINDOW = 0.6  # seconds
SLACK = 0.3   # seconds a window may sit outside a lyric line's span and still belong to it


@dataclass(frozen=True)
class Placed:
    """One heard word on the source timeline. `order` is its place in what the ear heard."""

    ear: Ear
    start: float
    text: str
    probability: float
    order: int = 0


@dataclass
class Cell:
    ear: Ear
    words: list[Placed] = field(default_factory=list)

    @property
    def text(self) -> str:
        """The words as the ear heard them, in heard order (a backwards ear hears backwards)."""
        out = ""
        for word in sorted(self.words, key=lambda w: w.order):
            out = join_words(out, word.text)
        return out

    @property
    def probability(self) -> float:
        return sum(w.probability for w in self.words) / len(self.words) if self.words else 0.0


@dataclass
class Window:
    start: float
    cells: dict[Ear, Cell] = field(default_factory=dict)
    real: str | None = None
    probability: float = 0.0  # the most confident dissenting hearing


def normalize(text: str) -> str:
    """Casefolded letters, digits and spaces only. For comparing hearings, never for display."""
    folded = unicodedata.normalize("NFKC", text).casefold()
    return " ".join(re.sub(r"[^\w\s]|_", " ", folded).split())


def english_output(ear: Ear) -> bool:
    return ear.language == "en" or ear.task == "translate"


def place_words(hearings: list[Hearing], probe: Probe) -> list[Placed]:
    placed: list[Placed] = []
    for hearing in hearings:
        to_source = time_map(hearing.ear.condition, probe)
        order = 0
        for line in hearing.lines:
            for word in line.words:
                start, _end = to_source(word.start, word.end)
                placed.append(Placed(hearing.ear, round(start, 3), word.text, word.probability, order))
                order += 1
    placed.sort(key=lambda p: p.start)  # stable: ties keep ear order
    return placed


def join_words(left: str, right: str) -> str:
    return left + right if right.startswith(" ") or not left else f"{left} {right}"


def windows(placed: list[Placed]) -> list[Window]:
    """Greedy windows: a word joins the current window if it starts within WINDOW of its first word."""
    result: list[Window] = []
    current: Window | None = None
    for word in placed:
        if current is None or word.start > current.start + WINDOW:
            current = Window(word.start)
            result.append(current)
        current.cells.setdefault(word.ear, Cell(word.ear)).words.append(word)
    return result


def hearing_key(text: str) -> str:
    """What two hearings are compared by: normalized words, or the raw symbol when there are none."""
    return normalize(text) or text.strip()


def judge(window: Window) -> tuple[bool, float]:
    """Do the English-output ears disagree here, and how sure is the surest dissenter?

    The most common hearing is the reference when something is heard more than
    once; every other hearing dissents. When all hearings differ, every one dissents.
    """
    cells = [c for c in window.cells.values() if english_output(c.ear) and c.text.strip()]
    texts = [hearing_key(c.text) for c in cells]
    if len(set(texts)) < 2:
        return False, 0.0
    top, count = Counter(texts).most_common(1)[0]
    plurality = top if count > 1 else None
    dissenters = [c for c, t in zip(cells, texts) if t != plurality]
    return True, max(c.probability for c in dissenters)


def reference_ear(hearings: list[Hearing]) -> Hearing | None:
    """The English ear that heard the most words: clean before degraded, en transcribe before translate."""
    candidates = [h for h in hearings if english_output(h.ear) and any(line.words for line in h.lines)]
    if not candidates:
        return None
    return max(candidates, key=lambda h: (
        h.ear.condition == "clean", h.ear.language == "en" and h.ear.task == "transcribe", sum(len(l.words) for l in h.lines),
    ))


def lyric_spans(reference: Hearing | None, lyrics: list[str], probe: Probe) -> list[tuple[float, float]]:
    """A time span per lyric line, from matching lyric words to the reference ear's words."""
    count = len(lyrics)
    if count == 0:
        return []
    times: dict[int, list[float]] = {}
    if reference is not None:
        to_source = time_map(reference.ear.condition, probe)
        ref_words = [  # a word that normalizes to several tokens ("It's" -> it, s) gives one entry per token
            (to_source(w.start, w.end)[0], token)
            for line in reference.lines for w in line.words for token in normalize(w.text).split()
        ]
        lyric_words = [(i, token) for i, line in enumerate(lyrics) for token in normalize(line).split()]
        matcher = SequenceMatcher(None, [w for _, w in lyric_words], [w for _, w in ref_words], autojunk=False)
        for a, b, size in matcher.get_matching_blocks():
            for k in range(size):
                times.setdefault(lyric_words[a + k][0], []).append(ref_words[b + k][0])
    spans: list[tuple[float, float] | None] = [
        (min(times[i]), max(times[i])) if i in times else None for i in range(count)
    ]
    # Lines with no matched word take an even share of the gap between their matched neighbours.
    filled: list[tuple[float, float]] = []
    for i, span in enumerate(spans):
        if span is not None:
            filled.append(span)
            continue
        prev_end = next((spans[j][1] for j in range(i - 1, -1, -1) if spans[j] is not None), 0.0)
        next_index = next((j for j in range(i + 1, count) if spans[j] is not None), None)
        next_start = spans[next_index][0] if next_index is not None else probe.duration
        gap_lines = (next_index if next_index is not None else count) - (i - 1 if any(spans[j] is not None for j in range(i)) else 0)
        first_unmatched = next(j for j in range(i, -1, -1) if j == 0 or spans[j - 1] is not None)
        unmatched_run = (next_index if next_index is not None else count) - first_unmatched
        share = (next_start - prev_end) / max(unmatched_run, 1)
        offset = i - first_unmatched
        filled.append((prev_end + share * offset, prev_end + share * (offset + 1)))
    return filled


def real_line_at(spans: list[tuple[float, float]], lyrics: list[str], at: float) -> str | None:
    if not spans:
        return None
    for span, line in zip(spans, lyrics):
        if span[0] - SLACK <= at <= span[1] + SLACK:
            return line
    nearest = min(range(len(spans)), key=lambda i: min(abs(at - spans[i][0]), abs(at - spans[i][1])))
    return lyrics[nearest]


def differs_from(real: str | None, text: str) -> bool:
    """A hearing differs when its words are not a run of whole words in the real line."""
    if real is None:
        return False
    heard = normalize(text).split()
    words = normalize(real).split()
    if not heard:
        return bool(text.strip())
    return not any(words[i:i + len(heard)] == heard for i in range(len(words) - len(heard) + 1))


def dissent(hearings: list[Hearing], probe: Probe, lyrics: list[str] | None) -> list[Window]:
    """Windows where the English-output ears disagree, most confident dissent first."""
    rows: list[Window] = []
    spans = lyric_spans(reference_ear(hearings), lyrics, probe) if lyrics else []
    for window in windows(place_words(hearings, probe)):
        disagree, probability = judge(window)
        if not disagree:
            continue
        window.probability = probability
        if lyrics:
            window.real = real_line_at(spans, lyrics, window.start)
        rows.append(window)
    rows.sort(key=lambda w: (-w.probability, w.start))
    return rows


def pile(hearings: list[Hearing]) -> list[str]:
    """Every distinct line once, in order of first occurrence. No ranking."""
    seen: set[str] = set()
    out: list[str] = []
    for hearing in hearings:
        for line in hearing.lines:
            text = line.text.strip()
            if text and text not in seen:
                seen.add(text)
                out.append(text)
    return out

"""sheet.md: the source, the grid, and one block per ear. Takes a list of hearings."""

from __future__ import annotations

from .audio import Probe
from .dissent import WINDOW, Window, differs_from, dissent, english_output, pile
from .ears import Ear, Hearing


def fmt_time(seconds: float) -> str:
    minutes, rest = divmod(max(seconds, 0.0), 60)
    return f"{int(minutes)}:{rest:05.2f}"


def column_key(hearing: Hearing) -> tuple[str, str, str]:
    ear = hearing.ear
    return (ear.model, ear.language, ear.task)


def column_title(key: tuple[str, str, str]) -> str:
    model, language, task = key
    arrow = "" if task == "transcribe" else " → en"
    return f"{model} · {language}{arrow}"


def render_grid(hearings: list[Hearing]) -> str:
    conditions: list[str] = []
    columns: list[tuple[str, str, str]] = []
    cells: dict[tuple[str, tuple[str, str, str]], int] = {}
    for hearing in hearings:
        if hearing.ear.condition not in conditions:
            conditions.append(hearing.ear.condition)
        key = column_key(hearing)
        if key not in columns:
            columns.append(key)
        cells[(hearing.ear.condition, key)] = len(hearing.lines)
    lines = ["| condition | " + " | ".join(column_title(c) for c in columns) + " |"]
    lines.append("|---|" + "|".join("---" for _ in columns) + "|")
    for condition in conditions:
        row = [str(cells[(condition, c)]) if (condition, c) in cells else "–" for c in columns]
        lines.append(f"| {condition} | " + " | ".join(row) + " |")
    return "\n".join(lines)


def render_source(name: str, probe: Probe, digest: str, hearings: list[Hearing], lyrics_name: str | None) -> str:
    channels = {1: "mono", 2: "stereo"}.get(probe.channels, f"{probe.channels} channels")
    parts = [
        f"# {name}",
        "",
        "## Source",
        "",
        f"- file: {name}",
        f"- sha256: {digest}",
        f"- duration: {probe.duration:.2f} s · {probe.sample_rate} Hz · {channels}",
        f"- ears: {len(hearings)}",
    ]
    if lyrics_name:
        parts.append(f"- lyrics: {lyrics_name}")
    parts += ["", render_grid(hearings)]
    return "\n".join(parts)


def render_ear(hearing: Hearing) -> str:
    parts = [f"### {hearing.ear.label}"]
    if hearing.note:
        parts.append(f"_{hearing.note}_")
    parts.append("")
    for line in hearing.lines:
        parts.append(f"- {fmt_time(line.start)}–{fmt_time(line.end)}  {line.text.strip()}")
    return "\n".join(parts)


def cell_text(text: str) -> str:
    return text.strip().replace("|", "\\|").replace("\n", " ")


def render_dissent(rows: list[Window], ears: list[Ear], with_lyrics: bool) -> str:
    parts = ["## Dissent"]
    if not rows:
        return "\n".join(parts)
    parts += [
        "",
        f"Words aligned on the source timeline (a word joins a window when it starts within {WINDOW:g} s "
        "of the window's first word; tape, helium and backwards ears are mapped back to source time). "
        "A row is a window where the English-output ears heard different things, surest dissent first; "
        "each cell shows what that ear heard and the mean word probability."
        + (" A hearing whose words are not in the real line is marked ≠." if with_lyrics else ""),
        "",
    ]
    columns = [e for e in ears if any(e in row.cells for row in rows)]
    header = ["time"] + (["real line"] if with_lyrics else []) + [e.label for e in columns]
    parts.append("| " + " | ".join(header) + " |")
    parts.append("|" + "|".join("---" for _ in header) + "|")
    for row in rows:
        cells = [fmt_time(row.start)]
        if with_lyrics:
            cells.append(cell_text(row.real or ""))
        for ear in columns:
            cell = row.cells.get(ear)
            if cell is None:
                cells.append("")
                continue
            mark = "≠ " if with_lyrics and english_output(ear) and differs_from(row.real, cell.text) else ""
            cells.append(f"{mark}{cell_text(cell.text)} ({cell.probability:.2f})")
        parts.append("| " + " | ".join(cells) + " |")
    return "\n".join(parts)


def render_pile(lines: list[str]) -> str:
    parts = ["## Pile"]
    if lines:
        parts.append("")
        parts += [f"- {cell_text(line)}" for line in lines]
    return "\n".join(parts)


def render_sheet(
    name: str,
    probe: Probe,
    digest: str,
    hearings: list[Hearing],
    lyrics: list[str] | None,
    lyrics_name: str | None,
) -> str:
    sections = [render_source(name, probe, digest, hearings, lyrics_name), "## Ears"]
    sections += [render_ear(h) for h in hearings]
    rows = dissent(hearings, probe, lyrics)
    sections.append(render_dissent(rows, [h.ear for h in hearings], bool(lyrics)))
    sections.append(render_pile(pile(hearings)))
    return "\n\n".join(sections).rstrip() + "\n"

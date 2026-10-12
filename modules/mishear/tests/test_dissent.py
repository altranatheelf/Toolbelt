import pytest

from mishear.audio import Probe
from mishear.cli import main
from mishear.conditions import time_map
from mishear.dissent import (
    differs_from, dissent, judge, lyric_spans, pile, place_words, real_line_at, windows,
)
from mishear.ears import Ear, Hearing, Line, Word

PROBE = Probe(sample_rate=16000, channels=1, duration=20.0, codec="pcm_s16le")


def hearing(condition, words, language="en", task="transcribe", model="tiny"):
    """words: (start, text, probability); one line holding them all."""
    ws = tuple(Word(s, s + 0.3, f" {t}", p) for s, t, p in words)
    line = Line(ws[0].start if ws else 0.0, ws[-1].end if ws else 0.0, "".join(w.text for w in ws), ws)
    return Hearing(Ear(condition, model, language, task), [line] if ws else [], None, [], {}, {})


def test_words_group_into_windows_by_start_within_0_6_s():
    a = hearing("clean", [(1.0, "light", 0.9), (2.0, "keeper", 0.8)])
    b = hearing("wall", [(1.5, "life", 0.6), (1.7, "of", 0.5), (2.4, "people", 0.7)])
    ws = windows(place_words([a, b], PROBE))
    assert [w.start for w in ws] == [1.0, 1.7, 2.4]  # 1.5 joins 1.0; 1.7 opens a window that 2.0 joins; 2.4 is past 1.7 + 0.6
    assert ws[0].cells[a.ear].text.strip() == "light" and ws[0].cells[b.ear].text.strip() == "life"
    assert ws[1].cells[b.ear].text.strip() == "of" and ws[1].cells[a.ear].text.strip() == "keeper"


def test_dissent_only_where_english_output_ears_differ():
    a = hearing("clean", [(1.0, "light", 0.9), (5.0, "kettle", 0.9)])
    b = hearing("wall", [(1.2, "life", 0.6), (5.1, "kettle", 0.7)])
    greek = hearing("clean", [(1.1, "φως", 0.8), (5.0, "κέτλ", 0.8)], language="el")
    rows = dissent([a, b, greek], PROBE, None)
    assert [r.start for r in rows] == [1.0]
    assert rows[0].probability == 0.9  # two hearings, no plurality: both dissent, the surer one counts
    assert rows[0].cells[greek.ear].text.strip() == "φως"
    radio = hearing("radio", [(1.0, "light", 0.8), (5.0, "kettle", 0.8)])
    rows = dissent([a, b, radio], PROBE, None)
    assert rows[0].probability == 0.6  # "light" twice is the plurality; "life" is the dissenter


def test_rows_sorted_by_probability_descending():
    a = hearing("clean", [(1.0, "light", 0.9), (5.0, "kettle", 0.9)])
    b = hearing("wall", [(1.0, "life", 0.3), (5.0, "cattle", 0.95)])
    rows = dissent([a, b], PROBE, None)
    assert [r.start for r in rows] == [5.0, 1.0]


def test_judge_without_plurality_counts_every_hearing():
    w = windows(place_words([
        hearing("clean", [(1.0, "light", 0.2)]),
        hearing("wall", [(1.0, "life", 0.5)]),
        hearing("radio", [(1.0, "lie", 0.4)]),
    ], PROBE))[0]
    assert judge(w) == (True, 0.5)


def test_backwards_tape_and_helium_words_map_to_source_time():
    assert time_map("backwards", PROBE)(2.0, 2.5) == (17.5, 18.0)
    assert time_map("tape", PROBE)(10.0, 11.0) == pytest.approx((9.3, 10.23))
    assert time_map("helium", PROBE)(10.0, 11.0) == pytest.approx((11.2, 12.32))
    assert time_map("rain", PROBE)(3.0, 4.0) == (3.0, 4.0)
    back = hearing("backwards", [(2.0, "ssenisub", 0.5)])
    assert place_words([back], PROBE)[0].start == 17.7


def test_pile_is_distinct_lines_in_first_occurrence_order():
    a = Hearing(Ear("clean", "tiny", "en"), [Line(0, 1, " Count the gulls.", ()), Line(1, 2, " Then again.", ())], None, [], {}, {})
    b = Hearing(Ear("wall", "tiny", "en"), [Line(0, 1, " Count the gulls.", ()), Line(1, 2, " Men again.", ())], None, [], {}, {})
    assert pile([a, b]) == ["Count the gulls.", "Then again.", "Men again."]


def test_lyrics_get_spans_from_the_reference_ear_and_mark_differing_hearings():
    lyrics = ["the lighthouse keeper mends a radio", "count the gulls"]
    clean = hearing("clean", [(1.0, "the", 0.9), (1.2, "lighthouse", 0.9), (1.8, "keeper", 0.9), (6.0, "count", 0.9), (6.3, "the", 0.9), (6.5, "gulls", 0.9)])
    spans = lyric_spans(clean, lyrics, PROBE)
    assert spans[0] == (1.0, 1.8) and spans[1] == (6.0, 6.5)
    assert real_line_at(spans, lyrics, 1.5) == lyrics[0]
    assert real_line_at(spans, lyrics, 6.1) == lyrics[1]
    assert real_line_at(spans, lyrics, 3.5) == lyrics[0]  # nearest span
    assert real_line_at(spans, lyrics, 4.5) == lyrics[1]
    assert differs_from(lyrics[0], " lighthouse") is False
    assert differs_from(lyrics[0], " life") is True
    unmatched = lyric_spans(clean, ["something else entirely"] + lyrics, PROBE)
    assert unmatched[0] == (0.0, 1.0) and unmatched[1] == (1.0, 1.8)


def test_sheet_has_dissent_and_pile_and_rebuilds_identically(standin, tmp_path):
    out = tmp_path / "sheets"
    assert main(["listen", str(standin), "--out", str(out)]) == 0
    sheet_path = out / standin.stem / "sheet.md"
    sheet = sheet_path.read_text(encoding="utf-8")
    assert "## Dissent" in sheet and "## Pile" in sheet
    assert "| time | real line |" in sheet, "standin.txt sits next to the fixture"
    dissent_rows = [l for l in sheet.split("## Dissent")[1].split("## Pile")[0].splitlines() if l.startswith("| 0:")]
    assert dissent_rows
    assert any("≠" in row for row in dissent_rows)
    pile_lines = [l for l in sheet.split("## Pile")[1].splitlines() if l.startswith("- ")]
    assert pile_lines and len(pile_lines) == len(set(pile_lines))
    assert main(["sheet", str(standin), "--out", str(out)]) == 0
    assert sheet_path.read_text(encoding="utf-8") == sheet

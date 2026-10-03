from ripper.select import choose_audio, choose_video, is_drc, format_table

# shapes as yt-dlp 2026.08 returns them; values typical of a YouTube music upload
YT = [
    {"format_id": "18", "acodec": "mp4a.40.2", "vcodec": "avc1.42001E", "abr": 96, "ext": "mp4", "format_note": "360p"},
    {"format_id": "139", "acodec": "mp4a.40.5", "vcodec": "none", "abr": 48, "asr": 22050, "audio_channels": 2, "ext": "m4a", "format_note": "low"},
    {"format_id": "140", "acodec": "mp4a.40.2", "vcodec": "none", "abr": 129, "asr": 44100, "audio_channels": 2, "ext": "m4a", "format_note": "medium", "language": "en", "language_preference": 10},
    {"format_id": "140-drc", "acodec": "mp4a.40.2", "vcodec": "none", "abr": 129, "asr": 44100, "audio_channels": 2, "ext": "m4a", "format_note": "medium, DRC"},
    {"format_id": "251", "acodec": "opus", "vcodec": "none", "abr": 142, "asr": 48000, "audio_channels": 2, "ext": "webm", "format_note": "medium", "language": "en", "language_preference": 10},
    {"format_id": "251-drc", "acodec": "opus", "vcodec": "none", "abr": 142, "asr": 48000, "audio_channels": 2, "ext": "webm", "format_note": "medium, DRC"},
    {"format_id": "251-1", "acodec": "opus", "vcodec": "none", "abr": 142, "asr": 48000, "audio_channels": 2, "ext": "webm", "format_note": "medium, dubbed-auto", "language": "es", "language_preference": -10},
    {"format_id": "137", "acodec": "none", "vcodec": "avc1.640028", "height": 1080, "fps": 30, "ext": "mp4", "tbr": 4000},
    {"format_id": "248", "acodec": "none", "vcodec": "vp9", "height": 1080, "fps": 30, "ext": "webm", "tbr": 2500},
    {"format_id": "399", "acodec": "none", "vcodec": "av01.0.08M.08", "height": 1080, "fps": 30, "ext": "mp4", "tbr": 2000},
]


def test_never_drc_prefers_opus_and_original_track():
    ch = choose_audio(YT)
    assert ch.fmt["format_id"] == "251"
    assert not is_drc(ch.fmt) and not ch.warnings
    joined = " ".join(ch.why)
    assert "audio-only" in joined and "not a DRC" in joined and "Opus" in joined and "original language" in joined


def test_premium_opus_wins_when_present():
    fs = YT + [{"format_id": "774", "acodec": "opus", "vcodec": "none", "abr": 256, "asr": 48000, "audio_channels": 2, "ext": "webm", "format_note": "Premium"}]
    ch = choose_audio(fs)
    assert ch.fmt["format_id"] == "774" and any("Premium" in w for w in ch.why)


def test_only_drc_is_loud():
    fs = [f for f in YT if f.get("vcodec") == "none" and is_drc(f)]
    ch = choose_audio(fs)
    assert ch.fmt["format_id"] == "251-drc" and any("ONLY DRC" in w for w in ch.warnings)


def test_muxed_only_falls_back_with_a_warning():
    ch = choose_audio([YT[0]])
    assert ch.fmt["format_id"] == "18" and any("muxed" in w for w in ch.warnings)


def test_original_lossless_upload_wins_outright():
    ia = [{"format_id": "0", "acodec": "vorbis", "vcodec": "none", "abr": 112, "ext": "ogg", "format_note": "derivative"},
          {"format_id": "1", "acodec": "flac", "vcodec": "none", "ext": "flac", "format_note": "original"},
          {"format_id": "2", "acodec": "mp3", "vcodec": "none", "abr": 320, "ext": "mp3", "format_note": "derivative"}]
    ch = choose_audio(ia)
    assert ch.fmt["format_id"] == "1" and any("lossless" in w for w in ch.why)


def test_video_pick_and_table():
    v = choose_video(YT)
    assert v["format_id"] == "399", "AV1 over VP9 over H.264 at equal resolution and fps"
    t = format_table(YT, "251")
    assert "-> " in t and "yes" in t and "muxed" in t

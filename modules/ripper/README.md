# Ripper

Local audio/video capture with provenance, for pulling references and samples into a DAW. Wraps yt-dlp and ffmpeg. Two goals, in order: the highest-fidelity stream that actually exists for a piece of content, and a record of where it came from. Licence: AGPL-3.0.

Runs on your computer only. Nothing is hosted; the planned UI binds to 127.0.0.1.

## Install (macOS)

```
brew install ffmpeg deno            # ffmpeg with libsoxr; deno runs YouTube's player code for yt-dlp
cd modules/ripper
python3 -m venv .venv && . .venv/bin/activate
pip install -e .
ripper check                        # ffmpeg/ffprobe/libsoxr and yt-dlp versions
```

## In the Toolbelt app

Ripper is a module on the Toolbelt launcher. Its page is the controls; the work runs in the engine on your computer:

```
ripper serve            # 127.0.0.1:8765, local only; opens the page and keeps running until Ctrl-C
```

Open Ripper from the Toolbelt launcher (or at http://127.0.0.1:8765/). Paste a URL, **Look** to see every format with DRC flagged and the pick explained, choose the output, **Capture**. Past captures with their quality reports are listed below. The phone app shows the module but cannot run the engine.

## Use (command line)

```
ripper formats <url>                               # every audio format, DRC flagged, and which one the rules pick, with reasons
ripper <url>                                       # native: the chosen stream's bytes, container fixed only if needed (zero generation loss)
ripper <url> wav                                   # 32-bit float at the source rate, quality report in the sidecar
ripper <url> flac --bits 24                        # 24-bit; warns if decoded audio exceeds 0 dBFS
ripper <url> wav --bits 16                         # TPDF dither, noted in the sidecar
ripper <url> wav --rate 44100                      # resample with soxr precision 28 (only when asked)
ripper <url> wav --section 1:23-2:10 --section 3:00-3:05   # sample-accurate cuts, 10 ms handles (--handles 0)
ripper <url> video                                 # best video + best audio, remuxed to MKV, no re-encode
ripper <url> --cookies-from-browser safari         # your own signed-in account: needed for YouTube today, exposes Premium audio
ripper <playlist-url> --playlist --archive done.txt # batches; reruns fetch only new items; manifest.json
ripper verify captures/                            # re-hash every capture against its sidecar
ripper update                                      # upgrade yt-dlp in place and smoke-test it
```

Outputs go to `./captures/` as `YYYY-MM-DD_<uploader>_<title>_<id>.<ext>` with `<name>.<ext>.json`, `<name>.<ext>.txt` and the thumbnail next to them. Core tags (title, artist = uploader, date, comment = source URL) are embedded in the media file.

## Stream selection

1. Audio-only streams over muxed.
2. Never a DRC (dynamic-range-compressed) variant unless nothing else exists; then it says so loudly.
3. The original language track over auto-dubs.
4. Opus over AAC at comparable bitrates; higher bitrate within a codec; Premium ~256 kbps when cookies expose it.
5. An original or lossless upload (Internet Archive originals, SoundCloud originals) wins outright.

The description and the uploader's links are scanned for Bandcamp, SoundCloud and Internet Archive URLs; matches are reported as "better source?", never acted on.

## Quality report (wav/flac, `--no-analyze` to skip)

Source codec, bitrate, rate, layout and DRC flag; integrated LUFS, loudness range, true peak, sample peak and the count of samples over 0 dBFS; effective bandwidth as a shelf relative to the mid-band (a shelf near 16 kHz usually means a lossy stage upstream; 19–20 kHz is normal for a platform encode); near-mono detection from side/mid energy. Nothing is applied to the audio: no normalisation, limiting or loudness processing, ever.

## Notes

- YouTube from a data centre is refused ("sign in to confirm you're not a bot"); from your own machine with `--cookies-from-browser` it works. This repo's tests therefore use recorded format lists and Creative Commons items on the Internet Archive.
- Tests: `pytest` (synthetic audio only, no third-party media in the repo).
- Phase 2 (localhost UI with waveform sections and a capture browser) is not built yet.

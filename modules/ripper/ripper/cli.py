"""ripper: local capture with provenance. `ripper <url> [native|wav|flac|mp3|video] [options]`,
`ripper formats <url>`, `ripper verify <folder>`, `ripper check`, `ripper update`."""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from . import __version__
from .tools import ToolsMissing, check_tools, ffmpeg_path

MODES = ("native", "wav", "flac", "mp3", "video")


def _ytdlp():
    try:
        import yt_dlp  # noqa: WPS433
    except ImportError:
        sys.exit("yt-dlp is not installed. Run:  pip install -e .   (or  ripper update)")
    return yt_dlp


def _ydl_opts(args, download: bool) -> dict:
    opts = {"quiet": True, "noprogress": True, "no_warnings": False, "noplaylist": not getattr(args, "playlist", False), "skip_download": not download}
    if getattr(args, "cookies_from_browser", None):
        parts = args.cookies_from_browser.split(":", 1)
        opts["cookiesfrombrowser"] = (parts[0],) + ((parts[1],) if len(parts) > 1 else ())
    if getattr(args, "archive", None):
        opts["download_archive"] = args.archive
    return opts


def extract(args, url: str) -> dict:
    yt_dlp = _ytdlp()
    try:
        with yt_dlp.YoutubeDL(_ydl_opts(args, download=False)) as y:
            info = y.extract_info(url, download=False)
    except yt_dlp.utils.DownloadError as e:
        msg = str(e)
        hint = ""
        if "Sign in to confirm" in msg or "bot" in msg:
            hint = "\nYouTube wants a signed-in browser: add  --cookies-from-browser safari  (or chrome/firefox). Uses your own account."
        if "JavaScript runtime" in msg or "js-runtimes" in msg:
            hint += "\nInstall deno (brew install deno) so yt-dlp can run YouTube's player code."
        if "Unsupported URL" in msg or "HTTP Error 4" in msg:
            hint += "\nIf this used to work, yt-dlp may be out of date: run  ripper update"
        sys.exit(f"extraction failed: {msg}{hint}")
    if info.get("_type") == "playlist" and info.get("entries"):
        return info
    return info


def cmd_formats(args) -> int:
    from .select import choose_audio, choose_video, describe, format_table
    info = extract(args, args.url)
    entries = info.get("entries") if info.get("_type") == "playlist" else [info]
    for e in entries or []:
        fs = e.get("formats") or []
        ch = choose_audio(fs)
        print(f"\n{e.get('title')}  ·  {e.get('extractor_key')} {e.get('id')}  ·  license: {e.get('license') or 'not reported'}")
        print(format_table(fs, ch.fmt.get("format_id") if ch else None))
        if ch:
            print("\nwould pick:", describe(ch.fmt))
            for w in ch.why:
                print("  because:", w)
            for w in ch.warnings:
                print("  WARNING:", w)
        v = choose_video(fs)
        if v:
            print(f"video mode would pick: {v.get('format_id')} {v.get('width')}x{v.get('height')} {v.get('fps')}fps {v.get('vcodec')} {v.get('dynamic_range') or ''}")
        _better(e)
    return 0


def _better(info: dict) -> list[dict]:
    from .sources import find_better_sources, notice_lines
    links = [info.get("uploader_url"), info.get("channel_url")] + [str(x) for x in (info.get("external_urls") or [])]
    found = find_better_sources(info.get("description"), links)
    for line in notice_lines(found):
        print("  BETTER SOURCE?", line)
    return found


def cmd_rip(args) -> int:
    from . import analysis, convert, provenance, select
    yt_dlp = _ytdlp()
    try:
        tools = check_tools()
    except ToolsMissing as e:
        sys.exit(str(e))
    info = extract(args, args.url)
    entries = info.get("entries") if info.get("_type") == "playlist" else [info]
    out_dir = Path(args.out).expanduser()
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest = []
    for e in entries or []:
        if not e:
            continue
        manifest.append(_rip_one(args, e, out_dir, tools, yt_dlp))
    if len(manifest) > 1:
        (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        print(f"\nmanifest: {out_dir / 'manifest.json'}")
    return 0


def _rip_one(args, info: dict, out_dir: Path, tools: dict, yt_dlp) -> dict:
    from . import analysis, convert, provenance, select
    fs = info.get("formats") or []
    warnings: list[str] = []
    if args.mode == "video":
        v = select.choose_video(fs)
        a = select.choose_audio(fs)
        if not v or not a:
            sys.exit("no usable video/audio streams")
        fmt_spec = f"{v['format_id']}+{a.fmt['format_id']}"
        chosen, why = a.fmt, [f"video {v.get('format_id')} {v.get('height')}p {v.get('fps')}fps {v.get('vcodec')}"] + a.why
        warnings += a.warnings
    else:
        a = select.choose_audio(fs)
        if not a:
            sys.exit("no audio streams found")
        fmt_spec, chosen, why = a.fmt["format_id"], a.fmt, a.why
        warnings += a.warnings
    for w in a.warnings:
        print("WARNING:", w)
    print("chosen:", select.describe(chosen))
    for w in why:
        print("  because:", w)
    better = _better(info)

    base = provenance.capture_name(info.get("upload_date"), info.get("uploader") or info.get("channel"), info.get("title"), info.get("id"))
    tmp = Path(tempfile.mkdtemp(prefix="ripper-"))
    opts = _ydl_opts(args, download=True)
    opts.update({"format": fmt_spec, "outtmpl": str(tmp / "stream.%(ext)s"), "writethumbnail": True,
                 "postprocessors": [], "merge_output_format": "mkv" if args.mode == "video" else None})
    if opts["merge_output_format"] is None:
        del opts["merge_output_format"]
    with yt_dlp.YoutubeDL(opts) as y:
        y.process_ie_result(dict(info), download=True)
    stream = next((p for p in tmp.iterdir() if p.name.startswith("stream.") and p.suffix.lower() not in (".jpg", ".jpeg", ".png", ".webp")), None)
    if not stream:
        sys.exit("download produced no file")
    thumb = next((p for p in tmp.iterdir() if p.suffix.lower() in (".jpg", ".jpeg", ".png", ".webp")), None)
    meta = ["-metadata", f"title={info.get('title') or ''}", "-metadata", f"artist={info.get('uploader') or info.get('channel') or ''}",
            "-metadata", f"date={info.get('upload_date') or ''}", "-metadata", f"comment=source {info.get('webpage_url') or args.url}"]
    processing: dict = {"normalized": False}
    quality = None
    sections = [convert.parse_section(s) for s in (args.section or [])]
    if args.mode == "native":
        # keep the chosen stream's bytes; only the container is fixed (webm/mkv audio -> .opus/.ogg, else as is)
        ext = stream.suffix.lower()
        acodec = str(chosen.get("acodec") or "").lower()
        target_ext = ".opus" if ext in (".webm", ".mkv") and acodec.startswith("opus") else ".ogg" if ext in (".webm", ".mkv") else ext
        out = out_dir / (base + target_ext)
        subprocess.run([ffmpeg_path(), "-v", "error", "-y", "-i", str(stream), "-map", "0:a:0", "-c", "copy"] + meta + [str(out)], check=True)
        processing["remuxed"] = f"{ext} -> {target_ext}" if target_ext != ext else None
        if sections:
            warnings.append("--section is ignored in native mode (cuts need decoding); use wav or flac")
    elif args.mode == "video":
        out = out_dir / (base + ".mkv")
        subprocess.run([ffmpeg_path(), "-v", "error", "-y", "-i", str(stream), "-map", "0", "-c", "copy"] + meta + [str(out)], check=True)
    else:
        out = out_dir / (base + "." + args.mode)
        decoded, sr = analysis.decode_float(stream)
        r = convert.convert(stream, out, args.mode, bits=("float" if args.bits == "float" else int(args.bits)), rate=args.rate,
                            sections=sections or None, handles_ms=args.handles, decoded=decoded, src_rate=sr)
        processing.update(r.processing)
        warnings += r.warnings
        for w in r.warnings:
            print("WARNING:", w)
        if args.analyze:
            quality = analysis.report_dict(analysis.analyze(stream, decoded, sr))
            sf = analysis.probe(stream)
            quality["source"] = {"codec": sf.codec, "bitrate_kbps": sf.bitrate_kbps, "sample_rate": sf.sample_rate, "channels": sf.channels,
                                 "channel_layout": sf.channel_layout, "drc": select.is_drc(chosen)}
            print(f"quality: {quality['integrated_lufs']} LUFS, range {quality['loudness_range_lu']} LU, true peak {quality['true_peak_dbtp']} dBTP, "
                  f"sample peak {quality['sample_peak_dbfs']} dBFS, overs {quality['samples_over_0dbfs']}")
            print(f"         bandwidth ~{quality['bandwidth_hz']} Hz: {quality['bandwidth_note']}")
            print(f"         {quality['stereo_note']}")
        # tags into the new file (metadata only; the audio was written by convert)
        tagged = out.with_name(out.stem + ".tagged" + out.suffix)
        subprocess.run([ffmpeg_path(), "-v", "error", "-y", "-i", str(out), "-c", "copy"] + meta + [str(tagged)], check=True)
        tagged.replace(out)
    thumb_out = None
    if thumb:
        thumb_out = out_dir / (base + thumb.suffix.lower())
        shutil.copyfile(thumb, thumb_out)
    chosen = dict(chosen, _drc=select.is_drc(chosen))
    sc = provenance.build_sidecar(info=info, output=out, chosen=chosen, selection_reason=why, mode=args.mode, tool_version=__version__,
                                  ytdlp_version=yt_dlp.version.__version__, quality=quality, processing=processing,
                                  sections=[{"start": s, "end": e, "handles_ms": args.handles} for (s, e) in sections] if args.mode in ("wav", "flac", "mp3") else None,
                                  better_sources=better, thumbnail=thumb_out.name if thumb_out else None, warnings=warnings)
    j, t = provenance.write_sidecars(sc, out)
    shutil.rmtree(tmp, ignore_errors=True)
    print(f"\nwrote {out}\n      {j.name}, {t.name}" + (f", {thumb_out.name}" if thumb_out else ""))
    return {"file": out.name, "sidecar": j.name, "id": info.get("id"), "title": info.get("title")}


def cmd_verify(args) -> int:
    from .provenance import verify_folder
    res = verify_folder(Path(args.folder))
    bad = 0
    for r in res:
        print(f"{r['status']:>9}  {r['detail']}")
        bad += r["status"] != "ok"
    print(f"{len(res) - bad} ok, {bad} not ok")
    return 1 if bad else 0


def cmd_check(args) -> int:
    try:
        t = check_tools()
    except ToolsMissing as e:
        print(str(e))
        return 1
    yt = _ytdlp()
    print(f"ffmpeg {t['ffmpeg']}  libsoxr={t['libsoxr']} libopus={t['libopus']} libmp3lame={t['libmp3lame']}")
    print(f"yt-dlp {yt.version.__version__}  ·  ripper {__version__}")
    return 0


def cmd_update(args) -> int:
    print("upgrading yt-dlp in this environment…")
    r = subprocess.run([sys.executable, "-m", "pip", "install", "--upgrade", "yt-dlp"], capture_output=True, text=True)
    print(r.stdout[-800:] if r.returncode == 0 else r.stderr[-800:])
    if r.returncode:
        return 1
    print("smoke test: extracting a Creative Commons item from the Internet Archive…")
    import importlib
    import yt_dlp
    importlib.reload(yt_dlp)
    try:
        with yt_dlp.YoutubeDL({"quiet": True, "skip_download": True}) as y:
            info = y.extract_info("https://archive.org/details/BigBuckBunny_124", download=False)
        print(f"ok: yt-dlp {yt_dlp.version.__version__} extracted '{info.get('title')}' with {len(info.get('formats') or [])} formats")
        return 0
    except Exception as e:  # noqa: BLE001
        print("smoke test FAILED:", e)
        return 1


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="ripper", description="Local audio/video capture with provenance (yt-dlp + ffmpeg).")
    sub = p.add_subparsers(dest="cmd")
    f = sub.add_parser("formats", help="list every audio format and the one the rules would pick")
    f.add_argument("url")
    f.add_argument("--cookies-from-browser", help="browser[:profile], e.g. safari, chrome, firefox (your own account)")
    f.add_argument("--playlist", action="store_true")
    f.set_defaults(fn=cmd_formats)
    v = sub.add_parser("verify", help="re-hash a folder's captures against their sidecars")
    v.add_argument("folder")
    v.set_defaults(fn=cmd_verify)
    sub.add_parser("check", help="check ffmpeg/ffprobe/libsoxr and yt-dlp").set_defaults(fn=cmd_check)
    sub.add_parser("update", help="upgrade yt-dlp in place and smoke-test it").set_defaults(fn=cmd_update)
    sv = sub.add_parser("serve", help="run the local engine for the Toolbelt Ripper module (127.0.0.1 only)")
    sv.add_argument("--port", type=int, default=8765)
    sv.add_argument("--captures", default="captures")
    sv.add_argument("--no-open", dest="open_browser", action="store_false")
    sv.set_defaults(fn=lambda a: (__import__("ripper.serve", fromlist=["serve"]).serve(a.port, a.captures, a.open_browser), 0)[1])
    r = sub.add_parser("rip", help="capture (default command: `ripper <url> [mode]`)")
    _rip_args(r)
    r.set_defaults(fn=cmd_rip)
    return p


def _rip_args(r: argparse.ArgumentParser) -> None:
    r.add_argument("url")
    r.add_argument("mode", nargs="?", choices=MODES, default="native")
    r.add_argument("--out", default="captures", help="output folder (default ./captures)")
    r.add_argument("--rate", type=int, help="resample to this rate with soxr (default: keep the source rate)")
    r.add_argument("--bits", choices=["float", "24", "16"], default="float", help="wav/flac word length (default float32)")
    r.add_argument("--section", action="append", help="time range like 1:23-2:10 (repeatable; wav/flac/mp3)")
    r.add_argument("--handles", type=float, default=10.0, help="ms added each side of a section (default 10)")
    r.add_argument("--no-analyze", dest="analyze", action="store_false", help="skip the quality report")
    r.add_argument("--cookies-from-browser", help="browser[:profile], e.g. safari, chrome, firefox (your own account)")
    r.add_argument("--archive", help="yt-dlp download-archive file: reruns fetch only new items")
    r.add_argument("--playlist", action="store_true", help="allow playlists/channels (batch with manifest.json)")


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and argv[0] not in ("formats", "verify", "check", "update", "serve", "rip", "-h", "--help"):
        argv = ["rip"] + argv
    p = build_parser()
    args = p.parse_args(argv)
    if not getattr(args, "fn", None):
        p.print_help()
        return 1
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())

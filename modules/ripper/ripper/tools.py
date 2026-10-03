"""Locating ffmpeg/ffprobe and checking the build, with install instructions when missing."""
from __future__ import annotations

import os
import platform
import shutil
import subprocess


class ToolsMissing(RuntimeError):
    pass


def ffmpeg_path() -> str:
    return os.environ.get("RIPPER_FFMPEG") or shutil.which("ffmpeg") or "ffmpeg"


def ffprobe_path() -> str:
    return os.environ.get("RIPPER_FFPROBE") or shutil.which("ffprobe") or "ffprobe"


def install_hint() -> str:
    sysname = platform.system()
    if sysname == "Darwin":
        return "Install with Homebrew:  brew install ffmpeg   (Homebrew's ffmpeg is built with libsoxr)"
    if sysname == "Linux":
        return "Install with your package manager, e.g.  sudo apt install ffmpeg   (Debian/Ubuntu builds include libsoxr)"
    return "Install ffmpeg from https://ffmpeg.org/download.html and make sure it is on PATH"


def check_tools() -> dict:
    """Return facts about ffmpeg/ffprobe or raise ToolsMissing with install instructions."""
    for name, path in (("ffmpeg", ffmpeg_path()), ("ffprobe", ffprobe_path())):
        if not shutil.which(path) and not os.path.exists(path):
            raise ToolsMissing(f"{name} not found. {install_hint()}")
    out = subprocess.run([ffmpeg_path(), "-version"], capture_output=True, text=True).stdout
    first = out.splitlines()[0] if out else ""
    soxr = "--enable-libsoxr" in out
    if not soxr:
        raise ToolsMissing("ffmpeg is installed but not built with libsoxr (needed for high-quality resampling). " + install_hint())
    return {"ffmpeg": first.replace("ffmpeg version ", "").split(" ")[0], "libsoxr": soxr,
            "libopus": "--enable-libopus" in out, "libmp3lame": "--enable-libmp3lame" in out}

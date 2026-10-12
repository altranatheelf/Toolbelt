"""mishear listen | ears | sheet"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import __version__
from .audio import require_ffmpeg
from .config import load_config
from .run import collect_sources, grid, listen_source, rebuild_sheet


def add_grid_flags(parser: argparse.ArgumentParser) -> None:
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--quick", action="store_true", help="clean, wall and sideways with the quick model, English only")
    group.add_argument("--all", action="store_true", help="every condition × every model × every language and task")
    parser.add_argument("--deep", action="store_true", help="also run the deep models (medium)")


def mode_of(args: argparse.Namespace) -> str:
    if args.quick:
        return "quick"
    if args.all:
        return "all"
    return "default"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="mishear", description="Feed audio to speech models under bad listening conditions and keep what they heard.")
    parser.add_argument("--version", action="version", version=f"mishear {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    listen = sub.add_parser("listen", help="listen to a file or every audio file in a folder")
    listen.add_argument("path", type=Path)
    add_grid_flags(listen)
    listen.add_argument("--keep", action="store_true", help="keep the degraded versions in sheets/<name>/degraded/")
    listen.add_argument("--out", type=Path, default=Path("sheets"), help="sheets root (default ./sheets)")

    ears = sub.add_parser("ears", help="list the ears a grid would use")
    add_grid_flags(ears)

    sheet = sub.add_parser("sheet", help="rewrite sheet.md for a source from its saved ears")
    sheet.add_argument("path", type=Path, help="the source file, or its sheets/<name> folder")
    sheet.add_argument("--out", type=Path, default=Path("sheets"))
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    config = load_config()
    if args.command == "ears":
        for ear in grid(config, mode_of(args), args.deep):
            print(ear.label)
        return 0
    if args.command == "listen":
        require_ffmpeg()
        ears = grid(config, mode_of(args), args.deep)
        sources = collect_sources(args.path)
        if not sources:
            print(f"no audio files in {args.path}", file=sys.stderr)
            return 1
        for source in sources:
            outdir = listen_source(source, ears, config, args.out, keep=args.keep)
            print(outdir / "sheet.md")
        return 0
    if args.command == "sheet":
        sheet_dir = args.path if args.path.is_dir() else args.out / args.path.stem
        if not (sheet_dir / "sidecar.json").exists():
            print(f"no sidecar.json in {sheet_dir}; run `mishear listen` first", file=sys.stderr)
            return 1
        print(rebuild_sheet(sheet_dir))
        return 0
    return 1


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())

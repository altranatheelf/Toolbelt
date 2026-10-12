"""An ear is (condition, model, language, task). One function listens with one ear."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .config import Config

ENGLISH = "en"

# Decoding is fixed so that the same input gives the same sheet: beam search at
# temperature 0 (no sampling, so no seed is drawn), no fallback temperatures, no
# conditioning on the previous window, no voice-activity filter. Silence is left
# to the model's own no-speech gate alone (log_prob_threshold=None), which drops a
# window the model itself rates as no speech instead of letting a logprob
# override keep it.
DECODE: dict = {
    "beam_size": 5,
    "best_of": 1,
    "temperature": 0.0,
    "condition_on_previous_text": False,
    "word_timestamps": True,
    "vad_filter": False,
    "no_speech_threshold": 0.6,
    "log_prob_threshold": None,
    "compression_ratio_threshold": None,
}


@dataclass(frozen=True)
class Ear:
    condition: str
    model: str
    language: str
    task: str = "transcribe"

    @property
    def name(self) -> str:
        """File-safe: a model given as a Hugging Face repo id has a slash."""
        return f"{self.condition}.{self.model.replace('/', '_')}.{self.language}.{self.task}"

    @property
    def label(self) -> str:
        arrow = "" if self.task == "transcribe" else " → en"
        return f"{self.condition} · {self.model} · {self.language}{arrow}"


@dataclass(frozen=True)
class Word:
    start: float
    end: float
    text: str
    probability: float


@dataclass(frozen=True)
class Line:
    start: float
    end: float
    text: str
    words: tuple[Word, ...]


@dataclass
class Hearing:
    """What one ear heard, with everything needed to reproduce it."""

    ear: Ear
    lines: list[Line]
    filter_graph: str | None
    ffmpeg_args: list[str]
    decode: dict
    model: dict
    note: str | None = None
    degraded_file: str | None = None


def load_model(size: str, config: Config):
    """Load a faster-whisper model (downloaded once into the Hugging Face cache)."""
    import ctranslate2
    from faster_whisper import WhisperModel, __version__ as fw_version
    from faster_whisper.utils import download_model

    try:
        from faster_whisper.utils import _MODELS
        repo = _MODELS.get(size, size)
    except ImportError:  # pragma: no cover
        repo = size
    try:
        path = Path(download_model(size, local_files_only=True))  # cached: no network
    except Exception:
        path = Path(download_model(size))  # first run: download once into the Hugging Face cache
    snapshot = path.name if path.parent.name == "snapshots" else None
    model = WhisperModel(
        str(path), device="cpu", compute_type=config.compute_type, cpu_threads=config.cpu_threads,
    )
    info = {
        "engine": "faster-whisper",
        "faster_whisper": fw_version,
        "ctranslate2": ctranslate2.__version__,
        "size": size,
        "repo": repo,
        "snapshot": snapshot,
        "device": "cpu",
        "compute_type": config.compute_type,
        "cpu_threads": config.cpu_threads,
    }
    return model, info


def decode_params(ear: Ear, config: Config) -> dict:
    return {**DECODE, "beam_size": config.beam_size, "language": ear.language, "task": ear.task}


def listen(model, audio: np.ndarray, ear: Ear, config: Config) -> list[Line]:
    """Run one ear over 16 kHz mono float32 audio. Output is kept exactly as heard."""
    import ctranslate2

    ctranslate2.set_random_seed(config.seed)  # nothing samples at temperature 0; set anyway and recorded
    params = decode_params(ear, config)
    segments, _info = model.transcribe(audio, **params)
    lines: list[Line] = []
    for segment in segments:
        words = tuple(
            Word(round(w.start, 3), round(w.end, 3), w.word, round(float(w.probability), 4))
            for w in (segment.words or ())
        )
        lines.append(Line(round(segment.start, 3), round(segment.end, 3), segment.text, words))
    return lines

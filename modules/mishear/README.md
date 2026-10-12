# mishear

A local command-line mondegreen generator. It feeds audio to speech-recognition
models under bad listening conditions and keeps what they heard. It composes
nothing: every line it outputs was produced by a speech model hearing audio.
No LLM calls, no network at runtime.

Python 3.12, macOS on Apple Silicon, ffmpeg from Homebrew. AGPL-3.0.

## Install

```sh
brew install ffmpeg
cd modules/mishear
python3.12 -m venv .venv
.venv/bin/pip install -e '.[dev]'
.venv/bin/mishear listen path/to/recording.wav
```

Models download once on first run into `~/.cache/huggingface/hub`
(Systran's CTranslate2 conversions of Whisper). After that the tool is offline.
If ffmpeg or ffprobe is missing, `mishear` prints the `brew install ffmpeg`
command and exits with status 2.

## Which speech library, and why

**faster-whisper** (CTranslate2), on CPU, int8. Both READMEs were read on
2026-10-12 (faster-whisper 1.2.1 / ctranslate2 4.8.2; whisper.cpp 1.9.5).

- Apple Silicon support is not worse, it is just slower. CTranslate2 ships
  native macOS arm64 wheels for every CPython from 3.9 to 3.14, built on Apple
  Accelerate (float32) and Ruy (int8). There is no Metal, Core ML or Neural
  Engine backend and none is planned; the macOS wheels are CPU-only.
  whisper.cpp runs the whole model on the GPU through Metal by default and can
  put the encoder on the Neural Engine through Core ML, so it is several times
  faster on the same Mac. For 20-second clips through tiny/base/small that
  speed is not needed; the deciding factors are the next two.
- Word probabilities come straight out of faster-whisper's Python API:
  `transcribe(..., word_timestamps=True)` returns segments whose `words` carry
  `start`, `end`, `word` and `probability`. The Dissent table is sorted by
  exactly that number. whisper.cpp exposes token probabilities in its C API
  (`whisper_full_get_token_p`) and in `whisper-cli -ojf`, but its Python
  bindings (pywhispercpp 1.5.1) give one probability per segment (the
  geometric mean of its tokens, with `extract_probability=True`); per-word
  values would have to be assembled from tokens by hand.
- Determinism is a plain parameter set: beam search at temperature 0 with a
  single temperature, so there is no fallback ladder and no sampling. The
  whole decode is reproducible from the recorded parameters on one machine.
- Everything is Python: one package, one venv, no CMake, no model conversion
  step (whisper.cpp needs its own ggml files, and Core ML needs a separate
  encoder build).

The audio never goes through faster-whisper's own decoder (PyAV): ffmpeg
renders each listening condition to 16 kHz mono PCM, and the samples go to
the model as a numpy array. That keeps the exact ffmpeg filter string as the
one and only description of what the model heard.

## Ears

An ear is (condition, model, language, task). Conditions, each an ffmpeg
filter applied to the source before the model hears it:

| condition | filter |
|---|---|
| clean | none |
| wall | `lowpass=f=800` |
| radio | `highpass=f=300,lowpass=f=3400,acompressor` |
| tape | `asetrate=<sr×0.93>,aresample=<sr>` |
| helium | `asetrate=<sr×1.12>,aresample=<sr>` |
| rain | pink noise mixed in at −12 dB (`anoisesrc` + `amix`) |
| sideways | side channel only, `pan=mono\|c0=0.5*c0-0.5*c1` |
| backwards | `areverse` |
| crushed | `acrusher=bits=6:mix=0` (mix=0 is the fully crushed side of acrusher's bit reduction) |

Models: tiny, base, small by default; medium behind `--deep`. Languages:
English, plus the forced languages in the config (default `el`, `ro`), each
heard as `transcribe` (native script) and `translate` (into English).

Grids:

- default: every condition × {base, small} × en, plus clean and wall × small ×
  each forced language (both tasks)
- `--quick`: clean, wall, sideways × base × en
- `--all`: everything: every condition × {tiny, base, small} × every language and task
- `--deep`: adds medium to whichever grid is running

## Output

Per source, in `./sheets/<name>/` (or `--out DIR`):

- `sheet.md`: the source and the grid; one block per ear with timestamped
  lines; the Dissent table; the Pile
- `sidecar.json`: source path and SHA-256, duration, model repo + snapshot
  hash + library versions, the exact ffmpeg argv and filter graph per ear,
  language and task, seed, decode parameters, tool version, timestamp
- `ears/<ear>.txt` and `ears/<ear>.json`: what each ear heard, with word
  timestamps and probabilities
- `degraded/<condition>.wav`: only with `--keep`; otherwise the degraded
  versions are temp files and are deleted

### Dissent

Words are aligned across ears by time, never by string matching. Each word is
placed on the source timeline (tape and helium words divided back by their
rate, backwards words reversed), and a word joins a window when it starts
within 0.6 s of the window's first word. A window is a Dissent row when the
ears that output English (the `en` ears and every `translate` ear) heard
different things there; native-script hearings are shown in the row but do
not decide it. The most common hearing in a window is the reference when
something was heard more than once; every other hearing dissents, and the
row's probability is the surest dissenter's mean word probability. Rows are
sorted by that, descending.

A `.txt` file with the same name next to the audio is read as the real lines.
Lyrics have no timestamps, so each lyric line gets a time span by matching its
words once against the clean English ear that heard the most; the Dissent
table then shows the real line for each window and marks with ≠ every
English hearing whose words are not in it.

### Pile

Every distinct line any ear produced, once, in order of first occurrence
(ears in grid order, lines in time order). No ranking.

## In the Toolbelt app

Mishear is also a card on the Toolbelt launcher (`modules/mishear.html`).
That page is only the controls: it talks to `mishear serve`, a small engine on
this computer bound to `127.0.0.1:8766`, which takes the uploaded audio into
`./inbox`, listens, writes `./sheets/<name>/` as the command does, and hands
the sheet back to the page to show. Nothing is hosted and nothing leaves the
machine. Start it in the venv with `mishear serve` (keep the terminal open);
it opens `http://127.0.0.1:8766/`, which serves the same page. The page and
`mishear/ui.html` are the same file: edit `modules/mishear.html` and copy it
over. A phone cannot run the engine.

## Commands

```sh
mishear listen <file-or-folder> [--quick|--all] [--deep] [--keep] [--out DIR]
mishear ears [--quick|--all] [--deep]     # list the ears a grid would use
mishear sheet <file-or-sheet-folder>      # rewrite sheet.md from the saved ears
mishear serve [--port 8766] [--out DIR] [--inbox DIR] [--no-open]   # the local engine for the app page
```

Config lives in `~/.config/mishear/config.toml` (languages, models,
conditions on/off, noise level and seed, decode threads); it is created with
defaults on first run. `MISHEAR_CONFIG=path` overrides the location.

## Rules

- Never paraphrase, clean up or fix model output. Nonsense stays nonsense.
  Empty stays empty.
- Deterministic: fixed seed, temperature 0, fixed beam size. Same input,
  same sheet. Every parameter is recorded.
- The source audio is never modified.
- Test fixtures: only recordings the owner made. Nothing commercial anywhere
  in the repo. `tests/fixtures/standin.wav` is a labelled synthetic stand-in
  (a system voice over a sine sweep, made by `tools/make_standin.py`) until a
  real 20-second recording replaces it.

## Tests

```sh
.venv/bin/python -m pytest
```

The tests run the real `tiny` model on the stand-in (downloaded on first
run) and check that two runs give an identical sheet, that the sidecar fields
are present, that every condition produces a file, that sideways on a mono
file does not crash, and that an all-silence file gives an empty sheet with
no placeholder text.

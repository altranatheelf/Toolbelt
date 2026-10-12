# toolbelt
- an installable PWA: index.html launcher + modules/<name>.html, each module one self-contained file; sw.js caches them for offline use, stamped by tools/stamp-sw.mjs; published by GitHub Pages from .github/workflows/pages.yml; adding a module = file in modules/, card in index.html, line in sw.js FILES

# carousel sequencer
- measure and propose, never apply: nothing is placed, ordered or cut without a tap; the tool writes no captions and no thesis text of its own
- proposals come in the forms that get used, each by slot number with one reason, pinned slides never moved or cut:
  - Cuts: cut list + keep list on mechanical grounds only (weaker twin: softer, then more clipped; off its camera's baseline; face-hidden frames past 4); second-camera texture breaks flagged as a pair, both or neither
  - smallest fix: fewest moves (≤2) that clear one warning without adding another, each labelled with its rule, applied one at a time
  - bridge finder on a seam: tone between the sides, a scale unlike both, a camera matching one side
  - cover candidates: tagged with you in frame, not soft, shown at profile-grid thumbnail size
  - a full order only from Claude (Propose, artifact `sample` capability): never from an optimizer
- pacing rules are pivots and movement, not smoothness: never warn on a big jump; warn on flat runs (3+ slides within 0.06 median luma) and on a 1→2 with no pivot
- phone-frames epilogue is a per-post switch inside the fix proposals, not a preset
- workflow is cutting: load a pool of dozens to a couple hundred frames, then four passes with one decision each: Flags → Sweep (out) → Keep → Narrow to the target; late swaps must be one tap
- likely cuts are flagged, never applied: a badge on undecided frames only, ranked by confidence and capped at ~10% of the pool plus tight twins; only compound mechanical signals (weaker of a tight twin pair, pocket shot = near-black and flat, nothing in focus on a textured frame, much softer than its own camera, screenshot-shaped, tiny file); exposure and colour alone never flag; every flag carries a one-phrase reason and is dismissable
- tiers: Out / undecided / Keep / Hero; one gesture meaning per axis (↑ keep, ↓ out, ←→ next/prev), auto-advance after a decision, a persistent Undo; Survey and Compare drop back to undecided, never to Out
- a target count (default 20) is always visible as "kept / target"; never zoom to 100% during culling
- the cutting brain is on-device and embedded (tools/embed-ai.mjs): TF.js inline, MobileNetV2-0.35 scene embeddings and BlazeFace loaded from memory, spectral-residual saliency in plain JS; nothing is fetched at runtime; no aesthetic scorer (weak on good frames)
- narrowing a kept set proposes, never applies: scenes (one per scene is the rule), closest kept pairs by embedding similarity, and a farthest-first coverage pick to the target with heroes seeded and every drop naming the kept frame it is closest to; drops return to undecided
- scene reading runs after measuring, one frame at a time from the thumbnail, and is cached with the metrics; the page must work when the models fail to load
- default order = the order frames were added (carousels mix days, places and cameras; capture time is not a meaningful order)
- cameras (digicam 102_/103_, main camera IMG_, phone) are mixed on purpose: device is a label, never a warning
- colour/tone flags compare each frame with its own camera's median (carousel frames of that camera if 3+, else that camera's kept/undecided frames); set-wide numbers are shown, never flagged
- RAW previews are the camera's look, not the edit: excluded from colour checks and baselines
- video slides count toward the 20: placeholder slots, never measured
- a whole pool must go in with one pick: multi-select pickers, and a .zip (streamed, original names kept) for pickers limited to one
- filename (file number) visible on every card; never trust a picker's name without checking (Safari 17+ renames to tempImage….heic when accept lists HEIC: keep HEIC out of accept)
- everything local, images never leave the machine — one exception, on an explicit tap: Propose sends a small numbered contact sheet, the title and the tags to Claude
- ships as one self-contained html file (modules/carousel-sequencer.html); must work on iPhone Safari with a couple hundred frames
- max 20 slides
- fixtures: radar station set, expected flags in tests/expected.json

# ripper
- a Toolbelt module (modules/ripper.html, on the launcher) whose work runs in a local engine, `ripper serve` (modules/ripper, Python, AGPL-3.0), bound to 127.0.0.1 only; the page is the controls, nothing is hosted, nothing leaves the machine
- the module page and ripper/ui.html are the same file: edit modules/ripper.html and copy it over
- goals in order: the highest-fidelity stream that exists (audio-only over muxed; never DRC unless it is all there is, and say so; original track over auto-dubs; Opus over AAC at comparable bitrate; highest bitrate within a codec; original/lossless uploads win outright), then provenance (sidecar json+txt per output file, thumbnail, sha256, license shown prominently, verify)
- native = the chosen stream's bytes, container fixed only if needed; wav/flac = float32 at the source rate, 24-bit warns on overs, 16-bit TPDF dither noted, resample only on request with soxr precision 28; sections cut on decoded samples with handles; never normalise or limit
- quality report measures only: LUFS, LRA, true peak, sample peak, overs, bandwidth as a shelf relative to the mid-band, near-mono
- YouTube refuses data-centre IPs: live tests use Creative Commons items on the Internet Archive; YouTube specifics are verified on the person's machine with --cookies-from-browser
- no commercial music URLs in the repo; tests use synthetic audio and CC items


# mishear
- a local command-line mondegreen generator (modules/mishear, Python 3.12, AGPL-3.0): audio goes to speech models under bad listening conditions and what they heard is kept; it composes nothing, every line was produced by a speech model hearing audio; no LLM calls, no network at runtime (models download once into ~/.cache, offline after)
- library: faster-whisper (CTranslate2) on CPU, int8; chosen over whisper.cpp because its Python API gives word timestamps with per-word probability directly and the whole decode is reproducible from parameters; whisper.cpp is faster on Apple Silicon (Metal/CoreML) but that only buys speed, and the Python bindings don't expose word probabilities (see modules/mishear/README.md)
- never paraphrase, clean up or fix model output: nonsense stays nonsense, empty stays empty; the only text edit is stripping Whisper's leading space when a line is printed in the sheet
- deterministic: beam search (beam 5) at temperature 0, no fallback temperatures, condition_on_previous_text off, fixed noise seed, fixed cpu_threads; same input, same sheet; every parameter is recorded in sidecar.json (source path and sha256, duration, model repo + snapshot hash + library versions, exact ffmpeg argv and filter graph, language, task, seed, tool version, timestamp)
- an ear is (condition, model, language, task); one pure function per condition returns the ffmpeg filter graph, one function runs one ear, the sheet writer takes a list of hearings
- dissent aligns words across ears by time only (source timeline, tape/helium/backwards mapped back, a word joins a window when it starts within 0.6 s of its first word); a row needs two English-output ears hearing different things, native-script ears are shown but never decide; rows sort by the surest dissenter's mean word probability; lyrics (same-name .txt) are placed by matching their words once to the clean English ear and only mark ≠, never align
- pile = every distinct line once in first-occurrence order, no ranking
- source audio is never modified; degraded versions are 16 kHz mono temp files, deleted unless --keep
- silence: the model's own no-speech gate (no_speech_threshold 0.6, log_prob_threshold off) decides; no VAD; no placeholder text in an empty sheet
- test fixtures: only recordings the owner made; nothing commercial anywhere; tests/fixtures/standin.wav is a labelled synthetic stand-in (tools/make_standin.py) until a real 20-second recording replaces it
- ffmpeg/ffprobe come from Homebrew; if missing the tool prints `brew install ffmpeg` and exits 2
- things that went wrong (append here):
  - faster-whisper 1.2.1 with PyAV 19 fails on `av.open(..., metadata_errors=...)`; mishear never hands faster-whisper a file: ffmpeg renders every condition to 16 kHz mono PCM and the samples go in as a numpy array
  - tiny hears " You" in digital silence (no_speech_prob 0.80, avg_logprob -0.93): the default whisper gate keeps it because the logprob override wins, so the gate runs on no_speech_prob alone
  - ffmpeg `pan=mono|c0=0.5*c0-0.5*c1` on a mono file silently ignores c1 and outputs the mono at half level, not a side channel; sideways on mono must be handled explicitly
  - the CLI must record the resolved source path: a relative path in the ffmpeg argv is not reproducible from another directory
  - a second `license` line was added to pyproject.toml without reading it and pushed on the strength of a stale editable install; run `pip install -e .` and read the file before committing packaging changes

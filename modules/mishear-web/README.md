# mishear-web

Mishear in the browser, phone included. Built into `modules/mishear.html` by
`node tools/build-mishear-web.mjs` (the built page and the fetched transformers.js
bundle are not committed; the Pages workflow builds them).

- `src/dsp.mjs`: the nine listening conditions as plain JavaScript, ported from
  ffmpeg 6.1 (biquads, acompressor, acrusher, asetrate/aresample, areverse,
  the side channel, and ffmpeg's own seeded pink noise through a port of
  libavutil's lfg + md5). `tests/dsp.test.mjs` renders each one next to
  ffmpeg on the stand-in fixture: correlation 1.0000 on all nine.
- `src/sheet.mjs`: dissent, pile and sheet.md, byte-identical to the Python
  engine on `tests/parity.json` (exported by the Python code).
- `src/ears.mjs`: Whisper through transformers.js (onnx-community
  `whisper-*_timestamped` models): greedy decoding at temperature 0,
  cross-attention word timestamps, per-word probability as the decoder's
  softmax for the chosen tokens, the model's own no-speech gate per 30 s
  window. `tests/ears.test.mjs` runs it under Node with the real tiny model.
- `src/app.mjs` + `page.html`: the page. Decodes with the Web Audio API at
  16 kHz, renders the conditions, listens, writes the sheet, the sidecar and
  the ear files into one .zip (shared or downloaded), and keeps sheets in
  IndexedDB.

What differs from the Mac engine (`modules/mishear`): greedy decoding
instead of beam search, conditions applied at 16 kHz after decoding instead
of at the source rate, a Lanczos resampler for tape and helium instead of
swresample, and no `medium` model. The sidecar records which engine made a
sheet.

```sh
npm install        # @huggingface/transformers for the Node tests
npm test           # conditions vs ffmpeg, sheet parity, listening (downloads tiny once into .cache/)
npm run build      # fetches transformers.js 4.3.1 (pinned sha256) into vendor/, writes ../mishear.html; then node ../../tools/stamp-sw.mjs
```

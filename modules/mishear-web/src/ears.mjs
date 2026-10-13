// Listening with Whisper through transformers.js, in the browser or in Node. `T` is the
// @huggingface/transformers namespace (imported differently in each place). Output is kept
// exactly as the model produced it; only the no-speech gate drops a window, as in the Python
// engine (the model's own probability of <|nospeech|> at the start of the window > 0.6).

import { RATE } from './dsp.mjs';

export const WINDOW_SECONDS = 30;
export const NO_SPEECH_THRESHOLD = 0.6;

// dtype per device. Phones always get the 8-bit files: WebKit kills a tab that holds a 291 MB model.
export const MODELS = {
  tiny: { repo: 'onnx-community/whisper-tiny_timestamped', dtype: { webgpu: 'fp32', wasm: 'q8' }, mb: { fp32: 152, q8: 41 } },
  base: { repo: 'onnx-community/whisper-base_timestamped', dtype: { webgpu: 'fp32', wasm: 'q8' }, mb: { fp32: 291, q8: 77 } },
  small: { repo: 'onnx-community/whisper-small_timestamped', dtype: { webgpu: 'fp16', wasm: 'q8' }, mb: { fp16: 485, q8: 249 } },
};

const DTYPE_SUFFIX = { fp32: '', fp16: '_fp16', q8: '_quantized', int8: '_int8', q4: '_q4', q4f16: '_q4f16' };

/** The files from_pretrained will ask for, small ones first, as Hugging Face URLs. */
export function modelFiles(size, device) {
  const spec = MODELS[size];
  const suffix = DTYPE_SUFFIX[spec.dtype[device] || 'q8'] ?? '';
  const base = `https://huggingface.co/${spec.repo}/resolve/main/`;
  return ['config.json', 'generation_config.json', 'preprocessor_config.json', 'tokenizer_config.json', 'tokenizer.json',
    `onnx/encoder_model${suffix}.onnx`, `onnx/decoder_model_merged${suffix}.onnx`].map((f) => base + f);
}

export function makeRecorder(T) {
  // Softmax probability of the token the greedy sampler will pick, at every decode step.
  return new (class extends T.LogitsProcessor {
    constructor() { super(); this.probs = []; }
    _call(input_ids, logits) {
      const row = logits.data;
      let max = -Infinity;
      for (let i = 0; i < row.length; i++) if (row[i] > max) max = row[i];
      let sum = 0;
      for (let i = 0; i < row.length; i++) sum += Math.exp(row[i] - max);
      this.probs.push(1 / sum);
      return logits;
    }
  })();
}

export async function loadModel(T, size, { device = 'wasm', dtype = null, progress = null } = {}) {
  const spec = MODELS[size];
  if (!spec) throw new Error('unknown model size ' + size);
  const chosen = dtype || spec.dtype[device] || 'fp32';
  const opts = { dtype: chosen, device, progress_callback: progress || undefined };
  const processor = await T.AutoProcessor.from_pretrained(spec.repo, { progress_callback: progress || undefined });
  const tokenizer = await T.AutoTokenizer.from_pretrained(spec.repo, { progress_callback: progress || undefined });
  const model = await T.WhisperForConditionalGeneration.from_pretrained(spec.repo, opts);
  const id = (token, fallback) => { const [v] = tokenizer.convert_tokens_to_ids([token]); return Number.isInteger(v) ? v : fallback; };
  const vocab = {
    eot: id('<|endoftext|>', 50257),
    sot: id('<|startoftranscript|>', 50258),
    noSpeech: id('<|nocaptions|>', id('<|nospeech|>', 50362)), // Whisper's no-speech token, named <|nocaptions|> in the vocabulary
    timestampBegin: tokenizer.timestamp_begin ?? id('<|0.00|>', 50364),
  };
  const info = {
    engine: 'transformers.js',
    transformers_js: T.env?.version || null,
    size, repo: spec.repo, dtype: chosen, device,
  };
  return { T, size, processor, tokenizer, model, vocab, info };
}

async function noSpeechProbability(bundle, inputFeatures) {
  // One decoder step after <|startoftranscript|>: the model's own probability that the window has no speech.
  const { T, model, vocab } = bundle;
  const decoderInput = new T.Tensor('int64', new BigInt64Array([BigInt(vocab.sot)]), [1, 1]);
  const out = await model({ input_features: inputFeatures, decoder_input_ids: decoderInput });
  const logits = out.logits;
  const width = logits.dims[logits.dims.length - 1];
  const row = logits.data.subarray((logits.dims[1] - 1) * width, logits.dims[1] * width);
  let max = -Infinity;
  for (let i = 0; i < width; i++) if (row[i] > max) max = row[i];
  let sum = 0;
  for (let i = 0; i < width; i++) sum += Math.exp(row[i] - max);
  return Math.exp(row[vocab.noSpeech] - max) / sum;
}

function groupWords(bundle, ids, timestamps, probs, offset) {
  // ids: generated token ids (prefix excluded); timestamps: per generated token (seconds in the window)
  const { tokenizer, vocab } = bundle;
  const lines = [];
  let line = null;
  const closeLine = (end) => { if (line) { line.end = end; if (line.words.length) line.text = line.words.map((w) => w.text).join(''); lines.push(line); } line = null; };
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (id >= vocab.timestampBegin) {
      const t = offset + (id - vocab.timestampBegin) * 0.02;
      if (line === null) line = { start: t, end: t, text: '', words: [] };
      else closeLine(t);
      continue;
    }
    if (id === vocab.eot || id >= vocab.eot) continue; // special tokens
    const piece = tokenizer.decode([id], { skip_special_tokens: false });
    if (line === null) line = { start: offset + (timestamps[i] ?? 0), end: offset + (timestamps[i] ?? 0), text: '', words: [] };
    const t = offset + (timestamps[i] ?? 0);
    const p = probs[i] ?? 0;
    const last = line.words[line.words.length - 1];
    if (!last || piece.startsWith(' ') || piece.startsWith('▁')) line.words.push({ start: t, end: t, text: piece, probs: [p] });
    else { last.text += piece; last.probs.push(p); }
  }
  if (line) closeLine(line.words.length ? Math.max(line.start, ...line.words.map((w) => w.end)) : line.start);
  for (const l of lines) {
    for (let k = 0; k < l.words.length; k++) {
      const w = l.words[k];
      w.end = k + 1 < l.words.length ? l.words[k + 1].start : l.end;
      if (w.end < w.start) w.end = w.start;
      w.probability = Math.round((w.probs.reduce((a, b) => a + b, 0) / w.probs.length) * 10000) / 10000;
      w.start = Math.round(w.start * 1000) / 1000; w.end = Math.round(w.end * 1000) / 1000;
      delete w.probs;
    }
    l.start = Math.round(l.start * 1000) / 1000; l.end = Math.round(l.end * 1000) / 1000;
  }
  return lines;
}

/**
 * Run one ear over 16 kHz mono float32 audio in fixed 30-second windows.
 * Returns { lines: [{start, end, text, words: [{start, end, text, probability}]}], windows: [{offset, no_speech_prob, dropped}] }
 */
export async function listen(bundle, audio, { language = 'en', task = 'transcribe' } = {}) {
  const { T, processor, model } = bundle;
  const lines = [];
  const windows = [];
  const step = WINDOW_SECONDS * RATE;
  for (let offset = 0; offset < audio.length || offset === 0; offset += step) {
    const chunk = audio.subarray(offset, Math.min(audio.length, offset + step));
    if (!chunk.length) break;
    const inputs = await processor(chunk);
    const noSpeech = await noSpeechProbability(bundle, inputs.input_features);
    const record = { offset: offset / RATE, no_speech_prob: Math.round(noSpeech * 10000) / 10000, dropped: noSpeech > NO_SPEECH_THRESHOLD };
    windows.push(record);
    if (record.dropped) continue;
    const recorder = makeRecorder(T);
    const out = await model.generate({
      inputs: inputs.input_features, language, task,
      return_timestamps: true, return_token_timestamps: true, return_dict_in_generate: true,
      logits_processor: [recorder],
    });
    const ids = Array.from(out.sequences.data, Number);
    const generated = ids.slice(ids.length - recorder.probs.length);
    const stamps = out.token_timestamps ? Array.from(out.token_timestamps.data).slice(ids.length - recorder.probs.length) : [];
    lines.push(...groupWords(bundle, generated, stamps, recorder.probs, offset / RATE));
    if (out.past_key_values && out.past_key_values.dispose) await out.past_key_values.dispose();
  }
  return { lines, windows };
}

export const DECODE = {
  strategy: 'greedy', beam_size: 1, temperature: 0.0, condition_on_previous_text: false, word_timestamps: 'cross-attention DTW',
  no_speech_threshold: NO_SPEECH_THRESHOLD, window_seconds: WINDOW_SECONDS,
};

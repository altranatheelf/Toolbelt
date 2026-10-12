// The browser listening module, run under Node with the same library (tiny, fp32, CPU).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readWav } from './wav.mjs';
import { listen, loadModel } from '../src/ears.mjs';

const T = await import('@huggingface/transformers');
T.env.cacheDir = process.env.HF_NODE_CACHE || new URL('../.cache/', import.meta.url).pathname; // models download once into modules/mishear-web/.cache
const FIXTURE = new URL('../../mishear/tests/fixtures/standin.wav', import.meta.url).pathname;
const audio = readWav(FIXTURE).channels[0];
const bundle = await loadModel(T, 'tiny', { device: 'cpu', dtype: 'fp32' });

test('tiny hears the stand-in with word timestamps and probabilities', async () => {
  const { lines, windows } = await listen(bundle, audio, { language: 'en', task: 'transcribe' });
  assert.ok(lines.length >= 1 && windows.length === 1 && !windows[0].dropped);
  const words = lines.flatMap((l) => l.words);
  assert.ok(words.length > 20, 'words: ' + words.length);
  assert.ok(words.every((w) => w.probability >= 0 && w.probability <= 1 && w.end >= w.start));
  const text = lines.map((l) => l.text).join('');
  assert.match(text.toLowerCase(), /stand/);
  console.log('  ' + text.slice(0, 120));
  console.log('  ' + words.slice(0, 6).map((w) => `${w.start}-${w.end} ${JSON.stringify(w.text)} ${w.probability}`).join(' | '));
});

test('two runs are identical', async () => {
  const a = await listen(bundle, audio, { language: 'en', task: 'transcribe' });
  const b = await listen(bundle, audio, { language: 'en', task: 'transcribe' });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('silence is dropped by the no-speech gate, nothing invented', async () => {
  const { lines, windows } = await listen(bundle, new Float32Array(RATE_SECONDS(4)), { language: 'en', task: 'transcribe' });
  console.log('  silence no_speech_prob', windows[0].no_speech_prob);
  assert.ok(windows[0].no_speech_prob > 0.6, 'no-speech probability on digital silence');
  assert.equal(lines.length, 0);
});

test('forced Greek writes Greek; translate writes English', async () => {
  const el = await listen(bundle, audio, { language: 'el', task: 'transcribe' });
  const en = await listen(bundle, audio, { language: 'el', task: 'translate' });
  const greek = el.lines.map((l) => l.text).join('');
  const english = en.lines.map((l) => l.text).join('');
  assert.ok(/[Ͱ-Ͽ]/.test(greek), greek.slice(0, 60));
  assert.ok(english.length && !/[Ͱ-Ͽ]/.test(english), english.slice(0, 60));
});

function RATE_SECONDS(s) { return 16000 * s; }

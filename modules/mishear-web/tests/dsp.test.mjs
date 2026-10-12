// Each JavaScript condition against ffmpeg's render of the same fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readWav } from './wav.mjs';
import { CONDITIONS, LFG, filterGraph, pinkNoise, render } from '../src/dsp.mjs';

const FIXTURE = new URL('../../mishear/tests/fixtures/standin.wav', import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), 'mishear-dsp-'));
const source = readWav(FIXTURE);
const settings = { noiseDb: -12, seed: 0, channels: source.channels.length };

function ffmpegRender(graph) {
  const out = join(dir, Math.random().toString(36).slice(2) + '.wav');
  const args = ['-nostdin', '-v', 'error', '-y', '-i', FIXTURE];
  if (graph) args.push('-filter_complex', graph, '-map', '[out]'); else args.push('-map', '0:a:0');
  args.push('-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', out);
  execFileSync('ffmpeg', args);
  return readWav(out).channels[0];
}

function compare(a, b) {
  const n = Math.min(a.length, b.length);
  let dot = 0, aa = 0, bb = 0, diff = 0;
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; diff += (a[i] - b[i]) ** 2; }
  return { correlation: dot / Math.sqrt(aa * bb || 1), diffDb: 10 * Math.log10(diff / n + 1e-20), lengthRatio: a.length / b.length };
}

test('ffmpeg lfg + pink noise are reproduced exactly', () => {
  const lfg = new LFG(0);
  const ours = pinkNoise(16000, 0);
  const out = join(dir, 'pink.wav');
  execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'anoisesrc=color=pink:seed=0:sample_rate=16000:amplitude=1:duration=1', '-c:a', 'pcm_s16le', out]);
  const theirs = readWav(out).channels[0];
  const { correlation } = compare(ours, theirs);
  let maxDiff = 0; for (let i = 0; i < 16000; i++) maxDiff = Math.max(maxDiff, Math.abs(ours[i] - theirs[i]));
  assert.ok(correlation > 0.9999, `pink noise correlation ${correlation}`);
  assert.ok(maxDiff < 1 / 32768 * 1.5, `max sample difference ${maxDiff}`);
  assert.equal(typeof lfg.next(), 'number');
});

for (const name of CONDITIONS) {
  test(`${name} matches ffmpeg`, () => {
    const graph = filterGraph(name, 16000, settings);
    const theirs = ffmpegRender(graph);
    const ours = render(name, source.channels, settings);
    const c = compare(ours, theirs);
    console.log(`  ${name.padEnd(9)} corr ${c.correlation.toFixed(4)}  diff ${c.diffDb.toFixed(1)} dB  length ${c.lengthRatio.toFixed(4)}`);
    const floor = { tape: 0.9, helium: 0.9 }[name] ?? 0.995;
    assert.ok(Math.abs(c.lengthRatio - 1) < 0.002, `length ratio ${c.lengthRatio}`);
    if (name === 'sideways') { assert.ok(ours.every((v) => v === 0) && theirs.every((v) => v === 0), 'mono side channel is zero'); return; }
    assert.ok(c.correlation > floor, `${name} correlation ${c.correlation} < ${floor}`);
  });
}

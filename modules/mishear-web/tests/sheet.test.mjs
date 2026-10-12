import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dissent, earName, fmtTime, normalize, pile, renderSheet, cellText, cellProbability } from '../src/sheet.mjs';

const fx = JSON.parse(readFileSync(new URL('./parity.json', import.meta.url), 'utf8'));
const hearings = fx.hearings.map((h) => ({ ear: h.ear, note: h.note, lines: h.lines }));

test('sheet.md is byte-identical to the Python engine (with lyrics)', () => {
  const sheet = renderSheet('standin.wav', fx.probe, 'ab'.repeat(32), hearings, fx.lyrics, 'standin.txt');
  if (sheet !== fx.expected_sheet) {
    const a = sheet.split('\n'), b = fx.expected_sheet.split('\n');
    for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) { console.log('first difference at line', i + 1, '\n  js: ', JSON.stringify(a[i]), '\n  py: ', JSON.stringify(b[i])); break; }
  }
  assert.equal(sheet, fx.expected_sheet);
});

test('sheet.md is byte-identical to the Python engine (no lyrics)', () => {
  assert.equal(renderSheet('standin.wav', fx.probe, 'ab'.repeat(32), hearings, null, null), fx.expected_sheet_without_lyrics);
});

test('dissent rows and pile match', () => {
  const rows = dissent(hearings, fx.probe, fx.lyrics);
  assert.equal(rows.length, fx.expected_dissent.length);
  rows.forEach((r, i) => {
    const e = fx.expected_dissent[i];
    assert.equal(r.start, e.start); assert.ok(Math.abs(r.probability - e.probability) < 1e-9); assert.equal(r.real, e.real);
    for (const [name, cell] of Object.entries(e.cells)) { const ours = r.cells.get(name); assert.ok(ours, name); assert.equal(cellText(ours), cell.text); assert.ok(Math.abs(cellProbability(ours) - cell.probability) < 1e-9); }
  });
  assert.deepEqual(pile(hearings), fx.expected_pile);
});

test('helpers', () => {
  assert.equal(fmtTime(59.996), '1:00.00'); assert.equal(fmtTime(0.004), '0:00.00'); assert.equal(fmtTime(61.234), '1:01.23');
  assert.equal(normalize(" It's, Light-house!"), 'it s light house');
  assert.equal(earName({ condition: 'clean', model: 'Systran/x', language: 'en', task: 'transcribe' }), 'clean.Systran_x.en.transcribe');
});

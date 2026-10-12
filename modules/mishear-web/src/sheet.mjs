// Port of mishear/dissent.py and mishear/sheet.py. The output must be byte-identical to the
// Python engine's sheet.md for the same hearings (tests/parity.json proves it).
import { timeMap } from './dsp.mjs';

export const WINDOW = 0.6;
const SLACK = 0.3;

export function earName(ear) { return `${ear.condition}.${ear.model.replace(/\//g, '_')}.${ear.language}.${ear.task}`; }
export function earLabel(ear) { return `${ear.condition} · ${ear.model} · ${ear.language}${ear.task === 'transcribe' ? '' : ' → en'}`; }
export function englishOutput(ear) { return ear.language === 'en' || ear.task === 'translate'; }

export function normalize(text) {
  // Python: NFKC, casefold, [^\w\s]|_ -> space, collapse. \w in Python 3 is Unicode letters, digits and _.
  const folded = text.normalize('NFKC').toLowerCase();
  return folded.replace(/[^\p{L}\p{N}\p{M}\s]|_/gu, ' ').trim().split(/\s+/).filter(Boolean).join(' ');
}

export function hearingKey(text) { return normalize(text) || text.trim(); }

function joinWords(left, right) { return right.startsWith(' ') || !left ? left + right : `${left} ${right}`; }

function round3(x) { return Math.round(x * 1000) / 1000; }

export function placeWords(hearings, probe) {
  const placed = [];
  for (const h of hearings) {
    const map = timeMap(h.ear.condition, probe.duration);
    let order = 0;
    for (const line of h.lines) for (const w of line.words) {
      const [start] = map(w.start, w.end);
      placed.push({ ear: h.ear, start: round3(start), text: w.text, probability: w.probability, order: order++ });
    }
  }
  return placed.map((p, i) => [p, i]).sort((a, b) => a[0].start - b[0].start || a[1] - b[1]).map(([p]) => p); // stable
}

export function windows(placed) {
  const result = [];
  let current = null;
  for (const word of placed) {
    if (current === null || word.start > current.start + WINDOW) { current = { start: word.start, cells: new Map() }; result.push(current); }
    const key = earName(word.ear);
    if (!current.cells.has(key)) current.cells.set(key, { ear: word.ear, words: [] });
    current.cells.get(key).words.push(word);
  }
  return result;
}

export function cellText(cell) {
  let out = '';
  for (const w of [...cell.words].sort((a, b) => a.order - b.order)) out = joinWords(out, w.text);
  return out;
}
export function cellProbability(cell) { return cell.words.length ? cell.words.reduce((s, w) => s + w.probability, 0) / cell.words.length : 0; }

export function judge(window) {
  const cells = [...window.cells.values()].filter((c) => englishOutput(c.ear) && cellText(c).trim());
  const texts = cells.map((c) => hearingKey(cellText(c)));
  if (new Set(texts).size < 2) return [false, 0];
  const counts = new Map();
  for (const t of texts) counts.set(t, (counts.get(t) || 0) + 1);
  let top = null, count = 0;
  for (const [t, n] of counts) if (n > count) { top = t; count = n; } // first of the most common, like Counter.most_common
  const plurality = count > 1 ? top : null;
  const dissenters = cells.filter((c, i) => texts[i] !== plurality);
  return [true, Math.max(...dissenters.map(cellProbability))];
}

export function referenceEar(hearings) {
  const candidates = hearings.filter((h) => englishOutput(h.ear) && h.lines.some((l) => l.words.length));
  if (!candidates.length) return null;
  const key = (h) => [h.ear.condition === 'clean' ? 1 : 0, h.ear.language === 'en' && h.ear.task === 'transcribe' ? 1 : 0, h.lines.reduce((s, l) => s + l.words.length, 0)];
  let best = candidates[0], bestKey = key(best);
  for (const h of candidates.slice(1)) { const k = key(h); if (k[0] > bestKey[0] || (k[0] === bestKey[0] && (k[1] > bestKey[1] || (k[1] === bestKey[1] && k[2] > bestKey[2])))) { best = h; bestKey = k; } }
  return best;
}

function matchingBlocks(a, b) {
  // difflib.SequenceMatcher(None, a, b, autojunk=False).get_matching_blocks(), ported
  const blocks = [];
  const queue = [[0, a.length, 0, b.length]];
  const b2j = new Map();
  b.forEach((x, j) => { if (!b2j.has(x)) b2j.set(x, []); b2j.get(x).push(j); });
  const longest = (alo, ahi, blo, bhi) => {
    let besti = alo, bestj = blo, bestsize = 0;
    let j2len = new Map();
    for (let i = alo; i < ahi; i++) {
      const newj2len = new Map();
      for (const j of (b2j.get(a[i]) || [])) {
        if (j < blo) continue; if (j >= bhi) break;
        const k = (j2len.get(j - 1) || 0) + 1;
        newj2len.set(j, k);
        if (k > bestsize) { besti = i - k + 1; bestj = j - k + 1; bestsize = k; }
      }
      j2len = newj2len;
    }
    while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) { besti--; bestj--; bestsize++; }
    while (besti + bestsize < ahi && bestj + bestsize < bhi && a[besti + bestsize] === b[bestj + bestsize]) bestsize++;
    return [besti, bestj, bestsize];
  };
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop();
    const [i, j, k] = longest(alo, ahi, blo, bhi);
    if (k) {
      blocks.push([i, j, k]);
      if (alo < i && blo < j) queue.push([alo, i, blo, j]);
      if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
    }
  }
  blocks.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  return blocks;
}

export function lyricSpans(reference, lyrics, probe) {
  const count = lyrics.length;
  if (!count) return [];
  const times = new Map();
  if (reference) {
    const map = timeMap(reference.ear.condition, probe.duration);
    const refWords = [];
    for (const line of reference.lines) for (const w of line.words) for (const token of normalize(w.text).split(' ').filter(Boolean)) refWords.push([map(w.start, w.end)[0], token]);
    const lyricWords = [];
    lyrics.forEach((line, i) => { for (const token of normalize(line).split(' ').filter(Boolean)) lyricWords.push([i, token]); });
    for (const [a, b, size] of matchingBlocks(lyricWords.map((w) => w[1]), refWords.map((w) => w[1]))) {
      for (let k = 0; k < size; k++) { const li = lyricWords[a + k][0]; if (!times.has(li)) times.set(li, []); times.get(li).push(refWords[b + k][0]); }
    }
  }
  const spans = []; for (let i = 0; i < count; i++) spans.push(times.has(i) ? [Math.min(...times.get(i)), Math.max(...times.get(i))] : null);
  const filled = [];
  for (let i = 0; i < count; i++) {
    const span = spans[i];
    if (span) { filled.push(span); continue; }
    let prevEnd = 0; for (let j = i - 1; j >= 0; j--) if (spans[j]) { prevEnd = spans[j][1]; break; }
    let nextIndex = null; for (let j = i + 1; j < count; j++) if (spans[j]) { nextIndex = j; break; }
    const nextStart = nextIndex !== null ? spans[nextIndex][0] : probe.duration;
    let firstUnmatched = i; while (firstUnmatched > 0 && !spans[firstUnmatched - 1]) firstUnmatched--;
    const unmatchedRun = (nextIndex !== null ? nextIndex : count) - firstUnmatched;
    const share = (nextStart - prevEnd) / Math.max(unmatchedRun, 1);
    const offset = i - firstUnmatched;
    filled.push([prevEnd + share * offset, prevEnd + share * (offset + 1)]);
  }
  return filled;
}

export function realLineAt(spans, lyrics, at) {
  if (!spans.length) return null;
  for (let i = 0; i < spans.length; i++) if (spans[i][0] - SLACK <= at && at <= spans[i][1] + SLACK) return lyrics[i];
  let nearest = 0, best = Infinity;
  spans.forEach((s, i) => { const d = Math.min(Math.abs(at - s[0]), Math.abs(at - s[1])); if (d < best) { best = d; nearest = i; } });
  return lyrics[nearest];
}

export function differsFrom(real, text) {
  if (real == null) return false;
  const heard = normalize(text).split(' ').filter(Boolean);
  const words = normalize(real).split(' ').filter(Boolean);
  if (!heard.length) return Boolean(text.trim());
  for (let i = 0; i + heard.length <= words.length; i++) if (heard.every((w, k) => words[i + k] === w)) return false;
  return true;
}

export function dissent(hearings, probe, lyrics) {
  const rows = [];
  const spans = lyrics && lyrics.length ? lyricSpans(referenceEar(hearings), lyrics, probe) : [];
  for (const window of windows(placeWords(hearings, probe))) {
    const [disagree, probability] = judge(window);
    if (!disagree) continue;
    window.probability = probability;
    if (lyrics && lyrics.length) window.real = realLineAt(spans, lyrics, window.start);
    rows.push(window);
  }
  rows.sort((a, b) => b.probability - a.probability || a.start - b.start);
  return rows;
}

export function pile(hearings) {
  const seen = new Set(), out = [];
  for (const h of hearings) for (const line of h.lines) { const t = line.text.trim(); if (t && !seen.has(t)) { seen.add(t); out.push(t); } }
  return out;
}

// ---------- sheet.md

export function fmtTime(seconds) {
  const centis = Math.round(Math.max(seconds, 0) * 100);
  const minutes = Math.floor(centis / 6000), rest = centis % 6000;
  return `${minutes}:${(rest / 100).toFixed(2).padStart(5, '0')}`;
}
const fmt2 = (x) => x.toFixed(2);
function py2(x) { // Python's f"{x:.2f}" rounds half to even on the binary value; toFixed differs only in rare ties
  return x.toFixed(2);
}

function columnTitle([model, language, task]) { return `${model} · ${language}${task === 'transcribe' ? '' : ' → en'}`; }

export function renderGrid(hearings) {
  const conditions = [], columns = [], cells = new Map();
  for (const h of hearings) {
    if (!conditions.includes(h.ear.condition)) conditions.push(h.ear.condition);
    const key = `${h.ear.model}\u0000${h.ear.language}\u0000${h.ear.task}`;
    if (!columns.some((c) => c.key === key)) columns.push({ key, title: columnTitle([h.ear.model, h.ear.language, h.ear.task]) });
    cells.set(`${h.ear.condition}\u0000${key}`, h.lines.length);
  }
  const lines = ['| condition | ' + columns.map((c) => c.title).join(' | ') + ' |', '|---|' + columns.map(() => '---').join('|') + '|'];
  for (const condition of conditions) lines.push(`| ${condition} | ` + columns.map((c) => cells.has(`${condition}\u0000${c.key}`) ? String(cells.get(`${condition}\u0000${c.key}`)) : '–').join(' | ') + ' |');
  return lines.join('\n');
}

export function renderSource(name, probe, digest, hearings, lyricsName) {
  const channels = { 1: 'mono', 2: 'stereo' }[probe.channels] || `${probe.channels} channels`;
  const parts = [`# ${name}`, '', '## Source', '', `- file: ${name}`, `- sha256: ${digest}`, `- duration: ${py2(probe.duration)} s · ${probe.sample_rate} Hz · ${channels}`, `- ears: ${hearings.length}`];
  if (lyricsName) parts.push(`- lyrics: ${lyricsName}`);
  parts.push('', renderGrid(hearings));
  return parts.join('\n');
}

export function renderEar(h) {
  const parts = [`### ${earLabel(h.ear)}`];
  if (h.note) parts.push(`_${h.note}_`);
  parts.push('');
  for (const line of h.lines) parts.push(`- ${fmtTime(line.start)}–${fmtTime(line.end)}  ${line.text.trim()}`);
  return parts.join('\n');
}

function tableCell(text) { return text.trim().replace(/\|/g, '\\|').replace(/\n/g, ' '); }

export function renderDissent(rows, ears, withLyrics) {
  const parts = ['## Dissent'];
  if (!rows.length) return parts.join('\n');
  parts.push('', `Words aligned on the source timeline (a word joins a window when it starts within ${WINDOW} s of the window's first word; tape, helium and backwards ears are mapped back to source time). A row is a window where the English-output ears heard different things, surest dissent first; each cell shows what that ear heard and the mean word probability.` + (withLyrics ? ' A hearing whose words are not in the real line is marked ≠.' : ''), '');
  const columns = ears.filter((e) => rows.some((r) => r.cells.has(earName(e))));
  const header = ['time', ...(withLyrics ? ['real line'] : []), ...columns.map(earLabel)];
  parts.push('| ' + header.join(' | ') + ' |');
  parts.push('|' + header.map(() => '---').join('|') + '|');
  for (const row of rows) {
    const cells = [fmtTime(row.start)];
    if (withLyrics) cells.push(tableCell(row.real || ''));
    for (const ear of columns) {
      const cell = row.cells.get(earName(ear));
      if (!cell) { cells.push(''); continue; }
      const text = cellText(cell);
      const mark = withLyrics && englishOutput(ear) && differsFrom(row.real, text) ? '≠ ' : '';
      cells.push(`${mark}${tableCell(text)} (${fmt2(cellProbability(cell))})`);
    }
    parts.push('| ' + cells.join(' | ') + ' |');
  }
  return parts.join('\n');
}

export function renderPile(lines) {
  const parts = ['## Pile'];
  if (lines.length) { parts.push(''); for (const line of lines) parts.push(`- ${line}`); }
  return parts.join('\n');
}

export function renderSheet(name, probe, digest, hearings, lyrics, lyricsName) {
  const sections = [renderSource(name, probe, digest, hearings, lyricsName), '## Ears', ...hearings.map(renderEar)];
  const rows = dissent(hearings, probe, lyrics);
  sections.push(renderDissent(rows, hearings.map((h) => h.ear), Boolean(lyrics && lyrics.length)));
  sections.push(renderPile(pile(hearings)));
  return sections.join('\n\n').replace(/\s+$/, '') + '\n';
}

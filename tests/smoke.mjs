// End-to-end smoke test: generates a synthetic shoot, opens it through the folder input,
// waits for the worker to measure it, builds a strip, tags it, previews and exports.
// Run: npm run smoke   (needs Playwright + Chromium; SHOT_DIR=... saves screenshots)
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadCore, loadPlaywright, HTML_PATH } from './lib/core.mjs';

const CS = loadCore();
const close = (a, b, eps) => assert.ok(Math.abs(a - b) <= eps, `${a} !≈ ${b}`);
const { chromium } = await loadPlaywright();

// Minimal EXIF APP1 with Make, Model, DateTimeOriginal.
function exifApp1(make, model, date) {
  const strs = [make + '\0', model + '\0', date + '\0'];
  const ifd0At = 8, ifd0Len = 2 + 3 * 12 + 4, exifAt = ifd0At + ifd0Len, exifLen = 2 + 12 + 4;
  let dataAt = exifAt + exifLen;
  const offs = strs.map((s) => { const o = dataAt; dataAt += s.length; return o; });
  const t = new Uint8Array(dataAt), v = new DataView(t.buffer);
  t.set([0x49, 0x49, 0x2A, 0]); v.setUint32(4, ifd0At, true);
  const entry = (o, tag, type, count, val) => { v.setUint16(o, tag, true); v.setUint16(o + 2, type, true); v.setUint32(o + 4, count, true); v.setUint32(o + 8, val, true); };
  v.setUint16(ifd0At, 3, true);
  entry(ifd0At + 2, 0x010F, 2, strs[0].length, offs[0]);
  entry(ifd0At + 14, 0x0110, 2, strs[1].length, offs[1]);
  entry(ifd0At + 26, 0x8769, 4, 1, exifAt);
  v.setUint16(exifAt, 1, true);
  entry(exifAt + 2, 0x9003, 2, strs[2].length, offs[2]);
  strs.forEach((s, i) => { for (let k = 0; k < s.length; k++) t[offs[i] + k] = s.charCodeAt(k); });
  const seg = new Uint8Array(10 + t.length);
  seg.set([0xFF, 0xE1, (seg.length - 2) >> 8, (seg.length - 2) & 255, 0x45, 0x78, 0x69, 0x66, 0, 0]);
  seg.set(t, 10);
  return seg;
}

// name, capture second, device, scene recipe (drawn in the browser)
const SHOOT = [
  ['DSCF0108.jpg', 0,  'cam',   { seed: 1 }],
  ['DSCF0107.jpg', 10, 'cam',   { seed: 1, bright: 18 }],          // near-duplicate of 0108
  ['DSCF0106.jpg', 20, 'cam',   { seed: 2, cast: [14, -10, 14] }], // magenta cast
  ['IMG_4411.jpg', 30, 'phone', { seed: 3 }],
  ['DSCF0104.jpg', 40, 'cam',   { seed: 4, sky: 0.3 }],            // 30% blown sky
  ['DSCF0103.jpg', 50, 'cam',   { seed: 5 }],
  ['DSCF0102.jpg', 60, 'cam',   { seed: 6 }],
  ['DSCF0101.jpg', 70, 'cam',   { seed: 7 }]
];

const dir = mkdtempSync(join(tmpdir(), 'carousel-smoke-'));
const browser = await chromium.launch();
const errors = [];
try {
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(pathToFileURL(HTML_PATH).href);

  // draw the shoot in the page, encode to JPEG
  const jpegs = await page.evaluate(async (shoot) => {
    const out = [];
    for (const [, , , r] of shoot) {
      const c = document.createElement('canvas'); c.width = 1500; c.height = 1000;
      const g = c.getContext('2d');
      let s = r.seed * 9301;
      const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
      const base = [90 + rnd() * 60, 90 + rnd() * 60, 90 + rnd() * 60];
      g.fillStyle = `rgb(${base.map(Math.round)})`; g.fillRect(0, 0, 1500, 1000);
      for (let i = 0; i < 30; i++) {
        const v = 40 + rnd() * 170, sat = rnd() * 0.5;
        g.fillStyle = `rgb(${Math.round(v * (1 + sat))},${Math.round(v)},${Math.round(v * (1 - sat))})`;
        g.fillRect(rnd() * 1500, rnd() * 1000, 80 + rnd() * 400, 60 + rnd() * 300);
      }
      if (r.sky) { g.fillStyle = '#fff'; g.fillRect(0, 0, 1500, 1000 * r.sky); }
      if (r.bright || r.cast) {
        const d = g.getImageData(0, 0, 1500, 1000), px = d.data, add = r.cast || [r.bright, r.bright, r.bright];
        for (let p = 0; p < px.length; p += 4) { px[p] += add[0]; px[p + 1] += add[1]; px[p + 2] += add[2]; }
        g.putImageData(d, 0, 0);
      }
      const b = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.9));
      out.push(Array.from(new Uint8Array(await b.arrayBuffer())));
    }
    return out;
  }, SHOOT);
  SHOOT.forEach(([name, sec, dev], i) => {
    const date = CS.exifDateString(Date.UTC(2026, 8, 12, 17, 0, sec));
    const app1 = dev === 'cam' ? exifApp1('FUJIFILM', 'X-T5', date) : exifApp1('Apple', 'iPhone 15 Pro', date);
    writeFileSync(join(dir, name), CS.insertApp1(new Uint8Array(jpegs[i]), app1));
  });
  writeFileSync(join(dir, 'notes.txt'), 'not an image');

  // open through the folder input (the File System Access picker can't be scripted)
  await page.setInputFiles('#dirInput', dir);
  await page.waitForFunction(() => document.querySelector('#measureText')?.textContent === 'measured 8', null, { timeout: 30000 });

  const poolNames = await page.$$eval('#poolGrid .card .name', (els) => els.map((e) => e.textContent));
  assert.deepEqual(poolNames, SHOOT.map((s) => s[0]), 'pool is in capture-time order');
  assert.equal(await page.$$eval('#strip .slot', (els) => els.length), 20);
  assert.equal(await page.$$eval('#strip .slot.filled', (els) => els.length), 0, 'strip starts empty');
  assert.match(await page.textContent('#baseChip'), /whole import \(8\)/);

  const flagsOf = (name) => page.$eval(`#poolGrid .card[data-id="${name}"]`, (c) => c.querySelector('.flags')?.textContent ?? '');
  assert.match(await flagsOf('DSCF0106.jpg'), /magenta-shifted/);
  assert.match(await flagsOf('DSCF0104.jpg'), /highlight clipping/);
  for (const [name] of SHOOT) {
    if (name !== 'DSCF0106.jpg') assert.doesNotMatch(await flagsOf(name), /magenta/, name);
    if (name !== 'DSCF0104.jpg') assert.doesNotMatch(await flagsOf(name), /clipping/, name);
  }
  const dupBadges = await page.$$eval('#poolGrid .b.dup', (els) => els.map((e) => e.closest('.card').dataset.id).sort());
  assert.deepEqual(dupBadges, ['DSCF0107.jpg', 'DSCF0108.jpg']);

  // place frames 1..6 in capture order with Enter, tag them from the strip
  await page.click('#poolGrid .card[data-id="DSCF0108.jpg"]');
  for (let i = 0; i < 6; i++) { await page.keyboard.press('Enter'); await page.keyboard.press('ArrowRight'); }
  assert.equal(await page.$$eval('#strip .slot.filled', (els) => els.length), 6);
  assert.match(await page.textContent('#baseChip'), /strip \(6\)/);
  await page.keyboard.press('Tab');
  for (const [scale, pres] of [['c', '0'], ['f', '2'], ['w', '1'], ['w', '1'], ['w', '1'], ['t', '0']]) {
    await page.keyboard.press(scale); await page.keyboard.press(pres); await page.keyboard.press('ArrowRight');
  }
  const warnings = await page.$$eval('#warnings li', (els) => els.map((e) => e.textContent));
  for (const w of [
    'three wides in a row (slides 3–5)',
    'near-duplicates (group A) both in slides 1–3: 1 and 2',
    'phone frame next to camera frame at slides 3–4',
    'phone frame next to camera frame at slides 4–5',
    'you are in four slides in a row (slides 2–5)'
  ]) assert.ok(warnings.includes(w), `missing warning "${w}" in ${JSON.stringify(warnings)}`);
  assert.equal(await page.$$eval('#strip .seam .phoneCam', (els) => els.length), 2);

  // reorder with Alt+Left, drag slot 1 to the pool to remove it
  await page.keyboard.press('Alt+ArrowLeft');
  await page.dragAndDrop('#strip .slot[data-idx="0"]', '#poolGrid');
  assert.equal(await page.$$eval('#strip .slot.filled', (els) => els.length), 5);

  // 21st slide is refused
  const refused = await page.evaluate(() => {
    const s = window.__cs.state; s.strip = s.frames.map((f) => f.id).concat(Array.from({ length: 30 }, (_, i) => 'x' + i)).slice(0, 20);
    return s.strip.length;
  });
  assert.equal(refused, 20);
  await page.evaluate(() => { const s = window.__cs.state; s.strip = s.frames.slice(0, 5).map((f) => f.id); window.__cs.render(); });

  if (process.env.SHOT_DIR) await page.screenshot({ path: join(process.env.SHOT_DIR, 'strip.png'), fullPage: true });

  // preview, crop drag, export
  await page.keyboard.press('p');
  await page.waitForSelector('#pv[open]');
  assert.equal(await page.$$eval('#car .slide', (els) => els.length), 5);
  const box = await page.$eval('#car .slide', (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  assert.equal(Math.round(box.h), 450, '4:5 slide in a 360px phone');
  await page.mouse.move(box.x + 180, box.y + 200); await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + 200, { steps: 5 }); await page.mouse.up();
  const cropX = await page.evaluate(() => window.__cs.state.byId.get(window.__cs.state.strip[0]).crop.x);
  assert.ok(cropX > 0.5, 'dragging left moves the crop right');
  if (process.env.SHOT_DIR) await page.screenshot({ path: join(process.env.SHOT_DIR, 'preview.png') });

  async function exportAll(mode) {
    await page.selectOption('#dateSel', mode);
    const downloads = [];
    const onDl = (d) => downloads.push(d);
    page.on('download', onDl);
    await page.click('#exportBtn');
    await page.waitForFunction(() => /downloaded|failed/.test(document.querySelector('#exportLog').textContent), null, { timeout: 30000 });
    await page.waitForTimeout(300);
    page.off('download', onDl);
    const log = await page.textContent('#exportLog');
    assert.doesNotMatch(log, /failed/, log);
    const files = [];
    for (const d of downloads) {
      const p = await d.path();
      files.push({ name: d.suggestedFilename(), bytes: new Uint8Array((await import('node:fs')).readFileSync(p)) });
    }
    return files.sort((a, b) => a.name.localeCompare(b.name));
  }
  const plain = await exportAll('none');
  assert.deepEqual(plain.map((f) => f.name), ['carousel-01.jpg', 'carousel-02.jpg', 'carousel-03.jpg', 'carousel-04.jpg', 'carousel-05.jpg']);
  for (const f of plain) assert.deepEqual(CS.metadataSegments(f.bytes), [], f.name + ' carries no EXIF/XMP/IPTC');
  const dims = await page.evaluate(async (arr) => { const b = await createImageBitmap(new Blob([new Uint8Array(arr)])); return [b.width, b.height]; }, Array.from(plain[0].bytes));
  assert.deepEqual(dims, [1080, 1350]);

  const dated = await exportAll('capture');
  const times = dated.map((f) => CS.parseExif(f.bytes.buffer));
  assert.equal(times[0].dateTimeOriginal, '2026:09:12 17:00:00');
  assert.equal(times[1].dateTimeOriginal, '2026:09:12 17:00:01');
  assert.ok(times.every((t) => !t.make && !t.model), 'only capture times are written back');

  // the sequence round-trips through carousel-sequence.json next to the photos
  const [seqDl] = await Promise.all([page.waitForEvent('download'), (async () => { await page.keyboard.press('Escape'); await page.click('#downloadSeqBtn'); })()]);
  const seq = JSON.parse((await import('node:fs')).readFileSync(await seqDl.path(), 'utf8'));
  assert.equal(seqDl.suggestedFilename(), 'carousel-sequence.json');
  const order = await page.evaluate(() => window.__cs.state.strip.slice());
  assert.deepEqual(seq.order, order);
  assert.equal(seq.aspect, '4:5');
  writeFileSync(join(dir, 'carousel-sequence.json'), JSON.stringify(seq));
  await page.evaluate(() => { document.querySelector('#measureText').textContent = ''; });
  await page.setInputFiles('#dirInput', dir);
  await page.waitForFunction(() => document.querySelector('#measureText')?.textContent === 'measured 8', null, { timeout: 30000 });
  const restored = await page.evaluate(() => {
    const s = window.__cs.state;
    return { order: s.strip.slice(), tags: s.strip.map((id) => s.byId.get(id).tags), cropX: s.byId.get(s.strip[0]).crop.x };
  });
  assert.deepEqual(restored.order, order);
  assert.deepEqual(restored.tags.map((t) => t.scale), seq.order.map((id) => seq.frames[id]?.scale ?? null));
  close(restored.cropX, cropX, 1e-3);

  assert.deepEqual(errors, [], 'no page errors');
  console.log('smoke ok: measured, flagged, sequenced, previewed, exported');
} finally {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
}

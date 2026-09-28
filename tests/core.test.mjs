import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCore, html } from './lib/core.mjs';

const CS = loadCore();

// w*h RGBA filled by fn(x, y) -> [r, g, b]
function img(w, h, fn) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b] = fn(x, y), p = (y * w + x) * 4;
    d[p] = r; d[p + 1] = g; d[p + 2] = b; d[p + 3] = 255;
  }
  return d;
}
const measure = (w, h, fn) => CS.measurePixels(img(w, h, fn), w, h);
const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} ${a} !≈ ${b}`);

test('rules: max 20 slides', () => {
  assert.equal(CS.MAX_SLIDES, 20);
});

test('saturation is the per-pixel HSV median', () => {
  const grey = measure(40, 40, () => [128, 128, 128]);
  assert.equal(grey.sat, 0);
  // 60% of pixels at S=0.5 (200,100,100), 40% at S=0 -> median 0.5
  const m = measure(50, 10, (x) => (x < 30 ? [200, 100, 100] : [90, 90, 90]));
  close(m.sat, 0.5, 0.001);
});

test('highlight clip and crushed shadows are pixel percentages', () => {
  const m = measure(100, 10, (x) => (x < 7 ? [255, 255, 255] : x < 10 ? [2, 3, 1] : [120, 120, 120]));
  close(m.clipPct, 7, 1e-9);
  close(m.crushPct, 3, 1e-9);
  // one clipped channel counts as clipped (blown sky often clips blue alone)
  close(measure(10, 10, () => [180, 220, 252]).clipPct, 100, 1e-9);
});

test('luminance spread is p95 - p5 of Rec.709 luma', () => {
  const m = measure(256, 1, (x) => [x, x, x]);
  close(m.lumSpread, 0.9, 0.01);
  close(m.lumMedian, 0.5, 0.01);
});

test('tint and red-blue balance come from near-neutral pixels', () => {
  const magenta = measure(20, 20, () => [140, 124, 140]);
  assert.equal(magenta.castSource, 'neutral');
  close(magenta.tint, -16 / 255, 1e-6);
  close(magenta.rb, 0, 1e-9);
  const warm = measure(20, 20, () => [150, 140, 125]);
  close(warm.rb, 25 / 255, 1e-6);
  // a saturated red subject does not register as a cast when neutrals exist
  const redSubject = measure(20, 20, (x) => (x < 10 ? [220, 30, 30] : [128, 128, 128]));
  close(redSubject.tint, 0, 1e-9);
  close(redSubject.rb, 0, 1e-9);
  // no neutrals at all -> falls back to all unclipped pixels
  assert.equal(measure(10, 10, () => [200, 40, 40]).castSource, 'all');
});

test('dominant hue', () => {
  const blue = measure(10, 10, () => [30, 60, 200]);
  close(blue.hueDeg, 229.4, 1);
  assert.ok(blue.hueStrength > 0.99);
  assert.equal(measure(10, 10, () => [100, 100, 100]).hueDeg, null);
  assert.equal(CS.hueDistance(350, 10), 20);
});

test('baseline is the per-metric median, flags judge one frame against it', () => {
  const set = [0.26, 0.27, 0.273, 0.28, 0.30].map((sat, i) => ({
    sat, lumSpread: 0.7, clipPct: [1.5, 2, 2.2, 1.8, 7][i], crushPct: 0.5, rb: 0.01, tint: 0
  }));
  const b = CS.baseline(set);
  assert.equal(b.n, 5);
  close(b.sat, 0.273, 1e-12);
  close(b.clipPct, 2, 1e-12);
  const clipped = CS.frameFlags(set[4], b);
  assert.deepEqual(clipped.map((f) => f.key), ['clipPct']);
  assert.equal(clipped[0].text, 'highlight clipping');
  // 3% vs 2% is within tolerance
  assert.deepEqual(CS.frameFlags({ ...set[0], clipPct: 3 }, b), []);
  const mag = CS.frameFlags({ ...set[1], tint: -0.03 }, b);
  assert.deepEqual(mag.map((f) => f.text), ['magenta-shifted']);
  assert.deepEqual(CS.frameFlags({ ...set[1], tint: 0.03 }, b).map((f) => f.text), ['green-shifted']);
  assert.deepEqual(CS.frameFlags({ ...set[1], sat: 0.34 }, b).map((f) => f.text), ['more saturated']);
});

test('near-duplicate grouping survives a tonal edit but not a different frame', () => {
  const scene = (x, y) => { const v = Math.round(255 * ((Math.sin(x / 7) + Math.cos(y / 5)) / 4 + 0.5)); return [v, v, v]; };
  const a = CS.dhash(img(90, 80, scene), 90, 80);
  const brighter = CS.dhash(img(90, 80, (x, y) => scene(x, y).map((v) => Math.min(255, v * 1.15 + 10))), 90, 80);
  const other = CS.dhash(img(90, 80, (x, y) => { const v = Math.round(255 * ((Math.cos(x / 11 + 1) * Math.sin(y / 3)) / 2 + 0.5)); return [v, v, v]; }), 90, 80);
  assert.ok(CS.hamming(a, brighter) <= CS.DUP_MAX_DIST, 'tonal variant should group');
  assert.ok(CS.hamming(a, other) > CS.DUP_MAX_DIST, 'different frame should not group');
  const g = CS.groupDuplicates([
    { id: 'a', metrics: { dhash: a } }, { id: 'b', metrics: { dhash: brighter } }, { id: 'c', metrics: { dhash: other } }
  ]);
  assert.equal(g.groupOf.a, 'A');
  assert.equal(g.groupOf.b, 'A');
  assert.equal(g.groupOf.c, undefined);
});

test('seams: tonal jump and hue shift are flags, a camera change is only a label', () => {
  const cam = { key: 'fujifilm|x-t5', label: 'X-T5', phone: false };
  const phone = { key: 'apple|iphone 15 pro', label: 'iPhone 15 Pro', phone: true };
  const a = { metrics: { lumMedian: 0.3, hueDeg: 30, hueStrength: 0.5 }, device: cam };
  const b = { metrics: { lumMedian: 0.5, hueDeg: 200, hueStrength: 0.5 }, device: phone };
  const s = CS.seam(a, b);
  close(s.tonal, 0.2, 1e-12);
  assert.equal(s.hue, 170);
  assert.deepEqual(s.flags, ['tonal', 'hue']);
  assert.ok(s.deviceChange && s.phoneCamera);
  const weak = CS.seam(a, { metrics: { lumMedian: 0.32, hueDeg: 200, hueStrength: 0.05 }, device: cam });
  assert.equal(weak.hue, null);
  assert.deepEqual(weak.flags, []);
});

test('sequence warnings state facts, skip videos, and never mention devices', () => {
  const cam = { key: 'cam', phone: false }, phone = { key: 'phone', phone: true };
  const s = (scale, presence, extra = {}) => ({ kind: 'photo', scale, presence, device: cam, ...extra });
  const video = { kind: 'video' };
  const w = CS.sequenceWarnings([
    s('close', 'out', { twin: 'A' }), s('face', 'shown'), s('close', 'out', { twin: 'A' }),
    video, s('wide', 'out'), s('wide', 'out'), s('wide', 'out', { device: phone }),
    s('texture', 'hidden'), s('close', 'shown'), s('face', 'shown'), s('close', 'out'), video
  ]).map((x) => x.text);
  assert.ok(w.includes('three wides in a row (slides 5–7)'), w.join('\n'));
  assert.ok(w.includes('twins both in slides 1–3: 1 and 3'), w.join('\n'));
  assert.ok(w.includes('you are in three slides in a row (slides 8–10)'), w.join('\n'));
  assert.ok(!w.some((t) => /phone|camera|device/.test(t)), w.join('\n'));
  assert.ok(w.every((t) => !/\b(move|swap|cut|remove|drop|try|should|consider)\b/i.test(t)), w.join('\n'));
  const v = CS.sequenceWarnings([s('wide', 'out'), s('wide', 'out'), video, s('wide', 'out')]).map((x) => x.kind);
  assert.ok(!v.includes('scale'), 'a video slide breaks a run');
  assert.deepEqual(CS.sequenceWarnings([s(null, null), video]).map((x) => x.kind), ['untagged']);
});

test('colour flags compare each camera with itself; set-wide numbers never flag', () => {
  const m = (tint, clipPct = 2) => ({ sat: 0.27, lumSpread: 0.7, clipPct, crushPct: 0.5, rb: 0.01, tint, sharp: 400 });
  const fuji = { key: 'fuji' }, digi = { key: 'digi' };
  const frames = [
    ...[0, 0.002, -0.001, 0.001].map((t, i) => ({ id: 'f' + i, device: fuji, metrics: m(t) })),
    // the digicam is greener across the board: a deliberate look, not an outlier
    ...[0.05, 0.052, 0.049, 0.051].map((t, i) => ({ id: 'd' + i, device: digi, metrics: m(t) })),
    { id: 'd-odd', device: digi, metrics: m(0.02) },
    { id: 'raw', device: fuji, raw: true, metrics: m(0.3, 40) }
  ];
  const b = CS.cameraBaselines(frames);
  assert.equal(b.byCamera.fuji.n, 4, 'RAW previews stay out of the baseline');
  const flags = (id) => { const f = frames.find((x) => x.id === id); return CS.frameFlags(f.metrics, CS.baselineFor(f, b)).map((x) => x.text); };
  assert.deepEqual(flags('d0'), [], 'a whole camera is not flagged against the set');
  assert.deepEqual(flags('f1'), []);
  assert.deepEqual(flags('d-odd'), ['magenta-shifted'], 'outlier within its own camera');
  const lone = { id: 'p', device: { key: 'phone' }, metrics: m(0.2) };
  const b2 = CS.cameraBaselines(frames.concat(lone));
  assert.deepEqual(CS.frameFlags(lone.metrics, CS.baselineFor(lone, b2)), [], 'too few frames from a camera to judge');
  assert.equal(b2.set.n, 10);
});

test('sharpness: a soft frame measures lower and is flagged within its camera', () => {
  const sharpImg = img(64, 64, (x, y) => ((x >> 2) + (y >> 2)) % 2 ? [220, 220, 220] : [30, 30, 30]);
  const softImg = img(64, 64, (x, y) => { const v = 125 + 60 * Math.sin(x / 6) * Math.cos(y / 6); return [v, v, v]; });
  const a = CS.measurePixels(sharpImg, 64, 64), s = CS.measurePixels(softImg, 64, 64);
  assert.ok(a.sharp > 20 * s.sharp, `${a.sharp} vs ${s.sharp}`);
  const base = { n: 4, sat: s.sat, lumSpread: s.lumSpread, clipPct: s.clipPct, crushPct: s.crushPct, rb: s.rb, tint: s.tint, sharp: a.sharp };
  assert.ok(CS.frameFlags(s, base).some((f) => f.text === 'softer'));
});

test('twins are same-camera near-duplicates; rhymes are similar frames across cameras', () => {
  const scene = (x, y) => { const v = Math.round(255 * ((Math.sin(x / 7) + Math.cos(y / 5)) / 4 + 0.5)); return [v, v, v]; };
  const hA = CS.dhash(img(90, 80, scene), 90, 80);
  const hB = CS.dhash(img(90, 80, (x, y) => scene(x, y).map((v) => Math.min(255, v * 1.1 + 8))), 90, 80);
  const other = CS.dhash(img(90, 80, (x, y) => { const v = Math.round(255 * ((Math.cos(x / 11 + 1) * Math.sin(y / 3)) / 2 + 0.5)); return [v, v, v]; }), 90, 80);
  const fr = (id, key, h) => ({ id, device: { key }, metrics: { dhash: h } });
  const frames = [fr('IMG_1', 'fuji', hA), fr('IMG_2', 'fuji', hB), fr('103_1', 'digi', hB), fr('IMG_3', 'fuji', other)];
  const t = CS.twins(frames);
  assert.equal(t.groupOf.IMG_1, t.groupOf.IMG_2);
  assert.equal(t.groupOf['103_1'], undefined, 'a different camera is never a twin');
  const r = CS.rhymes(frames);
  assert.deepEqual(r['103_1'].sort(), ['IMG_1', 'IMG_2']);
  assert.equal(r.IMG_3, undefined);
});

test('file numbers and renamed-by-picker detection', () => {
  assert.equal(CS.frameNumber('IMG_9774.JPG'), '9774');
  assert.equal(CS.frameNumber('103_0216.JPG'), '103_0216');
  assert.equal(CS.frameNumber('102_0031.jpg'), '102_0031');
  assert.equal(CS.frameNumber('IMG_4412.jpeg'), '4412');
  assert.equal(CS.frameNumber('DSCF2201.jpg'), '2201');
  assert.equal(CS.frameNumber('9774-edit.jpg'), '9774');
  assert.equal(CS.frameNumber('beach.jpg'), 'beach');
  for (const n of ['tempImageHjyd3l.heic', 'image.jpg', 'image 2.jpeg', '3F2504E0-4F89-11D3-9A0C-0305E82C3301.jpeg'])
    assert.ok(CS.looksRenamed(n), n);
  for (const n of ['IMG_9774.JPG', '103_0216.JPG', 'IMG_4412.jpeg', 'imagery.jpg'])
    assert.ok(!CS.looksRenamed(n), n);
});

test('EXIF: read make/model/capture time, write capture time only', () => {
  const app1 = CS.buildDateApp1(Date.UTC(2026, 8, 12, 17, 4, 5));
  const jpeg = new Uint8Array([0xFF, 0xD8, ...app1, 0xFF, 0xD9]);
  const ex = CS.parseExif(jpeg.buffer);
  assert.equal(ex.dateTimeOriginal, '2026:09:12 17:04:05');
  assert.equal(ex.dateTime, '2026:09:12 17:04:05');
  assert.equal(ex.make, undefined);
  assert.equal(CS.captureTime(ex, 0).ms, Date.UTC(2026, 8, 12, 17, 4, 5));
  assert.equal(CS.captureTime({}, 1234).source, 'file');
  // inserted after JFIF APP0
  const jfif = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x04, 0x4A, 0x46, 0xFF, 0xD9]);
  assert.deepEqual(CS.metadataSegments(jfif), []);
  const withDates = CS.insertApp1(jfif, app1);
  assert.deepEqual([...withDates.slice(0, 8)], [0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x04, 0x4A, 0x46]);
  assert.equal(withDates[8], 0xFF); assert.equal(withDates[9], 0xE1);
  assert.deepEqual(CS.metadataSegments(withDates), ['APP1']);
  assert.equal(CS.parseExif(withDates.buffer).dateTimeOriginal, '2026:09:12 17:04:05');
  assert.equal(CS.exifTimeMs('2026:09:12 17:04:05', '25'), Date.UTC(2026, 8, 12, 17, 4, 5) + 250);
});

test('RAW: largest embedded JPEG, EXIF from the TIFF header, orientation carried over', () => {
  const tiff = CS.buildExifApp1({ make: 'NIKON CORPORATION', model: 'NIKON Z 6', orientation: 6, date: Date.UTC(2026, 3, 2, 9, 30, 0) }).slice(10);
  const jpeg = (w, h, fill) => new Uint8Array([
    0xFF, 0xD8, 0xFF, 0xC0, 0, 11, 8, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0,
    0xFF, 0xDA, 0, 8, 1, 1, 0, 0, 63, 0, ...fill, 0xFF, 0xD9]);
  const lossless = new Uint8Array([0xFF, 0xD8, 0xFF, 0xC3, 0, 11, 8, 0x10, 0, 0x10, 0, 1, 1, 0x11, 0, 0xFF, 0xD9]);
  const small = jpeg(160, 120, [1, 2, 0xFF, 0x00, 3]), big = jpeg(6048, 4024, [9, 0xFF, 0xD3, 8, 7]);
  const raw = new Uint8Array([...tiff, 0, 0, ...small, ...lossless, ...big, 5, 5]);
  const found = CS.extractEmbeddedJpeg(raw);
  assert.deepEqual([found.width, found.height], [6048, 4024]);
  assert.deepEqual([...found.jpeg], [...big]);
  const r = CS.rawToJpeg(raw);
  assert.equal(r.exif.model, 'NIKON Z 6');
  assert.equal(r.exif.orientation, 6);
  assert.equal(r.exif.dateTimeOriginal, '2026:04:02 09:30:00');
  assert.equal(CS.parseExif(r.jpeg.buffer).orientation, 6, 'orientation written into the extracted JPEG');
  assert.ok(CS.isRaw('DSC_0001.NEF') && CS.isRaw('x.cr3') && !CS.isRaw('x.jpg'));
  assert.equal(CS.rawToJpeg(new Uint8Array(tiff)), null);
});

test('capture time falls back to pick order when files carry no date', () => {
  const now = Date.UTC(2026, 8, 26, 12, 0, 0);
  assert.equal(CS.captureTime({}, now - 5000, now).source, 'pick');
  assert.equal(CS.captureTime({}, now - 86400000, now).source, 'file');
  const f = (name, ms, pick) => ({ name, pick, capture: { ms } });
  const order = CS.captureOrder([f('z.jpg', null, 0), f('b.jpg', 50, 3), f('y.jpg', null, 1), f('a.jpg', 10, 2)]).map((x) => x.name);
  assert.deepEqual(order, ['a.jpg', 'b.jpg', 'z.jpg', 'y.jpg']);
});

test('default order is capture time, filename breaks ties', () => {
  const f = (name, ms) => ({ name, capture: { ms } });
  const order = CS.captureOrder([f('c.jpg', 20), f('b.jpg', 10), f('a.jpg', 20)]).map((x) => x.name);
  assert.deepEqual(order, ['b.jpg', 'a.jpg', 'c.jpg']);
});

test('device badge and phone detection', () => {
  assert.deepEqual(CS.device({ make: 'Apple', model: 'iPhone 15 Pro' }), { key: 'apple|iphone 15 pro', label: 'iPhone 15 Pro', phone: true });
  const fuji = CS.device({ make: 'FUJIFILM', model: 'X-T5' });
  assert.equal(fuji.phone, false); assert.equal(fuji.label, 'FUJIFILM X-T5');
  assert.equal(CS.device({ make: 'Canon', model: 'Canon EOS R6' }).label, 'Canon EOS R6');
  assert.equal(CS.device({ make: 'Google', model: 'Pixel 8' }).phone, true);
  assert.equal(CS.device({}).key, '');
});

test('crop geometry', () => {
  // 3:2 landscape into 4:5: full height, centred
  const r = CS.cropRect(6000, 4000, 0.8, { x: 0.5, y: 0.5, zoom: 1 });
  assert.deepEqual(r, { x: 1400, y: 0, w: 3200, h: 4000 });
  assert.equal(CS.cropRect(6000, 4000, 0.8, { x: 0, y: 0.5, zoom: 1 }).x, 0);
  const z = CS.cropRect(6000, 4000, 0.8, { x: 0.5, y: 0.5, zoom: 2 });
  assert.deepEqual([z.w, z.h, z.x, z.y], [1600, 2000, 2200, 1000]);
  // 3:4 grid inside a 4:5 post keeps full height, 15/16 width
  const g = CS.gridRect(0.8, 0.75);
  close(g.w, 0.9375, 1e-12); assert.equal(g.h, 1);
  const sq = CS.gridRect(0.8, 1);
  assert.equal(sq.w, 1); close(sq.h, 0.8, 1e-12);
  assert.deepEqual(CS.ASPECTS['4:5'], { w: 1080, h: 1350 });
});

test('page ships as one self-contained file with no network access', () => {
  assert.doesNotMatch(html, /\b(src|href)\s*=\s*["']?(https?:)?\/\//i);
  assert.doesNotMatch(html, /url\(\s*["']?(https?:)?\/\//i);
  assert.doesNotMatch(html, /@import/);
  assert.doesNotMatch(html, /\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource/);
});

// ---------- proposals: pacing, smallest fix, cuts, bridges ----------
const P = (id, o = {}) => ({ kind: 'photo', id, scale: null, presence: null, lum: 0.5, hue: null, hueStrength: 0, ...o });

test('pacing: big jumps are fine; flat runs and a missing 1→2 pivot are warned', () => {
  const lums = [0.2, 0.7, 0.3, 0.5, 0.52, 0.54, 0.51, 0.8];
  const w = CS.sequenceWarnings(lums.map((l, i) => P('s' + i, { lum: l, scale: i % 2 ? 'wide' : 'close', presence: 'out' })));
  assert.deepEqual(w.map((x) => x.text), ['no tonal movement across slides 4–7']);
  const noPivot = CS.sequenceWarnings([P('a', { lum: 0.4, scale: 'wide', presence: 'out' }), P('b', { lum: 0.45, scale: 'wide', presence: 'out' })]);
  assert.deepEqual(noPivot.map((x) => x.kind), ['no-pivot']);
  const scalePivot = CS.sequenceWarnings([P('a', { lum: 0.4, scale: 'face', presence: 'out' }), P('b', { lum: 0.45, scale: 'wide', presence: 'out' })]);
  assert.deepEqual(scalePivot, [], 'a change of scale is a pivot');
  assert.ok(!CS.sequenceWarnings([P('a', { lum: 0.1 }), P('b', { lum: 0.9 })]).some((x) => /jump/.test(x.text)));
});

test('presence cap: a fifth face-hidden frame is warned', () => {
  const w = CS.sequenceWarnings(Array.from({ length: 10 }, (_, i) => P('s' + i, { lum: i % 2 ? 0.2 : 0.7, scale: i % 2 ? 'wide' : 'close', presence: i < 5 ? 'hidden' : 'out' })));
  assert.ok(w.some((x) => x.kind === 'presence-cap' && /five face-hidden frames/.test(x.text)), w.map((x) => x.text).join('\n'));
});

test('smallest fix: fewest moves, labelled with the rule, pinned slides never move', () => {
  const lum = [0.2, 0.7, 0.3, 0.75, 0.25, 0.8, 0.35];
  const scale = ['close', 'wide', 'wide', 'wide', 'face', 'close', 'texture'];
  const slides = lum.map((l, i) => P('s' + i, { lum: l, scale: scale[i], presence: 'out' }));
  const w = CS.sequenceWarnings(slides).find((x) => x.kind === 'scale');
  assert.equal(w.text, 'three wides in a row (slides 2–4)');
  const fix = CS.fixWarning(slides, w);
  assert.equal(fix.length, 1, JSON.stringify(fix));
  assert.equal(fix[0].rule, 'no three of one scale in a row');
  let after = slides; fix.forEach((m) => { after = CS.applyOp(after, m); });
  assert.ok(!CS.sequenceWarnings(after).some((x) => x.kind === 'scale'));
  assert.equal(CS.sequenceWarnings(after).length, CS.sequenceWarnings(slides).length - 1, 'no new warnings');
  // pin everything except the run: no fix may touch the pinned slides
  const pinned = slides.map((s, i) => ({ ...s, pinned: i !== 2 && i !== 3 && i !== 5 }));
  const f2 = CS.fixWarning(pinned, w);
  f2.forEach((m) => { assert.ok(!pinned[m.from].pinned && !(m.op === 'swap' && pinned[m.to].pinned)); });
  let a2 = pinned; f2.forEach((m) => { a2 = CS.applyOp(a2, m); });
  a2.forEach((s, i) => { if (s.pinned) assert.equal(s.id, pinned[i].id, 'pinned slide stayed at slot ' + (i + 1)); });
});

test('epilogue moves hold phone frames to the end, one move each, pinned untouched', () => {
  const sl = ['a', 'p1', 'b', 'p2', 'c', 'd'].map((id) => P(id));
  const moves = CS.epilogueMoves(sl, (s) => s.id[0] === 'p');
  let cur = sl; moves.forEach((m) => { cur = CS.applyOp(cur, m); });
  assert.deepEqual(cur.map((s) => s.id), ['a', 'b', 'c', 'd', 'p1', 'p2']);
  assert.equal(moves.length, 2);
  assert.ok(moves.every((m) => m.rule === 'epilogue: phone frames held to the end'));
  const pinnedEnd = sl.map((s) => ({ ...s, pinned: s.id === 'd' }));
  assert.ok(CS.epilogueMoves(pinnedEnd, (s) => s.id[0] === 'p').every((m) => m.to < 5));
});

test('cuts: weaker twin, off-baseline frames, presence past the cap, texture pairs; one line per slot', () => {
  const it = (slot, o) => ({ slot, id: 'f' + slot, num: String(9770 + slot), kind: 'photo', pinned: false, sharp: 500, clipPct: 1,
    flags: [], camKey: 'fuji', camLabel: 'X-T5', scale: 'wide', presence: 'out', ...o });
  const items = [
    it(0, { twin: 'A', sharp: 600 }), it(1, { twin: 'A', sharp: 300 }),
    it(2, { flags: ['magenta'] }),
    ...[3, 4, 5, 6, 7].map((k) => it(k, { presence: 'hidden', sharp: 400 + k })),
    it(8, { camKey: 'digi', camLabel: 'PowerShot', scale: 'texture' }), it(9, { camKey: 'digi', camLabel: 'PowerShot', scale: 'texture' }),
    { slot: 10, id: 'v', kind: 'video' },
    it(11, { flags: ['soft'], pinned: true })
  ];
  const r = CS.cutList(items);
  assert.deepEqual(r.cuts.map((c) => c.text), [
    'Cut 2 · 9771: softer twin of 1 (9770)',
    'Cut 3 · 9772: magenta against the other X-T5 frames',
    'Cut 4 · 9773: fifth face-hidden frame of you (cap 4)'
  ]);
  assert.ok(r.keeps.some((k) => k.text === 'Keep 1 · 9770: stronger of its twins'));
  assert.ok(r.keeps.some((k) => k.text === 'Keep 12 · 9781: pinned'), 'pinned is never cut');
  assert.ok(r.keeps.some((k) => k.text === 'Keep 11: video slide'));
  assert.deepEqual(r.pairs.map((p) => p.text), ['9 (9778) and 10 (9779): PowerShot texture breaks, both or neither']);
  assert.equal(r.cuts.length + r.keeps.length, items.length, 'every slot gets exactly one line');
});

test('bridge finder: tone between, a scale unlike both, a camera from one side', () => {
  const a = { lum: 0.2, scale: 'wide', camKey: 'fuji' }, b = { lum: 0.7, scale: 'wide', camKey: 'digi' };
  const pool = [
    { id: 'x', lum: 0.45, scale: 'close', camKey: 'fuji' },
    { id: 'y', lum: 0.9, scale: 'wide', camKey: 'phone' },
    { id: 'z', lum: 0.5, scale: 'wide', camKey: 'phone' }
  ];
  const r = CS.bridgeCandidates(a, b, pool);
  assert.deepEqual(r.map((c) => c.id), ['x', 'z']);
  assert.deepEqual(r[0].reasons, ['tone between the two', 'a close, unlike both', 'same camera as the left']);
});

test('zip: a whole pool in one file, original names kept, stored and deflated entries', async () => {
  const enc = new TextEncoder();
  const deflate = async (u8) => new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (u8) => { let c = 0xFFFFFFFF; for (const b of u8) c = crcT[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const files = [['pool/IMG_9774.JPG', new Uint8Array([0xFF, 0xD8, 1, 2, 3, 0xFF, 0xD9]), 0], ['pool/103_0216.JPG', enc.encode('x'.repeat(500)), 8],
    ['__MACOSX/pool/._IMG_9774.JPG', enc.encode('junk'), 0], ['pool/.DS_Store', enc.encode('junk'), 0], ['pool/', new Uint8Array(0), 0]];
  const parts = [], central = []; let off = 0;
  for (const [name, data, method] of files) {
    const nm = enc.encode(name), body = method ? await deflate(data) : data;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(8, method, true); lh.setUint32(14, crc(data), true);
    lh.setUint32(18, body.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, nm.length, true);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(10, method, true); ch.setUint16(12, (12 << 11) | (30 << 5), true); ch.setUint16(14, ((2026 - 1980) << 9) | (9 << 5) | 12, true);
    ch.setUint32(16, crc(data), true); ch.setUint32(20, body.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, nm.length, true); ch.setUint32(42, off, true);
    parts.push(new Uint8Array(lh.buffer), nm, body); central.push(new Uint8Array(ch.buffer), nm);
    off += 30 + nm.length + body.length;
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, cdSize, true); end.setUint32(16, off, true);
  const zip = new Blob([...parts, ...central, new Uint8Array(end.buffer)]);
  const out = await CS.unzip(zip);
  assert.deepEqual(out.map((f) => f.name), ['IMG_9774.JPG', '103_0216.JPG']);
  assert.deepEqual([...new Uint8Array(await out[0].arrayBuffer())], [0xFF, 0xD8, 1, 2, 3, 0xFF, 0xD9]);
  assert.equal(await out[1].text(), 'x'.repeat(500));
  assert.equal(new Date(out[0].lastModified).getUTCFullYear(), 2026);
  await assert.rejects(CS.unzip(new Blob([enc.encode('not a zip at all')])), /not a zip/);
});

test('likely cuts: tiny, ranked, mechanical; the weaker twin, pocket shots, soft, blown, screenshots', () => {
  const m = (o = {}) => ({ sat: 0.27, lumSpread: 0.7, lumMedian: 0.45, clipPct: 2, crushPct: 0.5, rb: 0.01, tint: 0, sharp: 400, dhash: null, ...o });
  const fuji = { key: 'fuji', label: 'X-T5' };
  const frames = [];
  for (let i = 0; i < 40; i++) frames.push({ id: 'f' + i, num: String(9700 + i), device: fuji, width: 6000, height: 4000, metrics: m({ sharp: 350 + i * 3 }) });
  frames.push({ id: 'pocket', num: 'p', device: fuji, width: 6000, height: 4000, metrics: m({ lumMedian: 0.02, lumSpread: 0.05, sharp: 40 }) });
  frames.push({ id: 'blur', num: 'b', device: fuji, width: 6000, height: 4000, metrics: m({ sharp: 3 }) });
  frames.push({ id: 'softish', num: 's', device: fuji, width: 6000, height: 4000, metrics: m({ sharp: 90 }) });
  frames.push({ id: 'blown', num: 'w', device: fuji, width: 6000, height: 4000, metrics: m({ clipPct: 45 }) });
  frames.push({ id: 'shot', num: 'sc', device: { key: 'phone', label: 'iPhone' }, width: 1179, height: 2556, metrics: m() });
  frames.push({ id: 'magenta', num: 'mg', device: fuji, width: 6000, height: 4000, metrics: m({ tint: -0.05 }) });
  frames.push({ id: 'kept', num: 'k', device: fuji, width: 6000, height: 4000, status: 'keep', metrics: m({ sharp: 2 }) });
  // a twin pair via identical hashes
  frames.push({ id: 'twA', num: 'ta', device: fuji, width: 6000, height: 4000, metrics: m({ dhash: 'ffff0000ffff0000', sharp: 500 }) });
  frames.push({ id: 'twB', num: 'tb', device: fuji, width: 6000, height: 4000, metrics: m({ dhash: 'ffff0000ffff0001', sharp: 300 }) });
  // a loose stack member (8 bits apart) and a soft-but-blank frame are not cuts
  frames.push({ id: 'loose', num: 'lo', device: fuji, width: 6000, height: 4000, metrics: m({ dhash: 'ffff0000ffff00ff', sharp: 200 }) });
  frames.push({ id: 'wall', num: 'wl', device: fuji, width: 6000, height: 4000, metrics: m({ sharp: 2, lumSpread: 0.1 }) });
  const r = CS.likelyCuts(frames);
  assert.ok(r.ranked.includes('twB') && !r.ranked.includes('twA'), 'weaker twin flagged, stronger not');
  assert.equal(r.twins.twB, 'twA');
  for (const id of ['pocket', 'blur', 'softish', 'shot']) assert.ok(r.ranked.includes(id), id + ' should be flagged: ' + JSON.stringify(r.ranked));
  assert.ok(!r.ranked.includes('blown') && r.borderline.includes('blown'), 'exposure alone is borderline, never on the list');
  assert.ok(!r.ranked.includes('kept'), 'decided frames are never flagged');
  assert.ok(!r.ranked.includes('loose') && !r.ranked.includes('wall'), 'loose twins and blank frames are not cuts');
  assert.ok(!r.ranked.includes('magenta'), 'a colour cast alone is too weak to make the list');
  assert.ok(r.ranked.length <= r.cap + 1, 'tiny: at most ~10% plus twins');
  assert.equal(r.ranked[0], 'twB');
  assert.match(CS.cutReasons(r, 'pocket')[0].text, /pocket shot/);
  assert.match(CS.cutReasons(r, 'twB')[0].text, /softer twin of ta/);
  assert.match(CS.cutReasons(r, 'shot')[0].text, /screenshot-shaped/);
  // a deliberately dark set is not flagged wholesale: darkness is judged absolutely only when flat
  const lowKey = Array.from({ length: 10 }, (_, i) => ({ id: 'lk' + i, device: fuji, width: 6000, height: 4000, metrics: m({ lumMedian: 0.08, lumSpread: 0.5 }) }));
  assert.deepEqual(CS.likelyCuts(lowKey).ranked, []);
});

test('bursts: same camera within 4 s chain into a stack, in time order', () => {
  const f = (id, key, sec) => ({ id, device: { key }, capture: { ms: sec == null ? null : Date.UTC(2026, 0, 1, 0, 0, 0) + sec * 1000 } });
  const r = CS.bursts([f('a', 'fuji', 0), f('b', 'fuji', 3), f('c', 'fuji', 6), f('d', 'fuji', 30), f('p', 'phone', 4), f('q', 'phone', 5), f('x', 'fuji', null)]);
  assert.deepEqual(r.groups[r.groupOf.a], ['a', 'b', 'c']);
  assert.equal(r.groupOf.d, undefined);
  assert.deepEqual(r.groups[r.groupOf.p], ['p', 'q']);
  assert.equal(r.groupOf.x, undefined);
});

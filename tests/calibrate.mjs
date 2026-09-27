// Calibration against the radar station set (tests/expected.json).
// Measures every fixture with the page's own measuring code inside Chromium. Flags compare each
// frame with its own camera's median (as the page does); set medians are checked unflagged.
// If a check misses, fix the metric definitions in the core script, not the thresholds.
//   npm run calibrate                 (fixtures in tests/fixtures/radar-station)
//   FIXTURE_DIR=/path/to/exports npm run calibrate
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCore, loadPlaywright, coreSource } from './lib/core.mjs';

const CS = loadCore();
const root = fileURLToPath(new URL('..', import.meta.url));
const expected = JSON.parse(readFileSync(join(root, 'tests/expected.json'), 'utf8'));
const dir = resolve(root, process.env.FIXTURE_DIR || expected.fixtureDir);

if (!existsSync(dir)) {
  console.error(`No fixtures at ${dir}.\nCopy the ${expected.set} Lightroom exports there (it is gitignored) or set FIXTURE_DIR.`);
  process.exit(2);
}
const names = readdirSync(dir).filter((n) => /\.(jpe?g|png|webp)$/i.test(n) && n[0] !== '.');
if (!names.length) { console.error(`No images in ${dir}`); process.exit(2); }

const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
let frames;
try {
  const page = await browser.newPage();
  await page.setContent('<!doctype html><title>calibrate</title>');
  await page.addScriptTag({ content: coreSource() });
  frames = [];
  for (const name of names) {
    const bytes = readFileSync(join(dir, name));
    const r = await page.evaluate(async (b64) => {
      const bin = atob(b64), u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      const res = await CS.measureBlob(new Blob([u]), false);
      return { metrics: res.metrics, exif: res.exif, width: res.width, height: res.height };
    }, bytes.toString('base64'));
    frames.push({ id: name, name, ...r, capture: CS.captureTime(r.exif, 0, null), device: CS.device(r.exif) });
  }
} finally {
  await browser.close();
}

frames.sort((a, b) => (a.capture.ms ?? 0) - (b.capture.ms ?? 0) || a.name.localeCompare(b.name));   // index = capture order
frames.forEach((f) => { f.raw = CS.isRaw(f.name); });
const bases = CS.cameraBaselines(frames);
const base = bases.set;
const flagsOf = (f) => (f.raw ? [] : CS.frameFlags(f.metrics, CS.baselineFor(f, bases)));
const dups = CS.twins(frames);
const pad = (s, n) => String(s).padEnd(n);
const num = (v, d) => (v == null ? '–' : v.toFixed(d)).padStart(7);

console.log(`\n${expected.set}: ${frames.length} frames; flags against each camera's median (${Object.keys(bases.byCamera).length} camera(s))\n`);
console.log(pad('#', 4) + pad('file', 28) + '    sat  spread   clip%  crush%      rb    tint  dup  device / flags');
frames.forEach((f, i) => {
  const m = f.metrics, fl = flagsOf(f).map((x) => x.text).join(', ');
  console.log(pad(i + 1, 4) + pad(f.name.slice(0, 27), 28) + num(m.sat, 3) + num(m.lumSpread, 3) + num(m.clipPct, 1) +
    num(m.crushPct, 1) + num(m.rb, 3) + num(m.tint, 3) + '  ' + pad(dups.groupOf[f.id] || '', 4) + ' ' +
    f.device.label + (fl ? '  ⚑ ' + fl : ''));
});
console.log(pad('', 4) + pad('median', 28) + num(base.sat, 3) + num(base.lumSpread, 3) + num(base.clipPct, 1) +
  num(base.crushPct, 1) + num(base.rb, 3) + num(base.tint, 3) + '\n');

const results = [];
const check = (label, ok, detail) => results.push({ label, ok, detail });
for (const [key, want] of Object.entries(expected.setMedian || {})) {
  const got = base[key];
  check(`set median ${key} ≈ ${want.expected}`, Math.abs(got - want.expected) <= want.tolerance,
    `got ${got.toFixed(3)} (±${want.tolerance})`);
}
function findFrame(sel) {
  if (sel.index != null) return frames[sel.index - 1];
  const hits = frames.filter((f) => f.name.includes(sel.name)).sort((a, b) => a.name.length - b.name.length);
  return hits[0];
}
for (const e of expected.frames || []) {
  const f = findFrame(e.frame);
  if (!f) { check(e.label, false, `no frame matches ${JSON.stringify(e.frame)}`); continue; }
  const flags = flagsOf(f), fb = CS.baselineFor(f, bases) || base;
  if (e.flag) {
    const hit = flags.find((x) => x.key === e.flag.key && (!e.flag.text || x.text === e.flag.text));
    const m = CS.METRICS.find((x) => x.key === e.flag.key);
    check(`${e.label} (${f.name}) flagged ${e.flag.text || e.flag.key}`, !!hit,
      `${e.flag.key} ${f.metrics[e.flag.key].toFixed(m.fmt + 1)} vs its camera's median ${fb[e.flag.key].toFixed(m.fmt + 1)}` +
      (flags.length ? `; flags: ${flags.map((x) => x.text).join(', ')}` : '; no flags'));
  }
  if (e.value) {
    const got = f.metrics[e.value.key];
    check(`${e.label} (${f.name}) ${e.value.key} ≈ ${e.value.expected}`, Math.abs(got - e.value.expected) <= e.value.tolerance,
      `got ${got.toFixed(2)} (±${e.value.tolerance})`);
  }
}
for (const r of results) console.log(`${r.ok ? 'PASS' : 'MISS'}  ${r.label}  ·  ${r.detail}`);
const misses = results.filter((r) => !r.ok).length;
console.log(misses ? `\n${misses} miss(es): adjust metric definitions, not thresholds.` : '\ncalibrated');
process.exit(misses ? 1 : 0);

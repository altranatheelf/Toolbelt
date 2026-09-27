// Scale check: a couple hundred full-size frames on an emulated iPhone (touch, iPhone UA, so the
// page uses its one-decode-at-a-time phone path). Reports load, measure and tap-to-next timings.
// This is Chromium emulation on this machine, not Safari on a phone: timings are indicative.
// Run: npm run scale   (N=200 W=4000 H=3000 to change the pool)
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadCore, loadPlaywright, HTML_PATH } from './lib/core.mjs';

const CS = loadCore();
const { chromium, devices } = await loadPlaywright();
const N = +(process.env.N || 200), W = +(process.env.W || 4000), H = +(process.env.H || 3000);
const dir = mkdtempSync(join(tmpdir(), 'carousel-scale-'));
const browser = await chromium.launch();
const t = () => performance.now();
try {
  // generate the pool: three cameras, file-number names, full-size JPEGs
  const gen = await browser.newPage();
  const names = [];
  let t0 = t();
  for (let i = 0; i < N; i++) {
    const cam = i % 5 === 4 ? 'phone' : i % 3 === 0 ? 'digi' : 'main';
    const name = cam === 'digi' ? `103_${String(200 + i).padStart(4, '0')}.JPG` : cam === 'phone' ? `IMG_${4000 + i}.JPG` : `IMG_${9000 + i}.JPG`;
    const bytes = await gen.evaluate(async ({ i, W, H }) => {
      const c = new OffscreenCanvas(W, H), g = c.getContext('2d');
      let s = (i + 1) * 7919; const r = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
      const grd = g.createLinearGradient(0, 0, 0, H); grd.addColorStop(0, `hsl(${200 + r() * 30},25%,${55 + r() * 20}%)`); grd.addColorStop(1, `hsl(${20 + r() * 30},20%,${25 + r() * 20}%)`);
      g.fillStyle = grd; g.fillRect(0, 0, W, H);
      for (let k = 0; k < 40; k++) { g.fillStyle = `hsl(${r() * 360},${r() * 40}%,${20 + r() * 60}%)`; g.fillRect(r() * W, r() * H, r() * W / 3, r() * H / 3); }
      const b = await c.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
      return Array.from(new Uint8Array(await b.arrayBuffer()));
    }, { i, W, H });
    const exif = cam === 'digi' ? { make: 'Canon', model: 'Canon PowerShot SD1000' } : cam === 'phone' ? { make: 'Apple', model: 'iPhone 15 Pro' } : { make: 'FUJIFILM', model: 'X-T5' };
    writeFileSync(join(dir, name), CS.insertApp1(new Uint8Array(bytes), CS.buildExifApp1({ ...exif, date: Date.UTC(2026, 0, 1, 0, 0, i) })));
    names.push(join(dir, name));
  }
  await gen.close();
  console.log(`generated ${N} × ${W}×${H} JPEGs in ${((t() - t0) / 1000).toFixed(1)} s`);

  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(pathToFileURL(HTML_PATH).href);
  await page.waitForFunction(() => window.__cs && window.__cs.state.example && window.__cs.state.frames.every((f) => f.measure === 'done'), null, { timeout: 60000 });

  t0 = t();
  await page.setInputFiles('#photosIn', names);
  await page.waitForFunction((n) => window.__cs.state.frames.length === n && document.querySelectorAll('#grid .card').length > 0, N, { timeout: 120000 });
  const listed = t() - t0;
  await page.waitForFunction(() => window.__cs.state.frames.every((f) => f.measure === 'done' || f.measure === 'error'), null, { timeout: 30 * 60000, polling: 1000 });
  const measured = t() - t0;
  const errs = await page.evaluate(() => window.__cs.state.frames.filter((f) => f.measure === 'error').map((f) => f.name + ': ' + f.error));
  assert.deepEqual(errs, []);
  const order = await page.evaluate(() => window.__cs.state.frames.map((f) => f.name));
  assert.deepEqual(order, names.map((p) => p.split('/').pop()), 'order added, names untouched');

  // culling speed: tap Keep/Out 40 times in the loupe
  await page.tap('#grid .card');
  await page.waitForSelector('#loupe:not([hidden])');
  const taps = [];
  for (let i = 0; i < 40; i++) {
    const before = await page.textContent('#lName');
    const s0 = t();
    await page.tap(i % 3 ? '#lKeep' : '#lOut');
    await page.waitForFunction((b) => document.querySelector('#lName').textContent !== b, before);
    taps.push(t() - s0);
  }
  taps.sort((a, b) => a - b);
  // scrolling the whole grid
  await page.tap('#lClose');
  await page.tap('#filterSeg [data-f="all"]');
  const cards = await page.$$eval('#grid .card', (els) => els.length);
  const heap = await page.evaluate(() => performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null);
  console.log(JSON.stringify({
    frames: N, size: `${W}x${H}`, listedMs: Math.round(listed), measuredSec: +(measured / 1000).toFixed(1),
    perFrameMs: Math.round(measured / N), tapToNextMs: { median: Math.round(taps[20]), p90: Math.round(taps[36]), max: Math.round(taps[39]) },
    cardsInAllView: cards, jsHeapMB: heap, pageErrors: errors
  }, null, 1));
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
}

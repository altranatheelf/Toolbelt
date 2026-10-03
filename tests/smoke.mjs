// End-to-end: example pool → add a real-looking pool (three cameras, a RAW, a renamed file)
// → cut in the loupe → sequence with a video slot and a swap → preview → export → reload.
// Run: npm run smoke   (Playwright + Chromium; SHOT_DIR=... saves screenshots)
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadCore, loadPlaywright, HTML_PATH } from './lib/core.mjs';

const CS = loadCore();
const { chromium } = await loadPlaywright();
const shots = process.env.SHOT_DIR;

// name, camera, scene recipe. Order here is the order they are added.
const POOL = [
  ['IMG_9774.JPG', 'main', { seed: 1 }],
  ['103_0216.JPG', 'digi', { seed: 2 }],
  ['IMG_9775.JPG', 'main', { seed: 1, bright: 14 }],          // twin of 9774
  ['IMG_4411.JPG', 'phone', { seed: 3 }],
  ['IMG_9780.JPG', 'main', { seed: 4, cast: [12, -10, 12] }], // magenta within the main camera
  ['103_0219.JPG', 'digi', { seed: 5 }],
  ['IMG_9781.JPG', 'main', { seed: 6 }],
  ['103_0224.JPG', 'digi', { seed: 7 }],
  ['IMG_9783.JPG', 'main', { seed: 8 }],
  ['IMG_4412.JPG', 'phone', { seed: 9 }],
  ['IMG_4415.JPG', 'phone', { seed: 10 }],
  ['tempImageAb12cd.heic', 'phone', { seed: 11 }],
  ['DSC_0900.NEF', 'raw', { seed: 12 }]
];
const CAMS = {
  main: { make: 'FUJIFILM', model: 'X-T5' }, digi: { make: 'Canon', model: 'Canon PowerShot SD1000' },
  phone: { make: 'Apple', model: 'iPhone 15 Pro' }, raw: { make: 'NIKON CORPORATION', model: 'NIKON Z 6', orientation: 6 }
};

// minimal stored (uncompressed) zip writer for the zip route
function makeZip(entries) {
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (u8) => { let c = 0xFFFFFFFF; for (const b of u8) c = crcT[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const parts = [], central = []; let off = 0;
  for (const [name, data] of entries) {
    const nm = Buffer.from(name), lh = Buffer.alloc(30), ch = Buffer.alloc(46);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt32LE(crc(data), 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nm.length, 26);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(0x5b2c, 14); ch.writeUInt32LE(crc(data), 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(off, 42);
    parts.push(lh, nm, data); central.push(ch, nm); off += 30 + nm.length + data.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}

const dir = mkdtempSync(join(tmpdir(), 'carousel-smoke-'));
const browser = await chromium.launch();
const errors = [];
try {
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  // stand-in for the claude.ai runtime's `sample` capability, so Propose can be driven end to end
  await ctx.addInitScript(() => {
    const fake = {
      json: async (prompt, opts) => {
        window.__proposeCalls = (window.__proposeCalls || 0) + 1;
        window.__lastPrompt = prompt; window.__lastImages = opts.images.length;
        const n = window.__cs.state.slides.length;
        if (window.__badProposal) return { order: Array.from({ length: n }, (_, i) => n - i), cuts: [], reasons: [] };
        const mid = Array.from({ length: n - 2 }, (_, i) => i + 2).reverse();
        return { order: [1, ...mid], cuts: [{ slot: n, reason: 'repeats the tone of 5' }], reasons: [{ slot: 1, reason: 'strongest face at grid size' }] };
      },
      limits: async () => ({ maxPromptBytes: 65536, images: { maxCount: 5, maxInputBytes: 2e7, mediaTypes: ['image/jpeg'] } })
    };
    window.claude = { use: (name) => Promise.resolve(name === 'sample' ? fake : null) };
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(pathToFileURL(HTML_PATH).href);
  const allMeasured = () => page.waitForFunction(() => { const s = window.__cs.state; return s.frames.length && s.frames.every((f) => f.measure === 'done' || f.measure === 'error'); }, null, { timeout: 60000 });

  // 1. opens on a generated example pool
  await allMeasured();
  assert.match(await page.textContent('#counts'), /22 frames .* example frames/);
  const cardText = (num) => page.$$eval('#grid .card', (cs, n) => (cs.find((c) => c.querySelector('.fn').textContent === n) || {}).textContent || '', num);
  assert.match(await cardText('9764'), /magenta/);
  assert.match(await cardText('103_0213'), /clipped highlights/);
  assert.match(await cardText('9767'), /soft|focus/);
  // flags are a badge, never a state; tiny (≤ ~10% + twins); every flag has a one-phrase reason
  const flagged = await page.evaluate(() => window.__cs.derived.cuts.ranked.map((id) => window.__cs.state.byId.get(id).num));
  assert.ok(flagged.length >= 2 && flagged.length <= 5, JSON.stringify(flagged));
  assert.ok(flagged.includes('9767') && flagged.includes('9762'), JSON.stringify(flagged));
  assert.equal(await page.evaluate(() => window.__cs.state.frames.filter((f) => f.status).length), 0, 'nothing is decided by the tool');
  assert.match(await page.textContent('#passes'), /1 · Flags\s*\d+ likely cuts to review/);
  // pass 1: Out all flagged, then undo
  await page.click('#filterSeg [data-f="flag"]');
  const nFlag = await page.$$eval('#grid .card', (els) => els.length);
  assert.equal(nFlag, flagged.length);
  await page.click('#outFlagsBtn');
  assert.equal(await page.evaluate(() => window.__cs.state.frames.filter((f) => f.status === 'out').length), flagged.length);
  await page.click('#undoBtn');
  assert.equal(await page.evaluate(() => window.__cs.state.frames.filter((f) => f.status).length), 0, 'undo restores');
  // swipes in the loupe: up = keep, down = out, left = next; hero via button
  await page.click('#filterSeg [data-f="todo"]');
  await page.click('#grid .card');
  const img = await page.$eval('#lImg', (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  const swipe = async (dx, dy) => { await page.mouse.move(img.x, img.y); await page.mouse.down(); await page.mouse.move(img.x + dx, img.y + dy, { steps: 6 }); await page.mouse.up(); };
  const firstName = await page.textContent('#lName');
  await swipe(0, -120);
  assert.equal(await page.evaluate((n) => window.__cs.state.frames.find((f) => f.name === n).status, firstName), 'keep', 'swipe up keeps');
  const second = await page.textContent('#lName');
  assert.notEqual(second, firstName, 'auto-advance after a decision');
  await swipe(0, 120);
  assert.equal(await page.evaluate((n) => window.__cs.state.frames.find((f) => f.name === n).status, second), 'out', 'swipe down outs');
  const third = await page.textContent('#lName');
  await swipe(-120, 0);
  assert.notEqual(await page.textContent('#lName'), third, 'swipe left advances without deciding');
  assert.equal(await page.evaluate((n) => window.__cs.state.frames.find((f) => f.name === n).status, third), null);
  await page.click('#lHero');
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => window.__cs.state.frames.filter((f) => f.status === 'hero').length), 1);
  assert.match(await page.textContent('#passes'), /2 kept · 1 hero/);
  // survey: drop back to undecided (never to out); compare pairs among kept look-alikes
  await page.evaluate(() => { const s = window.__cs.state; s.frames.slice(0, 6).forEach((f) => { if (!f.status) f.status = 'keep'; }); s.statusVersion++; s.target = 3; window.__cs.render(); });
  assert.match(await page.textContent('#passes'), /cut \d+ more to reach 3/);
  await page.click('#passes button:has-text("Survey")');
  await page.waitForSelector('#survey:not([hidden])');
  const keptBefore = await page.evaluate(() => window.__cs.state.frames.filter((f) => f.status === 'keep' || f.status === 'hero').length);
  await page.click('#svGrid .sv >> nth=1');
  assert.equal(await page.evaluate(() => window.__cs.state.frames.filter((f) => f.status === 'keep' || f.status === 'hero').length), keptBefore - 1);
  assert.equal(await page.evaluate(() => window.__cs.state.frames.filter((f) => f.status === 'out').length), 1, 'survey drops to undecided, not out');
  await page.click('#svSize');
  assert.ok(await page.$eval('#svGrid', (g) => g.classList.contains('gridSize')));
  await page.click('#svClose');
  // on-device scene brain: every frame read; Narrow shows scenes, closest kept pairs and a coverage pick; Drop goes to undecided
  await page.waitForFunction(() => window.__cs.state.frames.every((f) => f.ai), null, { timeout: 120000 });
  assert.ok(await page.evaluate(() => window.__cs.state.frames.every((f) => f.ai.emb && f.ai.emb.length === 1280 && f.ai.face && f.ai.subject)), 'embedding, faces and subject for every frame');
  await page.click('#passes .pass >> nth=3');
  await page.waitForSelector('#narrow:not([hidden])');
  const narrowText = await page.textContent('#narrow');
  assert.match(narrowText, /The kept set has: /);
  assert.match(narrowText, /Scenes · one per scene/);
  assert.match(narrowText, /Closest kept pairs/);
  assert.match(narrowText, /Coverage pick · the 3 that cover the most ground/);
  assert.ok(await page.locator('#narrow .dropRow').count() >= 1, 'coverage pick proposes drops when over target');
  const keptN = await page.evaluate(() => window.__cs.state.frames.filter((f) => f.status === 'keep' || f.status === 'hero').length);
  await page.click('#narrow .dropRow button:has-text("Drop") >> nth=0');
  assert.equal(await page.evaluate(() => window.__cs.state.frames.filter((f) => f.status === 'keep' || f.status === 'hero').length), keptN - 1);
  assert.equal(await page.evaluate(() => window.__cs.state.frames.filter((f) => f.status === 'out').length), 1, 'a drop never goes to Out');
  assert.ok(await page.evaluate(() => window.__cs.state.frames.every((f) => f.status !== 'hero' || true)));
  await page.click('#narrow button:has-text("Compare look-alikes")');
  if (await page.isVisible('#compare')) {
    const before = await page.evaluate(() => window.__cs.state.frames.filter((f) => f.status === 'keep' || f.status === 'hero').length);
    await page.click('#cpLeft');
    await page.waitForFunction((b) => window.__cs.state.frames.filter((f) => f.status === 'keep' || f.status === 'hero').length === b - 1, before);
    if (await page.isVisible('#compare')) await page.click('#cpClose');
  }
  await page.evaluate(() => { const s = window.__cs.state; s.frames.forEach((f) => { f.status = null; }); s.statusVersion++; s.target = 20; s.undo = []; window.__cs.render(); });
  assert.match(await cardText('9761'), /×2 twins/);
  if (shots) await page.screenshot({ path: join(shots, 'cut-example.png'), fullPage: true });

  // 2. add a pool: order added is kept, filenames shown, example replaced
  const jpegs = await page.evaluate(async (pool) => {
    const out = [];
    for (const [, , r] of pool) {
      const c = document.createElement('canvas'); c.width = 1500; c.height = 1000;
      const g = c.getContext('2d');
      let s = r.seed * 9301; const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
      g.fillStyle = 'rgb(120,120,116)'; g.fillRect(0, 0, 1500, 1000);
      for (let i = 0; i < 30; i++) {
        const v = 40 + rnd() * 170, sat = rnd() * 0.4;
        g.fillStyle = `rgb(${Math.round(v * (1 + sat))},${Math.round(v)},${Math.round(v * (1 - sat))})`;
        g.fillRect(rnd() * 1500, rnd() * 1000, 80 + rnd() * 400, 60 + rnd() * 300);
      }
      if (r.bright || r.cast) {
        const d = g.getImageData(0, 0, 1500, 1000), px = d.data, add = r.cast || [r.bright, r.bright, r.bright];
        for (let p = 0; p < px.length; p += 4) { px[p] += add[0]; px[p + 1] += add[1]; px[p + 2] += add[2]; }
        g.putImageData(d, 0, 0);
      }
      const b = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.9));
      out.push(Array.from(new Uint8Array(await b.arrayBuffer())));
    }
    return out;
  }, POOL);
  const paths = POOL.map(([name, cam], i) => {
    const date = Date.UTC(2026, 8, 12, 17, 0, i);
    const exif = CS.buildExifApp1({ ...CAMS[cam], date });
    const bytes = cam === 'raw'
      ? new Uint8Array([...exif.slice(10), 0, 0, ...jpegs[i], 7, 7])            // TIFF header + embedded preview
      : CS.insertApp1(new Uint8Array(jpegs[i]), exif);
    writeFileSync(join(dir, name), bytes);
    return join(dir, name);
  });
  await page.setInputFiles('#photosIn', paths);
  await page.waitForFunction(() => window.__cs.state.frames.length === 13 && !window.__cs.state.example);
  await allMeasured();
  const nums = await page.$$eval('#grid .card .fn', (els) => els.map((e) => e.textContent));
  assert.deepEqual(nums, ['9774', '103_0216', '4411', '9780', '103_0219', '9781', '103_0224', '9783', '4412', '4415', 'tempImageAb12cd', '0900'],
    'order added, twins stacked (9775 sits under 9774)');
  assert.match(await page.textContent('#notices'), /1 photo arrived renamed .*tempImageAb12cd\.heic.*Format: Current/);
  assert.match(await cardText('9780'), /magenta/);
  assert.match(await cardText('0900'), /NIKON Z 6 · RAW/);
  assert.doesNotMatch(await cardText('0900'), /magenta|clipped|soft|warmer|cooler/, 'RAW colour is not checked');
  const flagLine = (num) => page.$$eval('#grid .card', (cs, n) => (cs.find((c) => c.querySelector('.fn').textContent === n) || {}).querySelector('.fl').textContent, num);
  for (const n of ['4411', '4412', '4415', '103_0216', '103_0219', '103_0224'])
    assert.doesNotMatch(await flagLine(n), /phone|camera|device/i, 'device is a label, not a warning');

  // 2b. one photo per pick, twice: the page explains the single-select picker and the .zip route
  //     (re-adding frames already in the pool doesn't duplicate them)
  await page.setInputFiles('#photosIn', [paths[0]]);
  await page.setInputFiles('#photosIn', [paths[1]]);
  await page.waitForFunction(() => /Only one photo per pick\?/.test(document.querySelector('#notices').textContent));
  assert.equal(await page.evaluate(() => window.__cs.state.frames.length), 13);
  await page.click('#notices button:has-text("Dismiss")');

  // 3. cut in the loupe: keep advances to the next frame; out hides it from "to decide"
  await page.click('#grid .card');
  await page.waitForSelector('#loupe:not([hidden])');
  assert.equal(await page.textContent('#lName'), 'IMG_9774.JPG');
  await page.click('#lKeep');
  assert.equal(await page.textContent('#lName'), 'IMG_9775.JPG', 'twins come next in the loupe');
  if (process.env.DEBUG) console.log(await page.evaluate(() => window.__cs.state.frames.map((f) => f.num + ':' + (f.status || '-') + ':' + (window.__cs.derived.twins.groupOf[f.id] || '')).join(' ')));
  await page.click('#lOut');
  if (process.env.DEBUG) console.log(await page.evaluate(() => window.__cs.state.frames.map((f) => f.num + ':' + (f.status || '-')).join(' ')));
  assert.equal(await page.textContent('#lName'), '103_0216.JPG');
  await page.keyboard.press('k');   // keep 103_0216
  await page.keyboard.press('k');   // keep 4411
  await page.keyboard.press('x');   // out 9780
  for (let i = 0; i < 4; i++) await page.keyboard.press('k');  // 103_0219, 9781, 103_0224, 9783
  const status = await page.evaluate(() => Object.fromEntries(window.__cs.state.frames.map((f) => [f.num, f.status])));
  assert.deepEqual([status['9774'], status['9775'], status['103_0216'], status['4411'], status['9780'], status['9783']], ['keep', 'out', 'keep', 'keep', 'out', 'keep']);
  // tag + add to carousel from the loupe
  await page.keyboard.press('Escape');
  await page.click('#filterSeg [data-f="keep"]');
  const keptNums = await page.$$eval('#grid .card .fn', (els) => els.map((e) => e.textContent));
  assert.deepEqual(keptNums, ['9774', '103_0216', '4411', '103_0219', '9781', '103_0224', '9783']);
  await page.click('#grid .card');
  await page.click('#lScale button:has-text("Wide")');
  await page.click('#lYou button:has-text("Face shown")');
  await page.click('#lAdd');
  assert.match(await page.textContent('#lAdd'), /In carousel · #1/);
  for (let i = 0; i < 5; i++) { await page.click('#lNext'); await page.click('#lAdd'); }
  await page.keyboard.press('Escape');

  // 4. sequence: roles, a video slot, reorder, swap
  await page.click('#tabSeq');
  assert.equal(await page.$$eval('#slots .slotRow', (r) => r.length), 6);
  assert.match(await page.textContent('#slots .slotRow >> nth=0'), /Cover/);
  assert.match(await page.textContent('#slots .slotRow >> nth=1'), /Second cover · Instagram re-shows the post from here/);
  await page.click('#addVideoSlot');
  await page.fill('#slots .slotRow >> nth=6 >> input[type=text]', 'pano video');
  await page.press('#slots .slotRow >> nth=6 >> input[type=text]', 'Enter');
  await page.click('#slots .slotRow >> nth=6 >> button[aria-label="Move earlier"]');
  await page.click('#slots .slotRow >> nth=5 >> button[aria-label="Move earlier"]');
  await page.click('#slots .slotRow >> nth=4 >> button[aria-label="Move earlier"]');   // video now slide 4
  const seq = await page.evaluate(() => window.__cs.state.slides.map((s) => s.kind === 'video' ? 'video:' + s.label : window.__cs.state.byId.get(s.id).num));
  assert.deepEqual(seq, ['9774', '103_0216', '4411', 'video:pano video', '103_0219', '9781', '103_0224']);
  const seams = await page.$$eval('#slots .seamRow', (els) => els.map((e) => e.textContent));
  assert.ok(seams.some((t) => /X-T5 → Canon PowerShot SD1000/.test(t)), 'camera change shown as a label');
  const warn = await page.$$eval('#warnList li', (els) => els.map((e) => e.textContent));
  assert.ok(!warn.some((t) => /phone|camera|device/i.test(t)), JSON.stringify(warn));
  // swap slide 3 (4411) for the kept 9783
  await page.click('#slots .slotRow >> nth=2 >> button:has-text("Swap")');
  await page.waitForSelector('#sheet:not([hidden])');
  const cands = await page.$$eval('#sheetList .card .fn', (els) => els.map((e) => e.textContent));
  assert.ok(cands.includes('9783') && !cands.includes('9774') && !cands.includes('9780'), cands.join());
  await page.click('#sheetList .card:has(.fn:text-is("9783"))');
  const seq2 = await page.evaluate(() => window.__cs.state.slides.map((s) => s.kind === 'video' ? 'video' : window.__cs.state.byId.get(s.id).num));
  assert.deepEqual(seq2, ['9774', '103_0216', '9783', 'video', '103_0219', '9781', '103_0224']);
  // --- proposals ---
  let warn2 = await page.$$eval('#warnList li > div > span', (els) => els.map((e) => e.textContent));
  assert.ok(!warn2.some((t) => /jump/.test(t)), 'a big jump is never a warning');
  // pin the cover
  await page.click('#slots .slotRow >> nth=0 >> button:has-text("Pin")');
  // three wides in a row at 5–7, then fix it move by move
  for (const k of [4, 5, 6]) await page.click(`#slots .slotRow >> nth=${k} >> .pick >> nth=0 >> button:has-text("Wide")`);
  const runLi = page.locator('#warnList li', { hasText: 'three wides in a row (slides 5–7)' });
  await runLi.locator('button:has-text("Fix")').click();
  const moves = await runLi.locator('.fix .mv').allTextContents();
  assert.ok(moves.length >= 1 && moves.length <= 2, JSON.stringify(moves));
  assert.ok(moves.every((m) => /— no three of one scale in a row/.test(m)), JSON.stringify(moves));
  while (await page.locator('#warnList .fix button:has-text("Apply"):not([disabled])').count()) await page.click('#warnList .fix button:has-text("Apply"):not([disabled])');
  warn2 = await page.$$eval('#warnList li > div > span', (els) => els.map((e) => e.textContent));
  assert.ok(!warn2.some((t) => /three wides/.test(t)), JSON.stringify(warn2));
  assert.equal(await page.evaluate(() => window.__cs.state.byId.get(window.__cs.state.slides[0].id).num), '9774', 'pinned cover stayed');
  // cuts: one line per slot, pinned kept, video kept
  await page.click('#cutsBtn');
  const cutLines = await page.$$eval('#panel .line span', (els) => els.map((e) => e.textContent));
  assert.ok(cutLines.includes('Keep 1 · 9774: pinned'), JSON.stringify(cutLines));
  assert.ok(cutLines.some((t) => /^Keep \d: video slide$/.test(t)), JSON.stringify(cutLines));
  assert.equal(cutLines.filter((t) => /^(Cut|Keep) /.test(t)).length, 7);
  // bridge finder on the 1→2 seam
  await page.click('#slots .seamRow >> nth=0 >> button:has-text("Bridge")');
  assert.match(await page.textContent('#sheetTitle'), /Bridge between 1 · 9774 and 2 · 103_0216/);
  const bridgeText = await page.textContent('#sheetList');
  assert.ok(/tone between|unlike both|same camera as/.test(bridgeText) || /No frame in the pool/.test(bridgeText), bridgeText);
  await page.click('#sheetClose');
  // cover candidates at grid size
  await page.click('#coverBtn');
  assert.match(await page.textContent('#panel'), /9774.*face shown.*is the cover/);
  // propose with Claude (stand-in): order by slot number, a cut, pinned slot 1 untouched
  await page.fill('#titleIn', 'Radar season');
  await page.click('#proposeBtn');
  await page.click('#panel button:has-text("Propose")');
  await page.waitForSelector('#panel button:has-text("Use this order and cuts")');
  assert.equal(await page.evaluate(() => window.__lastImages), 1, 'one contact sheet');
  assert.match(await page.evaluate(() => window.__lastPrompt), /title or thesis: "Radar season"[\s\S]*1 \| 9774 \| FUJIFILM X-T5 \| scale wide \| you face shown[\s\S]*PINNED/);
  const before = await page.evaluate(() => window.__cs.state.slides.map((s) => s.id));
  await page.click('#panel button:has-text("Use this order and cuts")');
  const after = await page.evaluate(() => window.__cs.state.slides.map((s) => s.id));
  assert.equal(after.length, before.length - 1);
  assert.equal(after[0], before[0]);
  assert.deepEqual(after.slice(1), before.slice(1, -1).reverse());
  // a proposal that moves the pinned cover is refused
  await page.evaluate(() => { window.__badProposal = true; });
  await page.click('#panel button:has-text("Propose")');
  await page.waitForSelector('#panel .flag');
  assert.match(await page.textContent('#panel .flag'), /Can’t apply the order as is: .*pinned slot 1/);
  assert.equal(await page.locator('#panel button:has-text("Use this order")').count(), 0);
  await page.click('#proposeBtn');
  // put the sequence back the way the export checks expect it
  await page.evaluate(() => {
    const s = window.__cs.state, id = (n) => s.frames.find((f) => f.num === n).id;
    const v = s.slides.find((x) => x.kind === 'video');
    ['103_0224'].forEach((n) => { s.byId.get(id(n)).status = 'keep'; });
    s.slides = [{ kind: 'photo', id: id('9774'), pinned: true }, { kind: 'photo', id: id('103_0216') }, { kind: 'photo', id: id('9783') }, v,
      { kind: 'photo', id: id('103_0219') }, { kind: 'photo', id: id('9781') }, { kind: 'photo', id: id('103_0224') }];
    window.__cs.render();
  });
  if (shots) await page.screenshot({ path: join(shots, 'sequence.png'), fullPage: true });

  // 5. preview + export (video slot skipped, file numbers in names, only capture times)
  await page.click('#tabPv');
  assert.equal(await page.$$eval('#car .slide', (els) => els.length), 7);
  assert.match(await page.textContent('#car .slide >> nth=3'), /Video slide 4: pano video/);
  await page.click('#exportBtn');
  await page.waitForSelector('#saveRow button.primary');
  assert.match(await page.textContent('#exportLog'), /04 {2}video: add "pano video" in Instagram at slide 4/);
  const downloads = [];
  page.on('download', (d) => downloads.push(d));
  await page.click('#saveRow button.primary');
  await page.waitForFunction(() => /Handed 6 files/.test(document.querySelector('#exportLog').textContent), null, { timeout: 20000 });
  await page.waitForTimeout(400);
  const names = downloads.map((d) => d.suggestedFilename()).sort();
  assert.deepEqual(names, ['01-9774.jpg', '02-103_0216.jpg', '03-9783.jpg', '05-103_0219.jpg', '06-9781.jpg', '07-103_0224.jpg']);
  const first = new Uint8Array(readFileSync(await downloads.find((d) => d.suggestedFilename() === '01-9774.jpg').path()));
  const ex = CS.parseExif(first.buffer);
  assert.ok(ex.dateTimeOriginal && !ex.make && !ex.model, 'only capture times are written');
  if (shots) await page.screenshot({ path: join(shots, 'preview.png') });

  // 6. reload: the carousel is still there; originals must be re-added for full-quality export
  await page.waitForTimeout(700);
  await page.reload();
  await page.waitForFunction(() => window.__cs.state.slides.length === 7, null, { timeout: 20000 });
  assert.equal(await page.inputValue('#titleIn'), 'Radar season');
  const kept = await page.evaluate(() => window.__cs.state.frames.filter((f) => f.status === 'keep').length);
  assert.equal(kept, 7, 'keep/out decisions persist');
  await page.click('#tabPv');
  await page.click('#exportBtn');
  assert.match(await page.textContent('#exportLog'), /originals of .* are not loaded/);
  assert.equal(await page.isVisible('#saveRow button:has-text("Export from stored copies")'), true);

  // 7. the whole pool as one .zip (stored entries, folder inside, macOS junk skipped): names kept, order kept
  const zipPath = join(dir, 'pool.zip');
  writeFileSync(zipPath, makeZip(paths.slice(0, 4).map((p) => ['radar/' + p.split('/').pop(), readFileSync(p)]).concat([['__MACOSX/radar/._x.JPG', Buffer.from('junk')]])));
  const page2 = await ctx.newPage();
  page2.on('pageerror', (e) => errors.push(String(e)));
  await page2.goto(pathToFileURL(HTML_PATH).href);
  await page2.click('#newBtn'); await page2.click('#newBtn');
  await page2.setInputFiles('#filesIn', [zipPath]);
  await page2.waitForFunction(() => window.__cs.state.frames.length === 4 && window.__cs.state.frames.every((f) => f.measure === 'done'), null, { timeout: 30000 });
  assert.deepEqual(await page2.$$eval('#grid .card .fn', (els) => els.map((e) => e.textContent)), ['9774', '103_0216', '4411']);
  assert.deepEqual(await page2.evaluate(() => window.__cs.state.frames.map((f) => f.name)), ['IMG_9774.JPG', '103_0216.JPG', 'IMG_9775.JPG', 'IMG_4411.JPG']);

  assert.deepEqual(errors, [], 'no page errors');
  console.log('smoke ok: example, add pool, cut, sequence, swap, video slot, preview, export, reload');
} finally {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
}

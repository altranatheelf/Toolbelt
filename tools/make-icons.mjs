// Renders the Toolbelt icon (an inline SVG) to the PNG sizes the manifest needs, with Chromium.
// Run: node tools/make-icons.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { loadPlaywright } from '../tests/lib/core.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const { chromium } = await loadPlaywright();
const svg = (pad) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" fill="#1b1b1b"/>
  <g transform="translate(${pad} ${pad}) scale(${(100 - 2 * pad) / 100})">
    <rect x="12" y="30" width="76" height="40" rx="6" fill="none" stroke="#e6e6e6" stroke-width="7"/>
    <rect x="42" y="24" width="16" height="52" rx="3" fill="#e6e6e6"/>
    <rect x="20" y="42" width="14" height="16" rx="2" fill="#e6e6e6"/>
    <rect x="66" y="42" width="14" height="16" rx="2" fill="#e6e6e6"/>
  </g></svg>`;
const b = await chromium.launch();
for (const [name, size, pad] of [['icon-192', 192, 6], ['icon-512', 512, 6], ['icon-512-maskable', 512, 18], ['icon-180', 180, 6]]) {
  const p = await b.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await p.setContent(`<body style="margin:0;background:#1b1b1b">${svg(pad).replace('<svg ', `<svg width="${size}" height="${size}" style="display:block" `)}</body>`);
  writeFileSync(join(root, 'icons', name + '.png'), await p.screenshot({ type: 'png', clip: { x: 0, y: 0, width: size, height: size } }));
  await p.close();
}
await b.close();
console.log('icons written');

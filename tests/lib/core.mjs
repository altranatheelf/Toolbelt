// Loads the core <script id="core"> block out of the single HTML file, so tests exercise
// exactly the code that ships.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const HTML_PATH = fileURLToPath(new URL('../../carousel-sequencer.html', import.meta.url));
export const html = readFileSync(HTML_PATH, 'utf8');

export function coreSource() {
  const m = /<script id="core">([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error('no <script id="core"> in carousel-sequencer.html');
  return m[1];
}

export function loadCore() {
  const mod = {};
  new Function('module', coreSource())(mod);
  return mod.exports;
}

// Playwright is optional (calibration + smoke only). Resolve a local install, then a global one.
export async function loadPlaywright() {
  try { return await import('playwright'); } catch {}
  const { execSync } = await import('node:child_process');
  const { createRequire } = await import('node:module');
  const root = execSync('npm root -g').toString().trim();
  return createRequire(root + '/')('playwright');
}

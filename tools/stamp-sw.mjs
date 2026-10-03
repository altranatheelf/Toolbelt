// Stamps sw.js with a version derived from the content of the files it caches, so every build
// that changes a module gets a new cache and installed apps pick it up. Run: node tools/stamp-sw.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url));
const sw = readFileSync(join(root, 'sw.js'), 'utf8');
const files = [...sw.matchAll(/'\.\/([^']+)'/g)].map((m) => m[1]).filter((f) => f && !f.endsWith('/'));
const h = createHash('sha256');
for (const f of files) { try { h.update(readFileSync(join(root, f))); } catch { h.update('missing:' + f); } }
const version = h.digest('hex').slice(0, 12);
writeFileSync(join(root, 'sw.js'), sw.replace(/const VERSION = '[^']*';/, `const VERSION = '${version}';`));
console.log('sw.js version', version, 'over', files.length, 'files');

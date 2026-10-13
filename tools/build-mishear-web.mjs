// Builds modules/mishear.html from modules/mishear-web/: the page template, transformers.js (fetched
// once at build time, pinned by version and SHA-256, inlined as text and imported from a blob URL at
// runtime) and the app sources concatenated into one inline module. The built page and the vendor
// file are not committed: GitHub's push protection reads a class name inside the bundle as an API
// key. Run: node tools/build-mishear-web.mjs   (the Pages workflow runs it before stamping sw.js)
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const VENDOR = {
  name: 'transformers-4.3.1.min.js',
  url: 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.min.js',
  sha256: '8d6716d9086f57c30a4bf367dba61b887593573c770c454465e8019b2703e743',
};

const root = fileURLToPath(new URL('..', import.meta.url));
const web = join(root, 'modules', 'mishear-web');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const escape = (js) => js.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');

async function download(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    // behind a proxy that Node's fetch ignores: curl honours HTTPS_PROXY (and a custom CA if given)
    const args = ['-sSL', '--fail'];
    if (process.env.CURL_CA_BUNDLE) args.push('--cacert', process.env.CURL_CA_BUNDLE);
    return execFileSync('curl', [...args, url], { maxBuffer: 64 << 20 });
  }
}

async function ensureVendor() {
  const dir = join(web, 'vendor');
  const path = process.env.MISHEAR_VENDOR || join(dir, VENDOR.name);
  if (existsSync(path) && sha256(readFileSync(path)) === VENDOR.sha256) return readFileSync(path, 'utf8');
  console.log('fetching', VENDOR.url);
  const buf = await download(VENDOR.url);
  const got = sha256(buf);
  if (got !== VENDOR.sha256) throw new Error(`${VENDOR.url}: sha256 ${got}, expected ${VENDOR.sha256}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, buf);
  return buf.toString('utf8');
}

const vendor = await ensureVendor();
const sources = ['dsp.mjs', 'sheet.mjs', 'ears.mjs', 'app.mjs'].map((name) => {
  const text = readFileSync(join(web, 'src', name), 'utf8');
  const stripped = text
    .replace(/^import\s[\s\S]*?from\s+'[^']+';\s*$/gm, '')   // the modules only import each other
    .replace(/^export\s+(?=(const|let|function|class|async)\b)/gm, '');
  if (/^\s*(import|export)\b/m.test(stripped)) throw new Error(`${name}: an import or export survived bundling`);
  return `// ---- ${name}\n${stripped}`;
}).join('\n');

const template = readFileSync(join(web, 'page.html'), 'utf8');
const build = new Date().toISOString().slice(0, 16).replace('T', ' ') + 'Z';
const page = template.replace('{{VENDOR}}', () => escape(vendor)).replace('{{APP}}', () => escape(sources.replace('{{BUILD}}', build)));
const out = join(root, 'modules', 'mishear.html');
writeFileSync(out, page);
console.log('wrote', out, (page.length / 1e6).toFixed(2), 'MB');

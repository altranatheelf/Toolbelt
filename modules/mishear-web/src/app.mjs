// Mishear on this device. Glue between the page, the conditions (dsp.mjs), the listener (ears.mjs)
// and the sheet (sheet.mjs). Nothing here touches the network except the one-time model download.

const TOOL_VERSION = '0.1.0';
const AUDIO_SUFFIXES = /\.(wav|mp3|m4a|aac|flac|aiff?|ogg|opus|caf|mp4|mov|m4v|webm)$/i;

function mainApp() {
  const $ = (s) => document.querySelector(s);
  function h(tag, attrs) {
    const e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach((k) => { if (k === 'text') e.textContent = attrs[k]; else if (k === 'class') e.className = attrs[k]; else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), attrs[k]); else e.setAttribute(k, attrs[k]); });
    for (let i = 2; i < arguments.length; i++) { const c = arguments[i]; if (c == null) continue; e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); }
    return e;
  }

  // ---------- settings (per device)
  const DEFAULTS = { mode: 'quick', model: 'base', languages: 'el, ro', noiseDb: -12, seed: 0, gpu: false };
  // iPhones and iPads report as touch Macs since iPadOS 13; WebKit's per-tab memory is far below a laptop's
  const PHONE = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  function settings() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('mishear.settings') || '{}'); } catch (e) { saved = {}; }
    return { ...DEFAULTS, ...saved };
  }
  function saveSettings(s) { try { localStorage.setItem('mishear.settings', JSON.stringify(s)); } catch (e) {} }
  function forcedLanguages(text) { return [...new Set(text.split(/[\s,]+/).map((x) => x.trim().toLowerCase()).filter((x) => x && x !== 'en'))]; }

  // ---------- the grid, as in the Python engine
  function grid(mode, model, forced) {
    const ears = [];
    const ear = (condition, language, task = 'transcribe') => ({ condition, model, language, task });
    if (mode === 'quick') { for (const c of ['clean', 'wall', 'sideways']) ears.push(ear(c, 'en')); return ears; }
    for (const c of CONDITIONS) ears.push(ear(c, 'en'));
    const forcedConditions = mode === 'all' ? CONDITIONS : ['clean', 'wall'];
    for (const c of forcedConditions) for (const lang of forced) { ears.push(ear(c, lang, 'transcribe')); ears.push(ear(c, lang, 'translate')); }
    return ears;
  }

  // ---------- transformers.js from the inlined bundle (a blob import keeps it a real ES module)
  let Tp = null;
  function transformers() {
    if (!Tp) {
      const text = $('#vendor-transformers').textContent;
      const url = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
      Tp = import(url).then((T) => { T.env.allowLocalModels = false; T.env.useBrowserCache = true; return T; });
    }
    return Tp;
  }
  const models = new Map(); // size -> bundle
  async function deviceName() {
    if (!navigator.gpu) return 'wasm';
    if (PHONE && !$('#gpu').checked) return 'wasm'; // the GPU runtime plus a full-precision model is what kills the tab on a phone
    try { const adapter = await navigator.gpu.requestAdapter(); return adapter ? 'webgpu' : 'wasm'; } catch (e) { return 'wasm'; }
  }
  function modelLabels(device) {
    for (const option of $('#model').options) {
      const spec = MODELS[option.value];
      const dtype = spec.dtype[device] || 'q8';
      const note = { tiny: 'fastest, rough', base: 'recommended', small: PHONE ? 'best, slow and may crash a phone' : 'best, slow' }[option.value];
      option.textContent = `${option.value} · ${note} · ${spec.mb[dtype]} MB once`;
    }
  }
  async function model(size, device, onProgress) {
    const key = `${size}:${device}`;
    if (!models.has(key)) {
      const T = await transformers();
      try {
        models.set(key, await loadModel(T, size, { device, progress: onProgress }));
      } catch (err) {
        if (device === 'webgpu') { log(`WebGPU failed (${err.message}); using WebAssembly`); return model(size, 'wasm', onProgress); }
        throw err;
      }
    }
    return models.get(key);
  }

  // ---------- decode a file to 16 kHz channels
  async function decode(file) {
    const bytes = await file.arrayBuffer();
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map((b) => b.toString(16).padStart(2, '0')).join('');
    const ctx = new OfflineAudioContext(2, RATE, RATE);
    const buffer = await ctx.decodeAudioData(bytes.slice(0));
    const channels = [];
    for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) channels.push(buffer.getChannelData(c));
    return { digest, channels, duration: buffer.length / RATE, sampleRate: buffer.sampleRate, originalChannels: buffer.numberOfChannels, bytes: bytes.byteLength };
  }

  // ---------- a tiny zip writer (store only) so the sheet folder can be saved as one file
  const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(bytes) { let c = 0xffffffff; for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
  function zip(entries) { // entries: [{name, text}]
    const enc = new TextEncoder(); const parts = []; const central = []; let offset = 0;
    const date = new Date(); const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1); const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    for (const e of entries) {
      const name = enc.encode(e.name), data = enc.encode(e.text), crc = crc32(data);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x800, true); local.setUint16(8, 0, true); local.setUint16(10, dosTime, true); local.setUint16(12, dosDate, true);
      local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true); local.setUint16(26, name.length, true); local.setUint16(28, 0, true);
      parts.push(new Uint8Array(local.buffer), name, data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x800, true); c.setUint16(10, 0, true); c.setUint16(12, dosTime, true); c.setUint16(14, dosDate, true);
      c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
      central.push(new Uint8Array(c.buffer), name);
      offset += 30 + name.length + data.length;
    }
    const centralSize = central.reduce((s, p) => s + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true); end.setUint32(12, centralSize, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
  }

  // ---------- sheets kept on this device
  function db() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('mishear', 1);
      req.onupgradeneeded = () => { req.result.createObjectStore('sheets', { keyPath: 'id' }); };
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
  }
  async function storeSheet(record) { try { const d = await db(); await new Promise((res, rej) => { const tx = d.transaction('sheets', 'readwrite'); tx.objectStore('sheets').put(record); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); } catch (e) { log('could not keep the sheet on this device: ' + e.message); } }
  async function listSheets() { try { const d = await db(); return await new Promise((res, rej) => { const req = d.transaction('sheets').objectStore('sheets').getAll(); req.onsuccess = () => res(req.result.sort((a, b) => (b.timestamp > a.timestamp ? 1 : -1))); req.onerror = () => rej(req.error); }); } catch (e) { return []; } }
  async function deleteSheet(id) { const d = await db(); await new Promise((res, rej) => { const tx = d.transaction('sheets', 'readwrite'); tx.objectStore('sheets').delete(id); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); }

  // ---------- one source, start to sheet
  let cancelled = false;
  function log(message) { const el = $('#log'); el.hidden = false; el.textContent += message + '\n'; el.scrollTop = el.scrollHeight; }
  function progress(fraction, text) { $('#progress').style.width = Math.round(Math.max(0, Math.min(1, fraction)) * 100) + '%'; if (text != null) $('#state').textContent = text; }

  async function listenToFile(file, lyricsFile, opts) {
    const started = Date.now();
    log(`— ${file.name}`);
    const decoded = await decode(file);
    const lyrics = lyricsFile ? (await lyricsFile.text()).split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : null;
    const probe = { sample_rate: RATE, channels: decoded.originalChannels, duration: Math.round(decoded.duration * 1000) / 1000 };
    const dsp = { noiseDb: opts.noiseDb, seed: opts.seed, channels: decoded.originalChannels };
    const ears = grid(opts.mode, opts.model, opts.forced);
    const rendered = new Map();
    for (const c of [...new Set(ears.map((e) => e.condition))]) { rendered.set(c, render(c, decoded.channels, dsp)); await new Promise((r) => setTimeout(r)); }
    let bundle = await model(opts.model, opts.device, (p) => { if (p.status === 'progress' && p.file) progress((p.progress || 0) / 100, `downloading ${opts.model} · ${p.file.split('/').pop()} ${Math.round(p.progress || 0)}%`); });
    const hearings = [];
    for (let i = 0; i < ears.length; i++) {
      if (cancelled) throw new Error('stopped');
      const ear = ears[i];
      progress(i / ears.length, `listening ${earLabel(ear)} (${i + 1}/${ears.length})`);
      log(`listening ${earLabel(ear)}`);
      await new Promise((r) => setTimeout(r));
      let heard;
      try {
        heard = await listen(bundle, rendered.get(ear.condition), { language: ear.language, task: ear.task });
      } catch (err) {
        if (bundle.info.device !== 'webgpu') throw err;
        log(`GPU failed while listening (${err.message}); switching to the CPU`);
        opts.device = 'wasm';
        bundle = await model(opts.model, 'wasm', () => {});
        heard = await listen(bundle, rendered.get(ear.condition), { language: ear.language, task: ear.task });
      }
      const { lines, windows } = heard;
      hearings.push({ ear, lines, note: note(ear.condition, decoded.originalChannels), filter: filterGraph(ear.condition, RATE, dsp), windows, model: bundle.info });
    }
    const name = file.name.replace(/\.[^.]+$/, '');
    const markdown = renderSheet(file.name, probe, decoded.digest, hearings, lyrics, lyricsFile ? lyricsFile.name : null);
    const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
    const sidecar = {
      tool: { name: 'mishear-web', version: TOOL_VERSION, engine: 'browser', user_agent: navigator.userAgent },
      timestamp,
      source: { name: file.name, sha256: decoded.digest, bytes: decoded.bytes, duration: probe.duration, decoded_sample_rate: RATE, channels: decoded.originalChannels },
      lyrics: lyricsFile ? lyricsFile.name : null,
      seed: opts.seed, noise_db: opts.noiseDb, grid: opts.mode, languages: opts.forced,
      ears: hearings.map((hg) => ({ ear: earName(hg.ear), condition: hg.ear.condition, model: hg.ear.model, language: hg.ear.language, task: hg.ear.task, filter: hg.filter, model_info: hg.model, decode: { ...DECODE, language: hg.ear.language, task: hg.ear.task }, windows: hg.windows, note: hg.note, lines: hg.lines.length, words: hg.lines.reduce((s, l) => s + l.words.length, 0) })),
      seconds: Math.round((Date.now() - started) / 100) / 10,
    };
    const entries = [{ name: `${name}/sheet.md`, text: markdown }, { name: `${name}/sidecar.json`, text: JSON.stringify(sidecar, null, 2) + '\n' }];
    for (const hg of hearings) {
      const lines = [`# ${earLabel(hg.ear)}`, `# filter: ${hg.filter || 'none'}`];
      if (hg.note) lines.push(`# note: ${hg.note}`);
      for (const l of hg.lines) { lines.push(`[${fmtTime(l.start)}–${fmtTime(l.end)}] ${l.text.trim()}`); for (const w of l.words) lines.push(`    ${fmtTime(w.start)} ${w.probability.toFixed(3)} ${w.text.trim()}`); }
      entries.push({ name: `${name}/ears/${earName(hg.ear)}.txt`, text: lines.join('\n') + '\n' });
      entries.push({ name: `${name}/ears/${earName(hg.ear)}.json`, text: JSON.stringify({ ...sidecar.ears.find((e) => e.ear === earName(hg.ear)), lines: hg.lines }, null, 2) + '\n' });
    }
    const record = { id: `${name}@${timestamp}`, name, source: file.name, timestamp, ears: hearings.length, lines: hearings.reduce((s, hg) => s + hg.lines.length, 0), lyrics: Boolean(lyrics), markdown, zip: zip(entries), seconds: sidecar.seconds };
    await storeSheet(record);
    log(`done in ${sidecar.seconds} s`);
    return record;
  }

  // ---------- page
  const s0 = settings();
  $('#mode').value = s0.mode; $('#model').value = s0.model; $('#langs').value = s0.languages; $('#gpu').checked = Boolean(s0.gpu);
  $('#gpuRow').hidden = !navigator.gpu || !PHONE;
  function currentOpts(device) {
    const s = { mode: $('#mode').value, model: $('#model').value, languages: $('#langs').value, noiseDb: s0.noiseDb, seed: s0.seed, gpu: $('#gpu').checked };
    saveSettings(s);
    return { ...s, forced: forcedLanguages(s.languages), device };
  }
  function earsPreview() {
    const o = currentOpts('wasm');
    const ears = grid(o.mode, o.model, o.forced);
    $('#earsPreview').textContent = `${ears.length} ears: ` + ears.map(earLabel).join(' · ');
  }
  ['#mode', '#model', '#langs'].forEach((sel) => { $(sel).addEventListener('change', earsPreview); });
  earsPreview();
  async function showDevice() {
    const d = await deviceName();
    $('#device').textContent = d === 'webgpu' ? 'on this device · GPU' : 'on this device · CPU'; $('#device').className = 'pill on';
    modelLabels(d);
  }
  $('#gpu').addEventListener('change', () => { currentOpts('wasm'); showDevice(); });
  showDevice();

  $('#cancel').onclick = () => { cancelled = true; $('#cancel').disabled = true; };
  $('#go').onclick = async () => {
    const files = Array.from($('#audio').files || []).filter((f) => AUDIO_SUFFIXES.test(f.name) || f.type.startsWith('audio/') || f.type.startsWith('video/'));
    const txts = Array.from($('#lyrics').files || []);
    if (!files.length) { $('#state').textContent = 'pick an audio file first'; $('#state').className = 'warn'; return; }
    cancelled = false; $('#go').disabled = true; $('#cancel').hidden = false; $('#cancel').disabled = false; $('#state').className = 'muted'; $('#log').textContent = ''; progress(0, 'starting…');
    try {
      const device = await deviceName();
      const opts = currentOpts(device);
      let last = null;
      for (const file of files) {
        const stem = file.name.replace(/\.[^.]+$/, '');
        const lyricsFile = txts.find((t) => t.name.replace(/\.[^.]+$/, '') === stem) || null;
        last = await listenToFile(file, lyricsFile, opts);
      }
      progress(1, 'done'); $('#state').className = 'good';
      if (last) showSheet(last);
      loadSheets();
    } catch (err) {
      $('#state').textContent = err.message === 'stopped' ? 'stopped' : String(err.message || err); $('#state').className = err.message === 'stopped' ? 'muted' : 'bad';
      log(String(err.stack || err));
    } finally { $('#go').disabled = false; $('#cancel').hidden = true; }
  };

  async function saveRecord(record) {
    const file = new File([record.zip], `${record.name}.mishear.zip`, { type: 'application/zip' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title: record.name }); return; } catch (e) { if (e.name === 'AbortError') return; } }
    const a = h('a', { href: URL.createObjectURL(file), download: file.name }); document.body.appendChild(a); a.click(); a.remove();
  }
  function showSheet(record) {
    $('#result').hidden = false;
    $('#resultTitle').textContent = record.name;
    $('#save').onclick = () => saveRecord(record);
    $('#copy').onclick = async () => { try { await navigator.clipboard.writeText(record.markdown); $('#copy').textContent = 'copied'; setTimeout(() => { $('#copy').textContent = 'Copy sheet.md'; }, 1500); } catch (e) {} };
    renderMarkdown(record.markdown, $('#sheet'));
    $('#result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  async function loadSheets() {
    const box = $('#sheets'); const list = await listSheets();
    box.textContent = ''; box.className = '';
    if (!list.length) { box.textContent = 'No sheets yet.'; box.className = 'faint'; return; }
    for (const r of list) {
      box.appendChild(h('div', { class: 'past' },
        h('div', null, h('div', { class: 't', text: r.name }), h('div', { class: 'faint', text: `${r.source} · ${r.ears} ears · ${r.lines} lines${r.lyrics ? ' · real lines' : ''} · ${r.timestamp.slice(0, 16).replace('T', ' ')}` })),
        h('div', { class: 'row' }, h('button', { text: 'Open', onclick: () => showSheet(r) }), h('button', { text: 'Save', onclick: () => saveRecord(r) }), h('button', { text: '✕', title: 'forget', onclick: async () => { await deleteSheet(r.id); loadSheets(); } }))));
    }
  }
  loadSheets();

  // ---------- markdown from the sheet writer, rendered into DOM nodes (never innerHTML)
  function splitRow(row) {
    const cells = []; let cur = '';
    for (let k = 1; k < row.length; k++) { const c = row[k]; if (c === '\\' && row[k + 1] === '|') { cur += '|'; k++; } else if (c === '|') { cells.push(cur.trim()); cur = ''; } else cur += c; }
    if (cur.trim()) cells.push(cur.trim());
    return cells;
  }
  function table(rows) {
    const wrap = h('div', { class: 'tbl' }), t = h('table'), head = splitRow(rows[0]), body = rows.slice(1).filter((r) => !/^\|\s*-{3}/.test(r));
    const thead = h('thead'), tr = h('tr'); head.forEach((c) => tr.appendChild(h('th', { text: c }))); thead.appendChild(tr); t.appendChild(thead);
    const tbody = h('tbody'); const realCol = head.indexOf('real line');
    body.forEach((r) => { const cells = splitRow(r), tr2 = h('tr'); head.forEach((_, i) => { const v = cells[i] == null ? '' : cells[i]; const cls = i === 0 ? 't' : (i === realCol ? 'real' : (v.charAt(0) === '≠' ? 'ne' : '')); tr2.appendChild(h('td', { class: cls, text: v })); }); tbody.appendChild(tr2); });
    t.appendChild(tbody); wrap.appendChild(t); return wrap;
  }
  function renderMarkdown(md, into) {
    into.textContent = '';
    const lines = md.split('\n'); let i = 0, list = null, para = [];
    const flush = () => { if (para.length) { into.appendChild(h('p', { text: para.join(' ') })); para = []; } };
    while (i < lines.length) {
      const L = lines[i];
      if (L.charAt(0) === '|') { flush(); list = null; const rows = []; while (i < lines.length && lines[i].charAt(0) === '|') { rows.push(lines[i]); i++; } into.appendChild(table(rows)); continue; }
      const m = /^(#{1,6})\s+(.*)$/.exec(L);
      if (m) { flush(); list = null; into.appendChild(h('h' + Math.min(m[1].length + 1, 6), { text: m[2] })); i++; continue; }
      if (L.slice(0, 2) === '- ') { flush(); if (!list) { list = h('ul'); into.appendChild(list); } list.appendChild(h('li', { text: L.slice(2) })); i++; continue; }
      if (/^_.*_$/.test(L)) { flush(); list = null; into.appendChild(h('p', { class: 'faint', text: L.slice(1, -1) })); i++; continue; }
      if (!L.trim()) { flush(); list = null; i++; continue; }
      para.push(L); i++;
    }
    flush();
  }
}

mainApp();

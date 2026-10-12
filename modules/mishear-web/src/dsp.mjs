// Listening conditions as plain JavaScript, ported from ffmpeg 6.1's filters so the phone hears
// what the Mac engine hears. Everything works on Float32Array samples at RATE (16 kHz mono);
// "sideways" also takes the stereo pair. Pure functions: same input, same output.

export const RATE = 16000;
export const TAPE_RATE = 0.93;
export const HELIUM_RATE = 1.12;

// ---------- libavutil/md5 + lfg: ffmpeg's seeded random generator, so "rain" is the same noise

function md5(bytes) {
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
  const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  const len = bytes.length;
  const padded = new Uint8Array(((len + 8) >> 6 << 6) + 64);
  padded.set(bytes);
  padded[len] = 0x80;
  const bits = len * 8;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, bits >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(bits / 4294967296), true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const M = new Uint32Array(16);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = view.getUint32(off + i * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D; D = C; C = B;
      B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, a0, true); ov.setUint32(4, b0, true); ov.setUint32(8, c0, true); ov.setUint32(12, d0, true);
  return out;
}

export class LFG {
  // av_lfg_init: state[8..63] from MD5(seed, i); state[0..7] stay 0
  constructor(seed) {
    this.state = new Uint32Array(64);
    this.index = 0;
    let tmp = new Uint8Array(16); // reused across rounds, as in lfg.c: bytes 5..15 carry the previous digest
    for (let i = 8; i < 64; i += 4) {
      new DataView(tmp.buffer).setUint32(0, seed >>> 0, true);
      tmp[4] = i;
      tmp = md5(tmp);
      const dv = new DataView(tmp.buffer);
      for (let k = 0; k < 4; k++) this.state[i + k] = dv.getUint32(k * 4, true);
    }
  }
  next() {
    const a = (this.state[(this.index - 24) & 63] + this.state[(this.index - 55) & 63]) >>> 0;
    this.state[this.index & 63] = a;
    this.index += 1;
    return a;
  }
}

// anoisesrc=color=pink:seed=S:amplitude=1 (asrc_anoisesrc.c pink_filter, musicdsp pink.txt)
export function pinkNoise(length, seed, amplitude = 1) {
  const lfg = new LFG(seed);
  const buf = new Float64Array(7);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const white = amplitude * ((2 * (lfg.next() / 0xffffffff)) - 1);
    buf[0] = 0.99886 * buf[0] + white * 0.0555179;
    buf[1] = 0.99332 * buf[1] + white * 0.0750759;
    buf[2] = 0.96900 * buf[2] + white * 0.1538520;
    buf[3] = 0.86650 * buf[3] + white * 0.3104856;
    buf[4] = 0.55000 * buf[4] + white * 0.5329522;
    buf[5] = -0.7616 * buf[5] - white * 0.0168980;
    const pink = buf[0] + buf[1] + buf[2] + buf[3] + buf[4] + buf[5] + buf[6] + white * 0.5362;
    buf[6] = white * 0.115926;
    out[i] = pink * 0.11;
  }
  return out;
}

// ---------- af_biquads.c: lowpass / highpass, 2 poles, width_type q, width 0.707, direct form I

function biquad(x, b, a) {
  const b0 = b[0] / a[0], b1 = b[1] / a[0], b2 = b[2] / a[0];
  const a1 = a[1] / a[0], a2 = a[2] / a[0];
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v;
    y[i] = v;
  }
  return y;
}

export function lowpass(x, frequency, rate = RATE, q = 0.707) {
  const w0 = 2 * Math.PI * frequency / rate;
  const alpha = Math.sin(w0) / (2 * q);
  const c = Math.cos(w0);
  return biquad(x, [(1 - c) / 2, 1 - c, (1 - c) / 2], [1 + alpha, -2 * c, 1 - alpha]);
}

export function highpass(x, frequency, rate = RATE, q = 0.707) {
  const w0 = 2 * Math.PI * frequency / rate;
  const alpha = Math.sin(w0) / (2 * q);
  const c = Math.cos(w0);
  return biquad(x, [(1 + c) / 2, -(1 + c), (1 + c) / 2], [1 + alpha, -2 * c, 1 - alpha]);
}

// ---------- af_sidechaincompress.c acompressor with its defaults
// threshold 0.125, ratio 2, attack 20 ms, release 250 ms, makeup 1, knee 2.82843, detection rms, mode downward

function hermite(x, x0, x1, p0, p1, m0, m1) {
  const width = x1 - x0;
  const t = (x - x0) / width;
  m0 *= width; m1 *= width;
  const t2 = t * t, t3 = t2 * t;
  const ct2 = -3 * p0 - 2 * m0 + 3 * p1 - m1;
  const ct3 = 2 * p0 + m0 - 2 * p1 + m1;
  return ct3 * t3 + ct2 * t2 + m0 * t + p0;
}

export function compressor(x, rate = RATE, opts = {}) {
  const threshold = opts.threshold ?? 0.125, ratio = opts.ratio ?? 2, attack = opts.attack ?? 20, release = opts.release ?? 250;
  const makeup = opts.makeup ?? 1, knee = opts.knee ?? 2.82843, detection = 1, mix = 1;
  const thres = Math.log(threshold);
  const linKneeStart = threshold / Math.sqrt(knee), linKneeStop = threshold * Math.sqrt(knee);
  const adjKneeStart = linKneeStart * linKneeStart;
  const kneeStart = Math.log(linKneeStart), kneeStop = Math.log(linKneeStop);
  const compressedKneeStop = (kneeStop - thres) / ratio + thres;
  const attackCoeff = Math.min(1, 1 / (attack * rate / 4000));
  const releaseCoeff = Math.min(1, 1 / (release * rate / 4000));
  let linSlope = 0;
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    let abs = Math.abs(x[i]);
    if (detection) abs *= abs;
    linSlope += (abs - linSlope) * (abs > linSlope ? attackCoeff : releaseCoeff);
    let gain = 1;
    if (linSlope > 0 && linSlope > adjKneeStart) {
      let slope = Math.log(linSlope);
      if (detection) slope *= 0.5;
      let g = (slope - thres) / ratio + thres;
      const delta = 1 / ratio;
      if (knee > 1 && slope < kneeStop) g = hermite(slope, kneeStart, kneeStop, kneeStart, compressedKneeStop, 1, delta);
      gain = Math.exp(g - slope);
    }
    y[i] = x[i] * (gain * makeup * mix + (1 - mix));
  }
  return y;
}

// ---------- asetrate=rate*r,aresample=rate: play at a different speed, back at the model rate.
// Windowed-sinc interpolation (Lanczos, 16 lobes); ffmpeg uses swresample's own kernel, so this is
// the same operation, not the same bytes.

export function resample(x, step) {
  const outLength = Math.round(x.length / step);
  const y = new Float32Array(outLength);
  const lobes = 16;
  const scale = Math.max(1, step); // when slowing down the signal keeps its band; when speeding up, lowpass to the new Nyquist
  const half = lobes * scale;
  for (let n = 0; n < outLength; n++) {
    const centre = n * step;
    const from = Math.max(0, Math.ceil(centre - half)), to = Math.min(x.length - 1, Math.floor(centre + half));
    let acc = 0, norm = 0;
    for (let k = from; k <= to; k++) {
      const d = (k - centre) / scale;
      let w;
      if (d === 0) w = 1;
      else { const pd = Math.PI * d; w = (Math.sin(pd) / pd) * (Math.sin(pd / lobes) / (pd / lobes)); }
      acc += x[k] * w; norm += w;
    }
    y[n] = norm > 0 ? acc / norm : 0;
  }
  return y;
}

// ---------- af_acrusher.c, mode lin, bits 6, mix 0 (fully crushed), aa 0.5, dc 1, samples 1

export function acrusher(x, bits = 6, aa = 0.5) {
  const coeff = Math.pow(2, bits) - 1;
  const aa1 = (1 - aa) / 2;
  const factor = (y, k) => 0.5 * (Math.sin(Math.PI * (Math.abs(y - k) - aa1) / aa - Math.PI / 2) + 1);
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    const y = v * coeff;
    let k = Math.round(y); // roundf: half away from zero
    if (y < 0 && y - Math.floor(y) === 0.5) k = Math.floor(y); // JS rounds -2.5 to -2; C rounds to -3
    if (k - aa1 <= y && y <= k + aa1) k /= coeff;
    else if (y > k + aa1) k = k / coeff + ((k + 1) / coeff - k / coeff) * factor(y, k);
    else k = k / coeff - (k / coeff - (k - 1) / coeff) * factor(y, k);
    out[i] = k;
  }
  return out;
}

// ---------- the nine conditions, each a pure function of the decoded audio

export function sideChannel(left, right) {
  if (!right) return new Float32Array(left.length); // a mono file has no side channel
  const out = new Float32Array(left.length);
  for (let i = 0; i < left.length; i++) out[i] = 0.5 * left[i] - 0.5 * right[i];
  return out;
}

export function reverse(x) {
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[x.length - 1 - i];
  return out;
}

export function mixNoise(x, noiseDb, seed) {
  const gain = Math.pow(10, noiseDb / 20);
  const noise = pinkNoise(x.length, seed);
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i] + gain * noise[i];
  return out;
}

export function downmix(channels) {
  // ffmpeg -ac 1 on stereo: (L + R) * 0.7071
  if (channels.length === 1) return channels[0];
  const out = new Float32Array(channels[0].length);
  for (let i = 0; i < out.length; i++) out[i] = (channels[0][i] + channels[1][i]) * Math.SQRT1_2;
  return out;
}

/** The exact ffmpeg filter graph each condition stands for, recorded in the sidecar. */
export function filterGraph(name, rate, settings) {
  const chain = (f) => `[0:a:0]${f}[out]`;
  switch (name) {
    case 'clean': return null;
    case 'wall': return chain('lowpass=f=800');
    case 'radio': return chain('highpass=f=300,lowpass=f=3400,acompressor');
    case 'tape': return chain(`asetrate=${Math.round(rate * TAPE_RATE)},aresample=${rate}`);
    case 'helium': return chain(`asetrate=${Math.round(rate * HELIUM_RATE)},aresample=${rate}`);
    case 'rain': return `anoisesrc=color=pink:seed=${settings.seed}:sample_rate=${rate}:amplitude=1,volume=${settings.noiseDb}dB[n];[0:a:0][n]amix=inputs=2:duration=first:normalize=0[out]`;
    case 'sideways': return chain(settings.channels < 2 ? 'pan=mono|c0=0*c0' : 'pan=mono|c0=0.5*c0-0.5*c1');
    case 'backwards': return chain('areverse');
    case 'crushed': return chain('acrusher=bits=6:mix=0');
    default: throw new Error('unknown condition ' + name);
  }
}

export const CONDITIONS = ['clean', 'wall', 'radio', 'tape', 'helium', 'rain', 'sideways', 'backwards', 'crushed'];

/**
 * Render one condition. `channels` are the decoded channels at RATE; returns 16 kHz mono samples.
 * settings: { noiseDb, seed }
 */
export function render(name, channels, settings) {
  const mono = downmix(channels);
  switch (name) {
    case 'clean': return mono;
    case 'wall': return lowpass(mono, 800);
    case 'radio': return compressor(lowpass(highpass(mono, 300), 3400));
    case 'tape': return resample(mono, TAPE_RATE);
    case 'helium': return resample(mono, HELIUM_RATE);
    case 'rain': return mixNoise(mono, settings.noiseDb, settings.seed);
    case 'sideways': return sideChannel(channels[0], channels[1]);
    case 'backwards': return reverse(mono);
    case 'crushed': return acrusher(mono);
    default: throw new Error('unknown condition ' + name);
  }
}

/** Map an ear's (start, end) back onto the source timeline, as the Python engine does. */
export function timeMap(name, duration) {
  if (name === 'tape') return (s, e) => [s * TAPE_RATE, e * TAPE_RATE];
  if (name === 'helium') return (s, e) => [s * HELIUM_RATE, e * HELIUM_RATE];
  if (name === 'backwards') return (s, e) => [Math.max(duration - e, 0), Math.max(duration - s, 0)];
  return (s, e) => [s, e];
}

/** A condition's note for this source, if anything is unusual. */
export function note(name, channels) {
  if (name === 'sideways' && channels < 2) return 'mono source: no side channel (the side of a mono signal is zero)';
  return null;
}

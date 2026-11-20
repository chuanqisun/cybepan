#!/usr/bin/env node
/**
 * scripts/analyze-yishama.mjs
 *
 * Acoustic spectral & time-resolved modal bloom analyzer for Yishama Virtual Pantam
 * reference notes (or any synthesized WAV/MP3 handpan sample directory).
 *
 * Usage:
 *   node scripts/analyze-yishama.mjs                  # Download & analyze Yishama reference notes -> scripts/yishama-acoustic-profile.json
 *   node scripts/analyze-yishama.mjs --compare <dir>  # Compare synthesized WAVs in <dir> against scripts/yishama-acoustic-profile.json
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = "/tmp/yishama-acoustic-cache";
const OUT_PROFILE = path.join(__dirname, "yishama-acoustic-profile.json");
const SR = 44100;

const REF_NOTES = [
  ["C3", 130.81], ["D3", 146.83], ["F3", 174.61], ["A3", 220.00], ["Bb3", 233.08],
  ["C4", 261.63], ["D4", 293.66], ["E4", 329.63], ["F4", 349.23], ["G4", 392.00],
  ["A4", 440.00], ["C5", 523.25], ["E5", 659.25]
];

function decodeStereo(filePath) {
  const raw = execSync(`ffmpeg -v error -i "${filePath}" -f f32le -ac 2 -ar ${SR} pipe:1`, {
    maxBuffer: 64 * 1024 * 1024
  });
  const f32 = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const n = f32.length / 2;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const M = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    L[i] = f32[i * 2];
    R[i] = f32[i * 2 + 1];
    M[i] = 0.5 * (L[i] + R[i]);
  }
  return { L, R, M };
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wlenRe = Math.cos(ang), wlenIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wRe = 1, wIm = 0;
      for (let j = 0; j < len / 2; j++) {
        const uRe = re[i + j], uIm = im[i + j];
        const vRe = re[i + j + len / 2] * wRe - im[i + j + len / 2] * wIm;
        const vIm = re[i + j + len / 2] * wIm + im[i + j + len / 2] * wRe;
        re[i + j] = uRe + vRe;
        im[i + j] = uIm + vIm;
        re[i + j + len / 2] = uRe - vRe;
        im[i + j + len / 2] = uIm - vIm;
        const nextWRe = wRe * wlenRe - wIm * wlenIm;
        wIm = wRe * wlenIm + wIm * wlenRe;
        wRe = nextWRe;
      }
    }
  }
}

function spectrum(sig, startSample, winLen, fftSize) {
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  for (let i = 0; i < winLen; i++) {
    const idx = startSample + i;
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (winLen - 1)));
    re[i] = (idx >= 0 && idx < sig.length ? sig[idx] : 0) * w;
  }
  fft(re, im);
  const mag = new Float64Array(fftSize / 2);
  const norm = 2 / (winLen * 0.5);
  for (let i = 0; i < fftSize / 2; i++) {
    mag[i] = Math.hypot(re[i], im[i]) * norm;
  }
  return mag;
}

function measurePeakNear(mag, targetHz, tolPct = 0.05, fftSize = 65536) {
  const binHz = SR / fftSize;
  const lo = Math.max(1, Math.floor((targetHz * (1 - tolPct)) / binHz));
  const hi = Math.min(mag.length - 2, Math.ceil((targetHz * (1 + tolPct)) / binHz));
  let bestBin = lo, bestVal = -1;
  for (let b = lo; b <= hi; b++) {
    if (mag[b] > bestVal) { bestVal = mag[b]; bestBin = b; }
  }
  const y0 = Math.log(mag[bestBin - 1] + 1e-12);
  const y1 = Math.log(mag[bestBin] + 1e-12);
  const y2 = Math.log(mag[bestBin + 1] + 1e-12);
  const d = (0.5 * (y0 - y2)) / (y0 - 2 * y1 + y2 || 1);
  const exactHz = (bestBin + Math.max(-0.5, Math.min(0.5, d))) * binHz;
  const cents = 1200 * Math.log2(exactHz / targetHz);
  return { hz: exactHz, amp: bestVal, cents };
}

function goertzelEnv(sig, onset, freqHz, timesSec, winSec = 0.085) {
  const winN = Math.floor(winSec * SR);
  const w0 = (2 * Math.PI * freqHz) / SR;
  return timesSec.map((t) => {
    const center = onset + Math.floor(t * SR);
    const start = center - Math.floor(winN / 2);
    if (start + winN > sig.length) return null;
    let c = 0, s = 0;
    for (let i = 0; i < winN; i++) {
      const idx = start + i;
      const x = idx >= 0 && idx < sig.length ? sig[idx] : 0;
      const win = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (winN - 1)));
      const ph = w0 * i;
      c += x * win * Math.cos(ph);
      s += x * win * Math.sin(ph);
    }
    return (2 * Math.hypot(c, s)) / (winN * 0.5);
  });
}

function fitDecayTau(times, amps) {
  // Fit exponential decay from peak onwards (so delayed bloom rise doesn't bias tau!)
  let peakIdx = 0, peakVal = -1;
  for (let i = 0; i < times.length; i++) {
    if (amps[i] != null && times[i] <= 0.45 && amps[i] > peakVal) {
      peakVal = amps[i];
      peakIdx = i;
    }
  }
  const pts = [];
  for (let i = peakIdx; i < times.length; i++) {
    if (amps[i] != null && amps[i] > peakVal * 0.04 && amps[i] > 0.0012) {
      pts.push([times[i], Math.log(amps[i])]);
    }
  }
  if (pts.length < 3) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const [x, y] of pts) { sx += x; sy += y; sxx += x * x; sxy += x * y; }
  const n = pts.length;
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx || 1);
  return slope < -0.02 ? -1 / slope : null;
}

function measureBeating(sig, onset, freqHz) {
  const times = [];
  for (let t = 0.08; t <= 2.0; t += 0.025) times.push(t);
  const env = goertzelEnv(sig, onset, freqHz, times, 0.05).filter((v) => v != null);
  if (env.length < 24) return { modDepth: 0, beatHz: 0 };
  const logE = env.map((v) => Math.log(v + 1e-6));
  const n = logE.length;
  const xMean = (n - 1) / 2;
  let yMean = 0;
  for (const y of logE) yMean += y;
  yMean /= n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (i - xMean) * (logE[i] - yMean); den += (i - xMean) ** 2; }
  const slope = num / (den || 1);
  const res = logE.map((y, i) => y - (yMean + slope * (i - xMean)));
  const rms = Math.sqrt(res.reduce((a, b) => a + b * b, 0) / n);
  let bestF = 0, bestP = 0;
  for (let f = 0.4; f <= 4.5; f += 0.1) {
    let c = 0, s = 0;
    for (let i = 0; i < n; i++) {
      const ph = (2 * Math.PI * f * i) / 40;
      c += res[i] * Math.cos(ph);
      s += res[i] * Math.sin(ph);
    }
    const p = Math.hypot(c, s) / n;
    if (p > bestP) { bestP = p; bestF = f; }
  }
  return { modDepth: +rms.toFixed(3), beatHz: +bestF.toFixed(2) };
}

export function analyzeFile(filePath, name, expectedF0) {
  const { L, R, M } = decodeStereo(filePath);
  const dur = M.length / SR;
  let peak = 0;
  for (let i = 0; i < M.length; i++) if (Math.abs(M[i]) > peak) peak = Math.abs(M[i]);
  let onset = 0;
  for (let i = 0; i < M.length; i++) if (Math.abs(M[i]) > peak * 0.04) { onset = i; break; }

  let peakIdx = onset, maxEnv = 0;
  for (let i = onset; i < Math.min(M.length, onset + Math.floor(0.16 * SR)); i++) {
    if (Math.abs(M[i]) > maxEnv) { maxEnv = Math.abs(M[i]); peakIdx = i; }
  }
  const attackMs = ((peakIdx - onset) / SR) * 1000;

  let ll = 0, rr = 0, lr = 0;
  for (let i = onset; i < Math.min(M.length, onset + SR * 2); i++) {
    ll += L[i] * L[i]; rr += R[i] * R[i]; lr += L[i] * R[i];
  }
  const stereoCorr = lr / (Math.sqrt(ll * rr) || 1);

  const magBody = spectrum(M, onset + Math.floor(0.03 * SR), 16384, 65536);
  const magSustain = spectrum(M, onset + Math.floor(0.60 * SR), 32768, 65536);

  const p1 = measurePeakNear(magBody, expectedF0, 0.05, 65536);
  const f0 = p1.hz;
  const p2 = measurePeakNear(magBody, f0 * 2, 0.04, 65536);
  const p3 = measurePeakNear(magBody, f0 * 3, 0.04, 65536);
  const p4 = measurePeakNear(magBody, f0 * 4, 0.05, 65536);

  const s1 = measurePeakNear(magSustain, p1.hz, 0.02, 65536);
  const s2 = measurePeakNear(magSustain, p2.hz, 0.02, 65536);
  const s3 = measurePeakNear(magSustain, p3.hz, 0.02, 65536);

  const times = [0.025, 0.06, 0.11, 0.17, 0.25, 0.40, 0.65, 1.00, 1.50, 2.20, 3.00];
  const e1 = goertzelEnv(M, onset, p1.hz, times);
  const e2 = goertzelEnv(M, onset, p2.hz, times);
  const e3 = goertzelEnv(M, onset, p3.hz, times);

  const peakTime = (env) => {
    let bi = 0, bv = -1;
    for (let i = 0; i < 6; i++) if (env[i] != null && env[i] > bv) { bv = env[i]; bi = i; }
    return Math.round(times[bi] * 1000);
  };

  const binHz = SR / 65536;
  let helmHz = 0, helmAmp = 0;
  for (let b = Math.floor(65 / binHz); b <= Math.ceil(160 / binHz); b++) {
    const hz = b * binHz;
    if (Math.abs(hz - f0) < 22) continue;
    if (magBody[b] > helmAmp) { helmAmp = magBody[b]; helmHz = hz; }
  }

  return {
    note: name,
    dur: +dur.toFixed(2),
    peakDbfs: +(20 * Math.log10(peak + 1e-9)).toFixed(1),
    attackMs: +attackMs.toFixed(1),
    stereoCorr: +stereoCorr.toFixed(3),
    f0: +p1.hz.toFixed(2),
    octRelDb: +(20 * Math.log10((p2.amp + 1e-9) / (p1.amp + 1e-9))).toFixed(1),
    fifthRelDb: +(20 * Math.log10((p3.amp + 1e-9) / (p1.amp + 1e-9))).toFixed(1),
    p4RelDb: +(20 * Math.log10((p4.amp + 1e-9) / (p1.amp + 1e-9))).toFixed(1),
    sustainOctRelDb: +(20 * Math.log10((s2.amp + 1e-9) / (s1.amp + 1e-9))).toFixed(1),
    sustainFifthRelDb: +(20 * Math.log10((s3.amp + 1e-9) / (s1.amp + 1e-9))).toFixed(1),
    bloom2PeakMs: peakTime(e2),
    bloom3PeakMs: peakTime(e3),
    bloom2Ratio: +((e2[2] || 0) / ((e2[0] || 0) + 1e-6)).toFixed(2),
    tau1: +(fitDecayTau(times, e1) || 0).toFixed(2),
    tau2: +(fitDecayTau(times, e2) || 0).toFixed(2),
    tau3: +(fitDecayTau(times, e3) || 0).toFixed(2),
    beat1: measureBeating(M, onset, p1.hz),
    helmHz: +helmHz.toFixed(1),
    helmRelDb: +(20 * Math.log10((helmAmp + 1e-9) / (p1.amp + 1e-9))).toFixed(1)
  };
}

function ensureReferenceDownloads() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  for (const [name] of REF_NOTES) {
    const dest = path.join(CACHE_DIR, `${name}.mp3`);
    if (!fs.existsSync(dest) || fs.statSync(dest).size < 1000) {
      execSync(`curl -sL -m 15 "https://www.yishama.com/virtual-pantam/assets/notes/${name}.mp3" -o "${dest}"`);
    }
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--compare" && args[1]) {
    const synthDir = args[1];
    const ref = JSON.parse(fs.readFileSync(OUT_PROFILE, "utf8")).notes;
    console.log("Note | f0(ref/syn) | 2f0PkMs(ref/syn) | 3f0PkMs(ref/syn) | tau1(ref/syn) | tau2(ref/syn) | tau3(ref/syn) | stereo(ref/syn)");
    console.log("-".repeat(118));
    for (const r of ref) {
      const candWav = path.join(synthDir, `${r.note}.wav`);
      const candMp3 = path.join(synthDir, `${r.note}.mp3`);
      const p = fs.existsSync(candWav) ? candWav : (fs.existsSync(candMp3) ? candMp3 : null);
      if (!p) continue;
      const s = analyzeFile(p, r.note, r.f0);
      console.log(
        `${r.note.padEnd(4)} | ${String(r.f0).padStart(5)}/${String(s.f0).padEnd(5)} | ` +
        `${String(r.bloom2PeakMs).padStart(6)}/${String(s.bloom2PeakMs).padEnd(6)}ms | ` +
        `${String(r.bloom3PeakMs).padStart(6)}/${String(s.bloom3PeakMs).padEnd(6)}ms | ` +
        `${r.tau1.toFixed(2)}/${s.tau1.toFixed(2)}s     | ` +
        `${r.tau2.toFixed(2)}/${s.tau2.toFixed(2)}s     | ` +
        `${r.tau3.toFixed(2)}/${s.tau3.toFixed(2)}s     | ` +
        `${r.stereoCorr.toFixed(3)}/${s.stereoCorr.toFixed(3)}`
      );
    }
    return;
  }

  ensureReferenceDownloads();
  const notes = REF_NOTES.map(([name, f0]) => analyzeFile(path.join(CACHE_DIR, `${name}.mp3`), name, f0));
  const payload = {
    source: "https://www.yishama.com/virtual-pantam-playground/",
    analyzedAt: new Date().toISOString(),
    sampleRate: SR,
    notes
  };
  fs.writeFileSync(OUT_PROFILE, JSON.stringify(payload, null, 2));
  console.log(`Wrote empirical acoustic profile (${notes.length} notes) to ${OUT_PROFILE}`);
  console.table(notes.map(n => ({
    note: n.note, f0: n.f0, atkMs: n.attackMs, b2PkMs: n.bloom2PeakMs, b3PkMs: n.bloom3PeakMs,
    tau1: n.tau1, tau2: n.tau2, tau3: n.tau3, octDb: n.octRelDb, fifthDb: n.fifthRelDb, stereo: n.stereoCorr
  })));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}

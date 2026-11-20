#!/usr/bin/env node
/**
 * scripts/pregenerate-soundbank.mjs
 *
 * High-precision float64 physical-modeling handpan synthesizer & sound bank pre-generator.
 * Calibrated directly from empirical Yishama Virtual Pantam spectral/bloom measurements
 * (scripts/yishama-acoustic-profile.json).
 *
 * Generates compact, ultra-low-latency browser sound banks in docs/soundbanks/*.bank.js
 * (work cleanly over BOTH http:// and file:// with zero CORS issues!).
 *
 * Usage:
 *   node scripts/pregenerate-soundbank.mjs                       # Build all 3 studio banks into docs/soundbanks/
 *   node scripts/pregenerate-soundbank.mjs --dump-wavs /tmp/syn  # Also dump stainless forte WAVs for --compare verification
 */

import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "docs", "soundbanks");
const SR = 44100;
const BITRATE = "96k"; // 96 kbps stereo MP3: crystal clear for tonal modal handpan audio & compact (~1.5-2.0 MB/bank)

// All 21 unique notes spanning all 5 scales (D Kurd, D Amara, F# Pygmy, C# Hijaz, E Sabye) + C3/F3 for comparison
const BANK_NOTES = [
  "C3", "C#3", "D3", "E3", "F3", "F#3", "G#3", "A3", "Bb3", "B3",
  "C4", "C#4", "D4", "Eb4", "E4", "F4", "F#4", "G4", "G#4", "A4", "B4", "C5", "C#5"
];

const NOTE_OFFSETS = {
  C: -9, "C#": -8, Db: -8, D: -7, "D#": -6, Eb: -6,
  E: -5, F: -4, "F#": -3, Gb: -3, G: -2, "G#": -1,
  Ab: -1, A: 0, "A#": 1, Bb: 1, B: 2
};

function noteToFreq(note) {
  const m = /^([A-G][#b]?)(\d)$/.exec(note);
  if (!m) return 440;
  return 440 * Math.pow(2, (NOTE_OFFSETS[m[1]] + (parseInt(m[2], 10) - 4) * 12) / 12);
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * clamp(t, 0, 1);

// Deterministic seeded PRNG so pre-generated banks are 100% reproducible
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Solve exact two-stage coupled-resonator pump constant `a` such that
// f(t) = (1 - exp(-t/a)) * exp(-t/tau) peaks at t = tPeak!
// Peak condition: a * ln(1 + tau / a) = tPeak
function solveBloomPump(tPeak, tau) {
  const target = clamp(tPeak, 0.004, tau * 0.85);
  let lo = 0.001, hi = tau * 3.0;
  for (let i = 0; i < 24; i++) {
    const mid = 0.5 * (lo + hi);
    const val = mid * Math.log(1 + tau / mid);
    if (val < target) lo = mid;
    else hi = mid;
  }
  const a = 0.5 * (lo + hi);
  const peakVal = (1 - Math.exp(-target / a)) * Math.exp(-target / tau);
  return { a, norm: 1 / (peakVal || 1) };
}

// Voicing definitions grounded in empirical Yishama measurements
const BANK_VOICINGS = {
  "yishama-stainless": {
    name: "Yishama Stainless (Studio Pre-Gen)",
    description: "Empirically matched Yishama stainless pantam: 140–185 ms nonlinear 2f₀/3f₀ bloom, inverted decay tails (τ₃ > τ₂ > τ₁), gentle dual-axis beating, warm 78 Hz Helmholtz cavity.",
    durSec: 4.2,
    tau1Mul: 1.00, tau2Mul: 1.00, tau3Mul: 1.00,
    bloomMul: 1.00,
    octGain: 1.00, fifthGain: 1.00, p4Gain: 1.00,
    beatMul: 1.00,
    skinLevel: 0.11,
    helmLevel: 0.21,
    helmHz: 78,
    sympLevel: 0.032,
    roomLevel: 0.14,
    lpfHz: 4600
  },
  "yishama-ember": {
    name: "Yishama Ember Steel (Studio Pre-Gen)",
    description: "Crystalline Ember alloy: luminous extended 2f₀ & 3f₀ shimmer halo, slightly quicker bloom onset, crisp clean articulation without mud.",
    durSec: 4.4,
    tau1Mul: 0.94, tau2Mul: 1.12, tau3Mul: 1.20,
    bloomMul: 0.84,
    octGain: 1.24, fifthGain: 1.28, p4Gain: 1.40,
    beatMul: 0.78,
    skinLevel: 0.13,
    helmLevel: 0.15,
    helmHz: 82,
    sympLevel: 0.040,
    roomLevel: 0.16,
    lpfHz: 6200
  },
  "yishama-nitrided": {
    name: "Classic Nitrided Hang (Studio Pre-Gen)",
    description: "Dry, focused nitrided steel character: woody tactile finger-pad attack, tighter controlled sustain, punchy separation for fast rhythmic playing.",
    durSec: 3.1,
    tau1Mul: 0.76, tau2Mul: 0.64, tau3Mul: 0.56,
    bloomMul: 0.52,
    octGain: 0.72, fifthGain: 0.62, p4Gain: 0.55,
    beatMul: 0.45,
    skinLevel: 0.19,
    helmLevel: 0.27,
    helmHz: 85,
    sympLevel: 0.018,
    roomLevel: 0.10,
    lpfHz: 3300
  }
};

// Empirical register curves interpolated from scripts/yishama-acoustic-profile.json (C3=130Hz .. E5=659Hz)
function registerParams(freq, v) {
  // Normalized register position u: 0 at D3 (147 Hz) -> 1 at C5 (523 Hz)
  const u = clamp((Math.log2(freq) - Math.log2(146.83)) / (Math.log2(523.25) - Math.log2(146.83)), -0.15, 1.2);
  const isLowDing = freq < 185;

  // Fundamental rise (55ms on Ding -> 34ms mid -> 45ms high)
  const f1PeakSec = (isLowDing ? 0.048 : lerp(0.032, 0.042, u)) * clamp(v.bloomMul, 0.45, 1.2);
  // 2f0 & 3f0 nonlinear bloom peak times (170ms on Ding & mid -> 55ms on high rim)
  const f2PeakSec = lerp(0.168, 0.058, Math.pow(clamp(u, 0, 1), 1.35)) * v.bloomMul;
  const f3PeakSec = lerp(0.185, 0.072, Math.pow(clamp(u, 0, 1), 1.45)) * v.bloomMul;
  const f4PeakSec = lerp(0.210, 0.090, clamp(u, 0, 1)) * v.bloomMul;

  // Empirical decay constants: tau3 > tau2 > tau1 across Ding & mid register!
  const tau1 = lerp(0.47, 0.41, clamp(u, 0, 1)) * v.tau1Mul;
  const tau2 = lerp(0.56, 0.54, clamp(u, 0, 1)) * (u > 0.15 && u < 0.75 ? 1.18 : 1.0) * v.tau2Mul;
  const tau3 = lerp(0.92, 0.34, Math.pow(clamp(u, 0, 1), 1.5)) * (u > 0.15 && u < 0.7 ? 1.12 : 1.0) * v.tau3Mul;
  const tau4 = lerp(0.70, 0.24, clamp(u, 0, 1)) * v.tau2Mul;

  // Empirical relative harmonic amplitudes (linear, relative to f0 = 1.0)
  // Ding has strong 2f0 (~-3 dB) and 3f0 (~-3 dB) + clean 4f0 (-13 dB)
  // Mid register has warm lush 2f0 (~-6 to -9 dB) and singing 3f0 (~-10 to -14 dB)
  // High notes have pure singing f0 with lighter 2f0 (-13 dB) & gentle 3f0 (-20 dB)
  const octBase = (isLowDing ? 0.64 : lerp(0.46, 0.24, clamp(u, 0, 1))) * v.octGain;
  const fifthBase = (isLowDing ? 0.60 : lerp(0.32, 0.11, clamp(u, 0, 1))) * v.fifthGain;
  const p4Base = (isLowDing ? 0.21 : lerp(0.11, 0.025, clamp(u, 0, 1))) * v.p4Gain;

  // Coupled dual-axis beating (0.65 - 1.65 Hz)
  const beatHz = (0.68 + 0.55 * clamp(u, 0, 1) + 0.22 * Math.abs(Math.sin(freq * 0.047))) * v.beatMul;

  return { isLowDing, u, f1PeakSec, f2PeakSec, f3PeakSec, f4PeakSec, tau1, tau2, tau3, tau4, octBase, fifthBase, p4Base, beatHz };
}

// Second-order biquad bandpass filter for warm skin-pad transient shaping
function bandpassFilter(input, fc, Q) {
  const n = input.length;
  const out = new Float64Array(n);
  const w0 = (2 * Math.PI * fc) / SR;
  const alpha = Math.sin(w0) / (2 * Q);
  const b0 = alpha, b1 = 0, b2 = -alpha;
  const a0 = 1 + alpha, a1 = -2 * Math.cos(w0), a2 = 1 - alpha;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < n; i++) {
    const x0 = input[i];
    const y0 = (b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    out[i] = y0;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
  }
  return out;
}

// Gentle one-pole lowpass for warm studio air absorption
function applyLowpass(sig, cutoffHz) {
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const dt = 1 / SR;
  const alpha = dt / (rc + dt);
  let y = 0;
  for (let i = 0; i < sig.length; i++) {
    y += alpha * (sig[i] - y);
    sig[i] = y;
  }
}

// Subtle studio wood-room early reflections (keeps tail dry & crisp, adds realism!)
function addEarlyRoomReflections(L, R, amount) {
  if (amount <= 0.001) return;
  const n = L.length;
  const tapsL = [
    [0.0085, 0.34], [0.0142, -0.26], [0.0218, 0.20], [0.0315, -0.15], [0.0430, 0.11]
  ];
  const tapsR = [
    [0.0098, 0.33], [0.0159, -0.25], [0.0235, 0.19], [0.0342, -0.14], [0.0462, 0.10]
  ];
  const wetL = new Float64Array(n);
  const wetR = new Float64Array(n);
  for (const [sec, gain] of tapsL) {
    const d = Math.floor(sec * SR);
    for (let i = d; i < n; i++) wetL[i] += L[i - d] * gain;
  }
  for (const [sec, gain] of tapsR) {
    const d = Math.floor(sec * SR);
    for (let i = d; i < n; i++) wetR[i] += R[i - d] * gain;
  }
  applyLowpass(wetL, 2600);
  applyLowpass(wetR, 2600);
  for (let i = 0; i < n; i++) {
    L[i] += wetL[i] * amount;
    R[i] += wetR[i] * amount;
  }
}

// Synthesize one high-precision stereo handpan note (float64)
function synthNoteStereo(note, voicing, opts = {}) {
  const { vel = 0.90, art = "N", seed = 1 } = opts;
  const freq = noteToFreq(note);
  const rp = registerParams(freq, voicing);
  const durSec = art === "H" ? voicing.durSec * 0.95 : voicing.durSec;
  const n = Math.floor(durSec * SR);
  const L = new Float64Array(n);
  const R = new Float64Array(n);
  const rng = mulberry32(seed + Math.round(freq * 100));

  // Nonlinear velocity shaping: softer hits = pure warm f0, forte hits = blooming rich harmonics
  const velHarm = 0.38 + 0.72 * Math.pow(vel, 1.45);
  const f0Mul = art === "H" ? 0.06 : 1.0;
  const octMul = art === "H" ? 1.85 : 1.0;
  const fifthMul = art === "H" ? 1.05 : 1.0;

  // Solve exact bloom pump constants for each mode
  const b1 = solveBloomPump(rp.f1PeakSec, rp.tau1);
  const b2 = solveBloomPump(art === "H" ? rp.f2PeakSec * 0.45 : rp.f2PeakSec, rp.tau2 * (art === "H" ? 1.15 : 1.0));
  const b3 = solveBloomPump(rp.f3PeakSec, rp.tau3);
  const b4 = solveBloomPump(rp.f4PeakSec, rp.tau4);

  // Subtle authentic hand-hammered tuning micro-cents (±1..3 cents)
  const f1 = freq;
  const f2 = freq * Math.pow(2, (1200 + (rp.isLowDing ? 3.2 : -1.4)) / 1200);
  const f3 = freq * 3 * Math.pow(2, (rp.isLowDing ? 1.2 : -2.2) / 1200);
  const f4 = freq * 4 * Math.pow(2, -1.0 / 1200);

  // Pitch-deflection drop on initial finger strike (smooth physical integral)
  const glideAmp = (0.0022 + 0.0030 * vel) * (rp.isLowDing ? 1.15 : 0.9);
  const glideTau = 0.026;

  // Dual-axis mode phases & stereo dipole lobes (gives authentic stereoCorr ~ 0.94–0.98)
  const modes = [
    // Primary Fundamental f0 + Orthogonal Beating Partner
    { f: f1,                  amp: 0.78 * f0Mul,                  a: b1.a, tau: rp.tau1,        norm: b1.norm, glide: glideAmp,        panL: 0.74, panR: 0.67, ph: 0.0 },
    { f: f1 + rp.beatHz,      amp: 0.24 * f0Mul,                  a: b1.a * 1.3, tau: rp.tau1 * 0.96, norm: b1.norm, glide: glideAmp * 0.5, panL: 0.63, panR: 0.77, ph: 0.4 },
    // Blooming Octave 2f0 + Beating Partner
    { f: f2,                  amp: rp.octBase * octMul * velHarm * 0.64, a: b2.a, tau: rp.tau2, norm: b2.norm, glide: glideAmp * 0.6, panL: 0.65, panR: 0.76, ph: 0.2 },
    { f: f2 + rp.beatHz*1.15, amp: rp.octBase * octMul * velHarm * 0.22, a: b2.a * 1.25, tau: rp.tau2 * 0.92, norm: b2.norm, glide: glideAmp * 0.3, panL: 0.77, panR: 0.62, ph: 1.1 },
    // Blooming Compound Fifth 3f0 (longer floating shimmer tail!)
    { f: f3,                  amp: rp.fifthBase * fifthMul * velHarm * 0.76, a: b3.a, tau: rp.tau3, norm: b3.norm, glide: glideAmp * 0.4, panL: 0.76, panR: 0.64, ph: 0.5 },
    { f: f3 + rp.beatHz*0.65, amp: rp.fifthBase * fifthMul * velHarm * 0.16, a: b3.a * 1.2, tau: rp.tau3 * 0.94, norm: b3.norm, glide: 0, panL: 0.61, panR: 0.78, ph: 1.7 },
    // Clean Double Octave 4f0
    { f: f4,                  amp: rp.p4Base * velHarm * 0.85,    a: b4.a, tau: rp.tau4,        norm: b4.norm, glide: 0,               panL: 0.68, panR: 0.73, ph: 0.8 },
    // Subtle Sympathetic Shell Modes (measured in real Yishama spectra: 1.5f0 & 1.36f0 at -28 to -34 dB)
    { f: f1 * 1.50,           amp: voicing.sympLevel * vel * 0.9, a: 0.08, tau: rp.tau2 * 0.75, norm: 1.5,     glide: 0,               panL: 0.80, panR: 0.58, ph: 0.9 },
    { f: f1 * 1.363,          amp: voicing.sympLevel * vel * 0.5, a: 0.09, tau: rp.tau1 * 0.70, norm: 1.5,     glide: 0,               panL: 0.58, panR: 0.80, ph: 2.1 }
  ];

  // Sub-octave shell sympathetic mode on upper notes (f > 280 Hz)
  if (freq > 280 && art !== "H") {
    modes.push({
      f: f1 * 0.5, amp: voicing.sympLevel * vel * 0.85, a: 0.05, tau: rp.tau1 * 0.65, norm: 1.3, glide: 0, panL: 0.71, panR: 0.71, ph: 0.3
    });
  }

  // Synthesize modal bank sample-by-sample in float64
  for (const m of modes) {
    if (m.amp < 0.0008 || m.f > SR * 0.44) continue;
    const invA = 1 / m.a;
    const invTau = 1 / m.tau;
    const twoPiF = 2 * Math.PI * m.f;
    const gTerm = m.glide * glideTau;
    const amp = m.amp * m.norm * vel;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const env = (1 - Math.exp(-t * invA)) * Math.exp(-t * invTau);
      if (t > 0.25 && env < 1e-5) break;
      const ph = twoPiF * (t + gTerm * (1 - Math.exp(-t / glideTau))) + m.ph;
      const s = Math.sin(ph) * env * amp;
      L[i] += s * m.panL;
      R[i] += s * m.panR;
    }
  }

  // Helmholtz Air Cavity (~74-86 Hz) on Ding & low notes (f < 250 Hz)
  if (voicing.helmLevel > 0.005 && freq < 260 && art !== "H") {
    const hAmp = voicing.helmLevel * (rp.isLowDing ? 1.0 : 0.38) * vel;
    const hHz = voicing.helmHz * (rp.isLowDing ? 1.0 : 1.04);
    const hTau = rp.isLowDing ? 0.115 : 0.068;
    const hLen = Math.min(n, Math.floor(0.8 * SR));
    for (let i = 0; i < hLen; i++) {
      const t = i / SR;
      const env = (1 - Math.exp(-t / 0.007)) * Math.exp(-t / hTau);
      const ph = 2 * Math.PI * hHz * (t + 0.22 * 0.055 * (1 - Math.exp(-t / 0.055)));
      const s = Math.sin(ph) * env * hAmp;
      L[i] += s * 0.72;
      R[i] += s * 0.72;
    }
  }

  // Warm Finger-Pad Skin Contact Transient (5-18ms low-mid, zero harsh digital air hiss!)
  if (voicing.skinLevel > 0.002) {
    const tLen = Math.floor(0.055 * SR);
    const rawN = new Float64Array(tLen);
    for (let i = 0; i < tLen; i++) {
      const t = i / SR;
      const env = Math.sin(Math.PI * clamp(t / 0.0035, 0, 0.5)) * Math.exp(-t / 0.0075);
      rawN[i] = (rng() * 2 - 1) * env;
    }
    const centerHz = rp.isLowDing ? 360 : clamp(freq * 1.9, 440, 1050);
    const shaped = bandpassFilter(rawN, centerHz, 1.15);
    const sGain = voicing.skinLevel * vel * 1.65;
    for (let i = 0; i < tLen; i++) {
      L[i] += shaped[i] * sGain * 0.74;
      R[i] += shaped[i] * sGain * 0.68;
    }
  }

  // Gentle studio air lowpass & micro wooden-room early reflections
  applyLowpass(L, voicing.lpfHz * (0.72 + 0.35 * vel));
  applyLowpass(R, voicing.lpfHz * (0.72 + 0.35 * vel));
  addEarlyRoomReflections(L, R, voicing.roomLevel);

  // Smooth fade-out on last 45ms to guarantee zero end-of-buffer click
  const fadeN = Math.floor(0.045 * SR);
  for (let i = 0; i < fadeN; i++) {
    const w = 0.5 * (1 + Math.cos((Math.PI * i) / fadeN));
    L[n - fadeN + i] *= w;
    R[n - fadeN + i] *= w;
  }

  // Peak normalize consistently by velocity (so soft layer is genuinely softer than forte!)
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.max(Math.abs(L[i]), Math.abs(R[i]));
    if (a > peak) peak = a;
  }
  const targetPeak = clamp(0.24 + 0.64 * vel, 0.25, 0.88);
  const normGain = peak > 1e-6 ? targetPeak / peak : 1;
  for (let i = 0; i < n; i++) {
    L[i] *= normGain;
    R[i] *= normGain;
  }
  return { L, R };
}

function synthTakStereo(voicing) {
  const durSec = 0.32;
  const n = Math.floor(durSec * SR);
  const L = new Float64Array(n), R = new Float64Array(n);
  const rng = mulberry32(9911);
  const raw = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    raw[i] = (rng() * 2 - 1) * Math.exp(-t / 0.0085);
  }
  const slap = bandpassFilter(raw, 2550, 1.35);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const knock =
      Math.sin(2 * Math.PI * 860 * (t + 0.14 * 0.015 * (1 - Math.exp(-t / 0.015)))) * Math.exp(-t / 0.013) * 0.38 +
      Math.sin(2 * Math.PI * 1610 * t) * Math.exp(-t / 0.009) * 0.22;
    const s = slap[i] * 1.45 + knock;
    L[i] = s * 0.74;
    R[i] = s * 0.68;
  }
  addEarlyRoomReflections(L, R, voicing.roomLevel * 0.8);
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  const g = peak > 0 ? 0.84 / peak : 1;
  for (let i = 0; i < n; i++) { L[i] *= g; R[i] *= g; }
  return { L, R };
}

function synthGuStereo(voicing) {
  const durSec = 0.58;
  const n = Math.floor(durSec * SR);
  const L = new Float64Array(n), R = new Float64Array(n);
  const rng = mulberry32(7733);
  const raw = new Float64Array(n);
  for (let i = 0; i < n; i++) raw[i] = (rng() * 2 - 1) * Math.exp(-(i / SR) / 0.012);
  const thud = bandpassFilter(raw, 260, 0.9);
  const fHz = voicing.helmHz || 78;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = (1 - Math.exp(-t / 0.006)) * Math.exp(-t / 0.095);
    const ph = 2 * Math.PI * fHz * (t + 0.48 * 0.065 * (1 - Math.exp(-t / 0.065)));
    const s = Math.sin(ph) * env * 0.92 + thud[i] * 0.45;
    L[i] = s * 0.72;
    R[i] = s * 0.70;
  }
  addEarlyRoomReflections(L, R, voicing.roomLevel * 0.6);
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  const g = peak > 0 ? 0.86 / peak : 1;
  for (let i = 0; i < n; i++) { L[i] *= g; R[i] *= g; }
  return { L, R };
}

// Write stereo float64 arrays to 16-bit PCM WAV Buffer
function encodeWav16Buffer(L, R) {
  const len = L.length;
  const dataSize = len * 4;
  const buf = Buffer.allocUnsafe(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);

  let off = 44;
  for (let i = 0; i < len; i++) {
    const sl = clamp(L[i], -1, 1);
    const sr = clamp(R[i], -1, 1);
    buf.writeInt16LE(sl < 0 ? Math.round(sl * 32768) : Math.round(sl * 32767), off);
    buf.writeInt16LE(sr < 0 ? Math.round(sr * 32768) : Math.round(sr * 32767), off + 2);
    off += 4;
  }
  return buf;
}

// Encode stereo WAV Buffer -> compact MP3 Base64 via ffmpeg pipe
function wavToMp3Base64(wavBuf) {
  const res = spawnSync(
    "ffmpeg",
    ["-v", "error", "-f", "wav", "-i", "pipe:0", "-c:a", "libmp3lame", "-b:a", BITRATE, "-f", "mp3", "pipe:1"],
    { input: wavBuf, maxBuffer: 16 * 1024 * 1024 }
  );
  if (res.status !== 0) {
    throw new Error(`ffmpeg mp3 encode failed: ${res.stderr?.toString()}`);
  }
  return res.stdout.toString("base64");
}

function generateBank(voicingKey, dumpWavDir = null) {
  const voicing = BANK_VOICINGS[voicingKey];
  const t0 = Date.now();
  const samples = {};
  const velLayers = [0.42, 0.94];

  if (dumpWavDir) fs.mkdirSync(dumpWavDir, { recursive: true });

  for (const note of BANK_NOTES) {
    // Soft + Forte velocity layers
    velLayers.forEach((vel, vIdx) => {
      const { L, R } = synthNoteStereo(note, voicing, { vel, art: "N", seed: vIdx * 17 + 3 });
      const wav = encodeWav16Buffer(L, R);
      if (dumpWavDir && vIdx === 1) {
        fs.writeFileSync(path.join(dumpWavDir, `${note}.wav`), wav);
      }
      samples[`${note}|N|v${vIdx}|r0`] = wavToMp3Base64(wav);
    });
    // Crystalline 2f0 Harmonic layer
    const h = synthNoteStereo(note, voicing, { vel: 0.86, art: "H", seed: 71 });
    samples[`${note}|H|v0|r0`] = wavToMp3Base64(encodeWav16Buffer(h.L, h.R));
  }

  const tak = synthTakStereo(voicing);
  samples["PERC|TAK"] = wavToMp3Base64(encodeWav16Buffer(tak.L, tak.R));
  const gu = synthGuStereo(voicing);
  samples["PERC|GU"] = wavToMp3Base64(encodeWav16Buffer(gu.L, gu.R));

  const bankObj = {
    format: "cyber-handpan-bank-mp3-v1",
    id: voicingKey,
    meta: {
      id: voicingKey,
      name: voicing.name,
      description: voicing.description,
      generator: "scripts/pregenerate-soundbank.mjs (Node float64 physical modal bloom)",
      engine: "node-float64-bloom",
      voicing: voicingKey,
      sr: SR,
      bitrate: BITRATE,
      durSec: voicing.durSec,
      velLayers,
      rrCount: 1,
      notes: BANK_NOTES,
      count: Object.keys(samples).length,
      generatedAt: new Date().toISOString()
    },
    samples
  };

  // Write as a browser-friendly UMD/global JS bundle (works over BOTH file:// and http://!)
  const jsOut =
    `/* Auto-generated by scripts/pregenerate-soundbank.mjs — ${voicing.name} */\n` +
    `window.__HANDPAN_BANKS__ = window.__HANDPAN_BANKS__ || {};\n` +
    `window.__HANDPAN_BANKS__[${JSON.stringify(voicingKey)}] = ${JSON.stringify(bankObj)};\n`;

  const outPath = path.join(OUT_DIR, `${voicingKey}.bank.js`);
  fs.writeFileSync(outPath, jsOut);
  const sizeMB = (fs.statSync(outPath).size / (1024 * 1024)).toFixed(2);
  console.log(`Built ${voicingKey}.bank.js: ${bankObj.meta.count} stereo MP3 samples | ${sizeMB} MB | ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return { id: voicingKey, file: `${voicingKey}.bank.js`, name: voicing.name, description: voicing.description, count: bankObj.meta.count, sizeMB: +sizeMB };
}

function main() {
  const args = process.argv.slice(2);
  const dumpIdx = args.indexOf("--dump-wavs");
  const dumpDir = dumpIdx !== -1 ? args[dumpIdx + 1] : null;

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const manifest = [];
  for (const key of Object.keys(BANK_VOICINGS)) {
    const info = generateBank(key, key === "yishama-stainless" ? dumpDir : null);
    manifest.push(info);
  }
  fs.writeFileSync(path.join(OUT_DIR, "manifest.json"), JSON.stringify({ generatedAt: new Date().toISOString(), banks: manifest }, null, 2));
  console.log(`\nWrote manifest to ${path.join(OUT_DIR, "manifest.json")}`);
}

main();

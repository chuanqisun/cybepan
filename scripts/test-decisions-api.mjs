#!/usr/bin/env node
/**
 * scripts/test-decisions-api.mjs
 *
 * Live prompt-engineering & latency benchmark for the Gemini Decisions API
 * (`gemini-decision-1`, v1beta, 0 output tokens) used by docs/05-handpan-attention-steering.html.
 *
 * Reads GEMINI_API_KEY from .env (never prints or writes keys to disk).
 *
 * Usage:
 *   node scripts/test-decisions-api.mjs               # Run all 3 musical scenarios (full 6-Q suite)
 *   node scripts/test-decisions-api.mjs --suite tiers # Test lighter 3-Q suite ('full' | 'tiers' | 'direct9')
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleGenAI } from "@google/genai";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function loadApiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim();
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) {
    throw new Error("Missing .env file (or GEMINI_API_KEY env var).");
  }
  const m = fs.readFileSync(envPath, "utf8").match(/^\s*GEMINI_API_KEY\s*=\s*(.+)\s*$/m);
  if (!m) throw new Error("GEMINI_API_KEY not found in .env");
  return m[1].trim().replace(/^["']|["']$/g, "");
}

const NOTES = [
  "D3 (Ding ^1)", "A3 (^5 R)", "Bb3 (^b6 L)", "C4 (^b7 R)",
  "D4 (^1 L)", "E4 (^2 R)", "F4 (^b3 L)", "G4 (^4 R)", "A4 (^5 L)"
];

const SCENARIOS = [
  {
    name: "1. Opening Stillness (Bar 1 Intro)",
    input: [
      "HANDPAN LIVE PERFORMANCE CONTEXT",
      "Scale: D Kurd (D3=^1, A3=^5, Bb3=^b6, C4=^b7, D4=^1, E4=^2, F4=^b3, G4=^4, A4=^5) | Tempo: 76 BPM",
      "Musical Goal: Deep meditative stillness: spacious breathing rests, low-mid warmth, hypnotic gentle repetition.",
      "[LONG CONTEXT — Macro & Leitmotif]",
      "Section: Intro (Total Bar 1, Sentence #1). Bar-1 Seed Motif DNA: establishing now.",
      "[MID CONTEXT — Current 4-Bar Sentence]",
      "Active Clause: Clause 1 — Basic Idea (Bar 1/4, role=idea). Bar chords so far: i.",
      "[SHORT / MICRO CONTEXT — Immediate Transition]",
      "Last 4 steps: D3[R] -> ·[-] -> A3[R] -> ·[-]. Next step: Bar 1 step 5/8. Last pitched note: A3 (^5), Last hand: R."
    ].join("\n")
  },
  {
    name: "2. Repetitive Low Loop Needing Lift (Bar 3 Continuation)",
    input: [
      "HANDPAN LIVE PERFORMANCE CONTEXT",
      "Scale: D Kurd (D3=^1, A3=^5, Bb3=^b6, C4=^b7, D4=^1, E4=^2, F4=^b3, G4=^4, A4=^5) | Tempo: 88 BPM",
      "Musical Goal: Kinetic polyrhythmic groove: avoid flat monotony, alternate hands energetically, lift into bright tension.",
      "[LONG CONTEXT — Macro & Leitmotif]",
      "Section: Theme A (Total Bar 8, Sentence #2). Bar-1 Seed Motif DNA: D3 A3 Bb3 A3 D3 A3 Bb3 A3.",
      "[MID CONTEXT — Current 4-Bar Sentence]",
      "Active Clause: Clause 3 — Continuation (Bar 3/4, role=cont). Bar chords so far: i -> i.",
      "Last 2 bars: D3(R) A3(R) D3(R) A3(R) D3(R) A3(R) Bb3(L) A3(R) D3(R) A3(R) D3(R) A3(R) Bb3(L) A3(R) Bb3(L) A3(R)",
      "[SHORT / MICRO CONTEXT — Immediate Transition]",
      "Last 4 steps: Bb3[L] -> A3[R] -> Bb3[L] -> A3[R]. Next step: Bar 3 step 1/8. Energy has been flat in low register."
    ].join("\n")
  },
  {
    name: "3. Bar 4 Cadential Close Approaching",
    input: [
      "HANDPAN LIVE PERFORMANCE CONTEXT",
      "Scale: D Kurd (D3=^1, A3=^5, Bb3=^b6, C4=^b7, D4=^1, E4=^2, F4=^b3, G4=^4, A4=^5) | Tempo: 84 BPM",
      "Musical Goal: Lyrical storytelling arc: establish motif, lift into modal tension in bars 2-3, resolve warmly to Ding on bar 4.",
      "[LONG CONTEXT — Macro & Leitmotif]",
      "Section: Lift (Total Bar 12, Sentence #3). Bar-1 Seed Motif DNA: D3 A3 · D4 · F4 E4 ·.",
      "[MID CONTEXT — Current 4-Bar Sentence]",
      "Active Clause: Clause 4 — Cadential Close (Bar 4/4, role=cadence). Bar chords so far: i -> bVI -> bVII -> i.",
      "Last 2 bars: Bb3(L) D4(L) F4(L) A4(L) Tak(R) G4(R) F4(L) E4(R) C4(R) E4(R) G4(R) A4(L) Tak(R) G4(R) F4(L) E4(R)",
      "[SHORT / MICRO CONTEXT — Immediate Transition]",
      "Last 4 steps: G4[R] -> F4[L] -> E4[R] -> [NEXT = Bar 4 step 6/8 penultimate resolution]. Last hand: R."
    ].join("\n")
  }
];

function buildQuestions(suite) {
  const noteCriteria = Object.fromEntries(NOTES.map((n, i) => [`n${i}`, `Pull upcoming melody toward ${n}`]));
  const qAttn = {
    type: "choice",
    instructions: "Distribute attention across the 4 temporal context horizons to best shape the next 4-8 handpan steps.",
    criteria: {
      micro: "Last 1-4 steps: smooth L/R zigzag sticking, stepwise momentum, immediate micro-echo",
      short: "Last 1-2 bars: repeat and lock into the recent ostinato rhythmic-melodic cell",
      mid: "4-bar sentence grammar & harmony: drive chord progression, call-and-response, phrase cadence",
      long: "Macro arc & original seed motif DNA: thematic recall, register contrast, large-scale narrative"
    }
  };
  const qHarmony = {
    type: "choice",
    instructions: "Which modal harmony should anchor the upcoming steps?",
    criteria: {
      i: "Tonic home (D3, A3, D4, F4, A4) — grounded, resolved",
      III: "Relative bright lift (A3, C4, F4, A4) — open, warm",
      iv: "Subdominant depth (D3, Bb3, D4, G4) — contemplative",
      bVI: "Emotional departure (Bb3, D4, F4) — poignant lift",
      bVII: "Modal tension (C4, E4, G4) — forward drive",
      v: "Dominant suspension (A3, C4, E4, A4) — poised to resolve"
    }
  };
  const qFocal = {
    type: "choice",
    instructions: "Which tone field on the D Kurd handpan should receive the strongest melodic pull over the next steps?",
    criteria: noteCriteria
  };
  const qContour = {
    type: "score",
    instructions: "Rate the ideal melodic register direction over the next phrase.",
    criteria: [
      "0: Strongly descend toward the Ding tonic floor",
      "1: Gently step downward toward mid-low register",
      "2: Hover and weave around the current register",
      "3: Gently climb upward in pitch",
      "4: Lift boldly toward the upper rim notes"
    ]
  };
  const qEnergy = {
    type: "score",
    instructions: "Rate the ideal rhythmic density and percussive groove intensity (Tak/Gu/ghost notes).",
    criteria: [
      "0: Sparse meditative stillness with breathing rests",
      "1: Gentle flowing pulse, light ghost notes",
      "2: Balanced melodic groove",
      "3: Active syncopated groove with crisp Tak backbeats",
      "4: High-energy kinetic cascades and rapid alternation"
    ]
  };
  const qCadence = {
    type: "noul",
    instructions: "Should the engine apply strong cadential resolution gravity toward the tonic Ding (D3) now?",
    criteria: {
      true_description: "Phrase is closing and needs grounding resolution to D3",
      false_description: "Phrase should remain open, moving, or exploring non-tonic tones"
    }
  };
  if (suite === "tiers") return { attention_tier: qAttn, next_harmony: qHarmony, cadence_pull: qCadence };
  if (suite === "direct9") return { focal_note: qFocal, contour: qContour, cadence_pull: qCadence };
  return { attention_tier: qAttn, next_harmony: qHarmony, focal_note: qFocal, contour: qContour, energy: qEnergy, cadence_pull: qCadence };
}

async function main() {
  const args = process.argv.slice(2);
  const sIdx = args.indexOf("--suite");
  const suite = sIdx !== -1 && args[sIdx + 1] ? args[sIdx + 1] : "full";

  const ai = new GoogleGenAI({ apiKey: loadApiKey(), apiVersion: "v1beta" });
  const questions = buildQuestions(suite);
  console.log(`Testing gemini-decision-1 | suite="${suite}" (${Object.keys(questions).length} questions per call)\n`);

  for (const sc of SCENARIOS) {
    const t0 = Date.now();
    const res = await ai.decisions.create({ model: "gemini-decision-1", input: sc.input, questions });
    const ms = Date.now() - t0;
    const ans = res.answers || {};
    console.log(`=== ${sc.name} (${ms} ms | ${res.usage?.total_input_tokens ?? "?"} in / ${res.usage?.total_output_tokens ?? 0} out) ===`);
    if (ans.attention_tier) {
      const p = ans.attention_tier.probabilities;
      console.log(`  attention_tier -> ${ans.attention_tier.choice} (micro=${(p.micro*100).toFixed(1)}% short=${(p.short*100).toFixed(1)}% mid=${(p.mid*100).toFixed(1)}% long=${(p.long*100).toFixed(1)}%)`);
    }
    if (ans.next_harmony) {
      const top = Object.entries(ans.next_harmony.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 3);
      console.log(`  next_harmony   -> ${ans.next_harmony.choice} (${top.map(([k, v]) => `${k}=${(v*100).toFixed(1)}%`).join(", ")})`);
    }
    if (ans.focal_note) {
      const top = Object.entries(ans.focal_note.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 4);
      console.log(`  focal_note     -> ${top.map(([k, v]) => `${NOTES[+k.slice(1)]}=${(v*100).toFixed(1)}%`).join(", ")}`);
    }
    const line = [];
    if (ans.contour) line.push(`contour=${ans.contour.score.toFixed(2)}/4`);
    if (ans.energy) line.push(`energy=${ans.energy.score.toFixed(2)}/4`);
    if (ans.cadence_pull) line.push(`cadence_pull=${(ans.cadence_pull.noul * 100).toFixed(1)}%`);
    if (line.length) console.log("  steering       ->", line.join(" | "));
    console.log();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });

// Offline judge: an on-device model that works without the LLM.
// It starts from bundled examples and keeps learning from every LLM verdict and
// from your own corrections, so it gets closer to the LLM over time.

import { predict, trainModel } from "./model.js";
import { urlWords } from "./rules.js";
import { seedExamples } from "./training-data.js";

const ALLOW_AT = 0.75; // strict: without the LLM, only confident "study" opens
const WEIGHTS = { user: 3, llm: 1 };

export function buildModel(learned = []) {
  return trainModel([
    ...seedExamples(),
    ...learned.map(e => ({ text: e.text, label: e.label, weight: WEIGHTS[e.source] || 1 }))
  ]);
}

const clip = (text, n) => String(text || "").replace(/\s+/g, " ").trim().slice(0, n);

// The words that describe a piece of content, most informative first.
export function metadataText(meta) {
  return [
    meta.title,
    meta.channel,
    meta.category && `category ${meta.category}`,
    meta.h1 !== meta.title && meta.h1,
    clip(meta.description, 200),
    clip(meta.keywords, 120),
    meta.siteName,
    String(meta.host || "").replace(/\./g, " "),
    urlWords(meta.url)
  ]
    .filter(Boolean)
    .join(" | ");
}

/** @returns {{verdict: "allow"|"block", source: "offline", reason: string, pStudy: number}} */
export function offlineVerdict(meta, model) {
  const prediction = predict(model, metadataText(meta));
  const study = prediction.known > 0 && prediction.pStudy >= ALLOW_AT;
  const signals = prediction.signals
    .filter(s => (study ? s.weight > 0 : s.weight < 0))
    .slice(0, 3)
    .map(s => `"${s.token}"`)
    .join(", ");
  const pct = Math.round(prediction.pStudy * 100);
  return {
    verdict: study ? "allow" : "block",
    source: "offline",
    pStudy: prediction.pStudy,
    reason: prediction.known === 0
      ? "Could not verify this as study content"
      : `Offline model: ${pct}% study${signals ? ` (${signals})` : ""}`
  };
}

// Default configuration.
//
// FocusFlow is strict by design: a page opens only if its content is judged to
// be study/tech. There is no built-in list of sites or keywords: every page is
// judged from its metadata (and what the web says about the site) by a local
// LLM, and FocusFlow learns which sites are study / mixed / distraction as it goes.
// There is no switch to turn blocking off.

export const SETTINGS_VERSION = 3;

export const RULE_ACTIONS = ["allow", "block"];
export const SITE_TYPES = ["study", "mixed", "distraction"];

// The LLM judge. Any OpenAI-compatible chat endpoint works. Free, unlimited setups:
//   - Ollama on this computer (offline):          http://localhost:11434/v1
//   - your own Hugging Face Space (hf-space/):     https://<user>-<space>.hf.space/v1
//   - any server you run hf-space/ on (e.g. Oracle Cloud Always Free)
// Model "auto" = the best thinking model installed on the server (see rankModel in llm.js).
export const LLM_PRESETS = {
  ollama: { baseUrl: "http://localhost:11434/v1", model: "auto" },
  hfSpace: { baseUrl: "https://YOUR-USERNAME-focusflow-llm.hf.space/v1", model: "auto" }
};

// The thinking LLM is always used; there is no switch to turn it (or thinking) off.
export const DEFAULT_LLM = Object.freeze({
  baseUrl: LLM_PRESETS.ollama.baseUrl,
  model: LLM_PRESETS.ollama.model,
  apiKey: "",
  timeoutSec: 60
});

export const DEFAULT_SETTINGS = Object.freeze({
  version: SETTINGS_VERSION,
  rules: [], // your own always-allow / always-block sites (empty by default)
  llm: DEFAULT_LLM,
  studyHomeUrl: "https://leetcode.com/problemset/"
});

export const LIMITS = {
  historyEntries: 100,
  statsDays: 30,
  trainingExamples: 1000,
  learnedSites: 1000,
  studyMarksPerDay: 5,
  studyMarkWaitSec: 15,
  verdictCacheEntries: 1000,
  verdictCacheTtlMs: 14 * 24 * 60 * 60 * 1000,
  siteProfileTtlMs: 30 * 24 * 60 * 60 * 1000,
  metadataWaitMs: 4000,
  siteProfileWaitMs: 1500,
  fetchTimeoutMs: 6000,
  maxHtmlChars: 1_500_000
};

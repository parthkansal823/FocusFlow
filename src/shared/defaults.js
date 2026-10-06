// Default configuration.
//
// FocusFlow is strict by design: a page opens only if its content is judged to
// be study/tech. Known distraction surfaces block immediately; other pages use
// their metadata, the local classifier and the LLM as needed.
// There is no switch to turn blocking off.

export const SETTINGS_VERSION = 4;

export const RULE_ACTIONS = ["allow", "block"];
export const SITE_TYPES = ["study", "mixed", "distraction"];

// The bundled classifier handles clear pages; local AI handles unclear pages.
// Hard mode stays on independently of the classifier/AI choice.
export const DEFAULT_LLM = Object.freeze({
  enabled: true,
  baseUrl: "http://localhost:11434/v1",
  model: "auto",
  apiKey: "",
  timeoutSec: 15
});

export const DEFAULT_SETTINGS = Object.freeze({
  version: SETTINGS_VERSION,
  fastMode: true,
  rules: [], // additional always-block rules only
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
  siteReviewTtlMs: 7 * 24 * 60 * 60 * 1000,
  metadataWaitMs: 4000,
  siteProfileWaitMs: 1500,
  fetchTimeoutMs: 6000,
  maxHtmlChars: 1_500_000
};

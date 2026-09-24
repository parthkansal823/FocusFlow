// Single place that knows the storage layout. Used by the background worker
// and by the extension pages (popup, options, blocked).

import { DEFAULT_LLM, DEFAULT_SETTINGS } from "./defaults.js";
import { normalizeRules } from "./rules.js";
import { emptyStats } from "./stats.js";

export const KEYS = {
  settings: "settings",
  stats: "stats",
  history: "history",
  overrides: "overrides", // content key -> { verdict: "allow"|"block", url, title, at }
  sites: "sites", // host -> { type?, reason?, at?, profile?, profileAt? }
  training: "training", // [{ key?, text, label, source: "llm"|"user", at }]
  verdictCache: "verdictCache",
  llmStatus: "llmStatus"
};

// Keys written by older versions (FocusGuard 3.x and early 4.0 builds). Removed on upgrade.
export const LEGACY_KEYS = [
  "focusMode", "blockShorts", "blockStreaming", "customBlockedSites", "whitelistKeywords",
  "roastIndex", "uiLanguage", "motivationMode", "blockHistory", "aiDecisionCache",
  "temporaryBypass", "focus", "allowances", "lastBreakAt", "aiStatus"
];

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

const isHttpUrl = value => typeof value === "string" && /^https?:\/\/[^\s]+$/i.test(value.trim());

export function normalizeLlm(raw) {
  const l = raw && typeof raw === "object" ? raw : {};
  return {
    baseUrl: isHttpUrl(l.baseUrl) ? l.baseUrl.trim().replace(/\/+$/, "") : DEFAULT_LLM.baseUrl,
    model: typeof l.model === "string" && l.model.trim() ? l.model.trim() : DEFAULT_LLM.model,
    apiKey: typeof l.apiKey === "string" ? l.apiKey.trim() : "",
    timeoutSec: clampInt(l.timeoutSec, 5, 180, DEFAULT_LLM.timeoutSec)
  };
}

export function normalizeSettings(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  return {
    version: DEFAULT_SETTINGS.version,
    rules: Array.isArray(s.rules) ? normalizeRules(s.rules) : DEFAULT_SETTINGS.rules,
    llm: normalizeLlm(s.llm),
    studyHomeUrl: isHttpUrl(s.studyHomeUrl) ? s.studyHomeUrl.trim() : DEFAULT_SETTINGS.studyHomeUrl
  };
}

const area = () => chrome.storage.local;
const asObject = value => (value && typeof value === "object" && !Array.isArray(value) ? value : {});

// What the decision engine needs, and nothing more.
export async function readPolicyContext() {
  const data = await area().get([KEYS.settings, KEYS.overrides, KEYS.sites]);
  return {
    settings: normalizeSettings(data[KEYS.settings]),
    overrides: asObject(data[KEYS.overrides]),
    sites: asObject(data[KEYS.sites])
  };
}

// Everything the pages display.
export async function readAll() {
  const data = await area().get([
    KEYS.settings, KEYS.stats, KEYS.history, KEYS.overrides, KEYS.sites, KEYS.training, KEYS.llmStatus
  ]);
  return {
    settings: normalizeSettings(data[KEYS.settings]),
    stats: data[KEYS.stats] || emptyStats(),
    history: Array.isArray(data[KEYS.history]) ? data[KEYS.history] : [],
    overrides: asObject(data[KEYS.overrides]),
    sites: asObject(data[KEYS.sites]),
    training: Array.isArray(data[KEYS.training]) ? data[KEYS.training] : [],
    llmStatus: data[KEYS.llmStatus] || null
  };
}

export async function getSettings() {
  const data = await area().get(KEYS.settings);
  return normalizeSettings(data[KEYS.settings]);
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = normalizeSettings({ ...current, ...patch, llm: { ...current.llm, ...(patch.llm || {}) } });
  await area().set({ [KEYS.settings]: next });
  return next;
}

export async function get(key, fallback) {
  const data = await area().get(key);
  return data[key] === undefined ? fallback : data[key];
}

export function set(values) {
  return area().set(values);
}

export function remove(keys) {
  return area().remove(keys);
}

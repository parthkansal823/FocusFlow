// Single place that knows the storage layout. Used by the background worker
// and by the extension pages (popup, options, blocked).

import { DEFAULT_LLM, DEFAULT_SETTINGS, LIMITS } from "./defaults.js";
import { normalizeRules } from "./rules.js";
import { emptyStats } from "./stats.js";
import { privateUrl, publicUrl, storageKey } from "./privacy.js";

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

export function isLocalAiUrl(value) {
  if (typeof value !== "string" || /\s/.test(value.trim())) return false;
  try {
    const url = new URL(value.trim());
    return ["http:", "https:"].includes(url.protocol) &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
      !url.username && !url.password && !url.search && !url.hash &&
      url.pathname.replace(/\/+$/, "") === "/v1";
  } catch { return false; }
}

export function normalizeLlm(raw) {
  const l = raw && typeof raw === "object" ? raw : {};
  const local = isLocalAiUrl(l.baseUrl);
  return {
    enabled: l.enabled !== false && (local || l.baseUrl === undefined),
    baseUrl: local ? l.baseUrl.trim().replace(/\/+$/, "") : DEFAULT_LLM.baseUrl,
    model: typeof l.model === "string" && l.model.trim() ? l.model.trim() : DEFAULT_LLM.model,
    apiKey: "", // Ollama needs no key; never retain authentication secrets.
    timeoutSec: clampInt(l.timeoutSec, 5, 180, DEFAULT_LLM.timeoutSec)
  };
}

export function normalizeSettings(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  const oldDefaultTimeout = s.version < 4 && [60, 120].includes(s.llm?.timeoutSec);
  return {
    version: DEFAULT_SETTINGS.version,
    fastMode: typeof s.fastMode === "boolean" ? s.fastMode : DEFAULT_SETTINGS.fastMode,
    rules: Array.isArray(s.rules) ? normalizeRules(s.rules).filter(rule => rule.action === "block") : DEFAULT_SETTINGS.rules,
    llm: normalizeLlm(oldDefaultTimeout ? { ...s.llm, timeoutSec: DEFAULT_LLM.timeoutSec } : s.llm),
    studyHomeUrl: isHttpUrl(s.studyHomeUrl) ? s.studyHomeUrl.trim() : DEFAULT_SETTINGS.studyHomeUrl
  };
}

const area = () => chrome.storage.local;
const asObject = value => (value && typeof value === "object" && !Array.isArray(value) ? value : {});

let privacyArea = null, privacyPromise = null;
export function ensurePrivacy() {
  const currentArea = area();
  if (privacyArea === currentArea && privacyPromise) return privacyPromise;
  privacyArea = currentArea;
  privacyPromise = (async () => {
    // The guard needs messages, not direct storage access. Keep saved browsing
    // data available only to the worker and extension-owned pages.
    if (currentArea.setAccessLevel) await currentArea.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    const data = await currentArea.get(["privacyVersion", KEYS.overrides, KEYS.sites, KEYS.settings, KEYS.verdictCache, KEYS.history]);
    if (data.privacyVersion === 1) {
      const now = Date.now();
      const history = (Array.isArray(data[KEYS.history]) ? data[KEYS.history] : []).filter(item => item.at >= now - LIMITS.historyTtlMs && item.at <= now);
      const cache = Object.fromEntries(Object.entries(asObject(data[KEYS.verdictCache])).filter(([key, entry]) => /^sha256:[a-f0-9]{64}$/.test(key) && entry.at >= now - LIMITS.verdictCacheTtlMs && entry.at <= now));
      if (history.length !== (data[KEYS.history] || []).length || Object.keys(cache).length !== Object.keys(data[KEYS.verdictCache] || {}).length) {
        await currentArea.set({ [KEYS.history]: history, [KEYS.verdictCache]: cache });
      }
      return;
    }
    const overrides = {};
    for (const [key, mark] of Object.entries(asObject(data[KEYS.overrides]))) {
      if (mark?.verdict !== "block" || privateUrl(mark.url)) continue;
      const url = publicUrl(mark.url, { originOnly: true });
      overrides[await storageKey(key)] = { verdict: "block", url, title: new URL(url).hostname, at: Number(mark.at) || Date.now() };
    }
    const sites = {};
    for (const [host, value] of Object.entries(asObject(data[KEYS.sites]))) {
      if (privateUrl(`https://${host}/`)) continue;
      sites[host] = {
        allowed: Number(value.allowed) || 0, blocked: Number(value.blocked) || 0,
        votes: { study: Number(value.votes?.study) || 0, mixed: Number(value.votes?.mixed) || 0, distraction: Number(value.votes?.distraction) || 0 },
        at: Number(value.at) || 0,
        ...(value.review ? { review: { source: value.review.source, version: value.review.version, type: value.review.type, at: value.review.at, reason: "AI site review" } } : {})
      };
    }
    // Upgrade hygiene: discard generated data that may contain raw old page
    // text, titles or URL secrets. Keep settings, counts and safe block marks.
    await currentArea.set({ privacyVersion: 1, [KEYS.history]: [], [KEYS.training]: [],
      [KEYS.verdictCache]: {}, [KEYS.llmStatus]: null, [KEYS.overrides]: overrides,
      [KEYS.sites]: sites, [KEYS.settings]: normalizeSettings(data[KEYS.settings]) });
  })().catch(error => { privacyPromise = null; throw error; });
  return privacyPromise;
}

// What the decision engine needs, and nothing more.
export async function readPolicyContext() {
  await ensurePrivacy();
  const data = await area().get([KEYS.settings, KEYS.overrides, KEYS.sites]);
  return {
    settings: normalizeSettings(data[KEYS.settings]),
    overrides: asObject(data[KEYS.overrides]),
    sites: asObject(data[KEYS.sites])
  };
}

// Everything the pages display.
export async function readAll() {
  await ensurePrivacy();
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
  await ensurePrivacy();
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

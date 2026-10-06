// Corrections the user can make. None of them turns blocking off:
//   - "This is study content"   → rejected (hard mode has no bypass)
//   - "Block this page"          → always block one exact page/video
//   - forget a learned site      → it will be judged again
// Every correction also teaches the offline model.

import { contentKey, isYouTubeHost, normalizeHost, parseUrl } from "../shared/rules.js";
import { forgetSiteRecord, recordSitePage } from "../shared/policy.js";
import * as store from "../shared/store.js";
import { KEYS } from "../shared/store.js";
import { forgetVerdict, queueWrite, resetVerdictCache, trimTraining } from "./controller.js";

function trainingExample(key, url, title, label) {
  const parsed = parseUrl(url);
  const host = parsed ? normalizeHost(parsed.hostname).replace(/\./g, " ") : "";
  return { key, text: [title, host].filter(Boolean).join(" | "), label, source: "user", at: Date.now() };
}

async function saveMark(key, mark, label) {
  await queueWrite(async () => {
    const data = await chrome.storage.local.get([KEYS.overrides, KEYS.training, KEYS.sites]);
    const overrides = data[KEYS.overrides] || {};
    overrides[key] = mark;
    const training = (data[KEYS.training] || []).filter(e => e.key !== key);
    training.push(trainingExample(key, mark.url, mark.title, label));
    // Your mark is evidence about the site too: one study page keeps it from
    // ever being blocked as a whole.
    const sites = data[KEYS.sites] || {};
    const parsed = parseUrl(mark.url);
    const host = parsed ? normalizeHost(parsed.hostname) : "";
    if (host && !isYouTubeHost(host)) sites[host] = recordSitePage(sites[host], { verdict: mark.verdict }, Date.now());
    await store.set({ [KEYS.overrides]: overrides, [KEYS.training]: trimTraining(training), [KEYS.sites]: sites });
  });
  await forgetVerdict(key);
}

export async function markStudy() {
  return { ok: false, error: "Hard mode is always on. Study bypasses are disabled." };
}

export async function markDistraction({ tabId }) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return { ok: false, error: "That tab is gone." };
  }
  const key = contentKey(tab.url || "");
  if (!key || !/^https?:/i.test(tab.url)) return { ok: false, error: "Only web pages can be blocked." };
  const title = String(tab.title || "").replace(/\s*-\s*YouTube$/i, "").slice(0, 200);
  await saveMark(key, { verdict: "block", url: tab.url, title, at: Date.now() }, "distraction");
  return { ok: true };
}

export async function removeMark({ key }) {
  await queueWrite(async () => {
    const data = await chrome.storage.local.get([KEYS.overrides, KEYS.training]);
    const overrides = data[KEYS.overrides] || {};
    delete overrides[key];
    const training = (data[KEYS.training] || []).filter(e => !(e.key === key && e.source === "user"));
    await store.set({ [KEYS.overrides]: overrides, [KEYS.training]: training });
  });
  return { ok: true };
}

// Forget what FocusFlow learned about a site: it will be judged again next time.
export async function forgetSite({ host }) {
  await queueWrite(async () => {
    const sites = await store.get(KEYS.sites, {});
    if (sites[host]) sites[host] = forgetSiteRecord(sites[host]);
    await store.set({ [KEYS.sites]: sites });
  });
  return { ok: true };
}

export async function resetLearning() {
  await queueWrite(async () => {
    const training = (await store.get(KEYS.training, [])).filter(e => e.source === "user");
    await store.set({ [KEYS.sites]: {}, [KEYS.verdictCache]: {}, [KEYS.training]: training });
    resetVerdictCache();
  });
  return { ok: true };
}

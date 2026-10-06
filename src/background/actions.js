// Corrections the user can make. None of them turns blocking off:
//   - "This is study content"   → rejected (hard mode has no bypass)
//   - "Block this page"          → always block one exact page/video
//   - forget a learned site      → it will be judged again
// Marks no longer retain title/text training examples.

import { contentKey, isYouTubeHost, normalizeHost, parseUrl } from "../shared/rules.js";
import { forgetSiteRecord, recordSitePage } from "../shared/policy.js";
import * as store from "../shared/store.js";
import { KEYS } from "../shared/store.js";
import { privateUrl, publicUrl, storageKey } from "../shared/privacy.js";
import { forgetVerdict, queueWrite, resetVerdictCache } from "./controller.js";

async function saveMark(key, mark) {
  await queueWrite(async () => {
    const data = await chrome.storage.local.get([KEYS.overrides, KEYS.sites]);
    const overrides = data[KEYS.overrides] || {};
    overrides[key] = mark;
    // Distraction marks contribute block evidence; there is no study bypass.
    const sites = data[KEYS.sites] || {};
    const parsed = parseUrl(mark.url);
    const host = parsed ? normalizeHost(parsed.hostname) : "";
    if (host && !isYouTubeHost(host)) sites[host] = recordSitePage(sites[host], { verdict: mark.verdict }, Date.now());
    await store.set({ [KEYS.overrides]: overrides, [KEYS.sites]: sites });
  });
  await forgetVerdict(key);
}

export async function markStudy() {
  return { ok: false, error: "Hard mode is always on. Study bypasses are disabled." };
}

export async function markDistraction({ tabId }) {
  await store.ensurePrivacy();
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return { ok: false, error: "That tab is gone." };
  }
  if (privateUrl(tab.url || "")) return { ok: false, error: "Private pages are already protected; their data is not saved." };
  const key = await storageKey(contentKey(tab.url || ""));
  if (!key || !/^https?:/i.test(tab.url)) return { ok: false, error: "Only web pages can be blocked." };
  const url = publicUrl(tab.url, { originOnly: true });
  await saveMark(key, { verdict: "block", url, title: new URL(url).hostname, at: Date.now() });
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

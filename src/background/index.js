// FocusFlow background entry point. All listeners are registered synchronously
// at the top level so the service worker can be woken by any of them.

import { contentKey, isYouTubeHost, normalizeHost, parseUrl, youtubeVideoId } from "../shared/rules.js";
import * as store from "../shared/store.js";
import { KEYS, LEGACY_KEYS } from "../shared/store.js";
import { buildModel, offlineVerdict } from "../shared/offline.js";
import { siteType } from "../shared/policy.js";
import * as actions from "./actions.js";
import * as controller from "./controller.js";
import { askLlm, listModels, warmUp } from "./llm.js";

const isMainFrame = details =>
  details.frameId === 0 && details.tabId >= 0 && details.documentLifecycle !== "prerender";

// --- Navigation --------------------------------------------------------------

chrome.webNavigation.onBeforeNavigate.addListener(details => {
  // A brand-new navigation (or reload): always judge it again.
  if (isMainFrame(details)) controller.evaluateTab(details.tabId, details.url, { force: true });
});

chrome.webNavigation.onCommitted.addListener(details => {
  // Catches server-side redirects to a different URL.
  if (isMainFrame(details)) controller.evaluateTab(details.tabId, details.url);
});

chrome.webNavigation.onHistoryStateUpdated.addListener(details => {
  // In-page navigation (YouTube, Reddit, ...).
  if (isMainFrame(details)) controller.evaluateTab(details.tabId, details.url);
});

chrome.tabs.onUpdated.addListener((tabId, change) => {
  // Safety net for anything the webNavigation events miss (prerender activation, bfcache).
  if (change.url) controller.evaluateTab(tabId, change.url);
});

chrome.tabs.onRemoved.addListener(tabId => controller.forgetTab(tabId));

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  controller.forgetTab(removedTabId);
  chrome.tabs.get(addedTabId).then(tab => controller.evaluateTab(addedTabId, tab.url, { force: true }), () => {});
});

// --- Storage changes ---------------------------------------------------------

const llmChanged = ({ oldValue, newValue }) => {
  const pick = s => (s && s.llm ? `${s.llm.baseUrl}|${s.llm.model}` : "");
  return pick(oldValue) !== pick(newValue);
};

const siteTypes = sites =>
  JSON.stringify(Object.entries(sites || {}).map(([host, s]) => [host, siteType(s)]).filter(([, t]) => t).sort());

let reevaluateTimer = null;
let reevaluateAll = false;
function scheduleReevaluation({ includePending }) {
  reevaluateAll = reevaluateAll || includePending;
  clearTimeout(reevaluateTimer);
  reevaluateTimer = setTimeout(() => {
    const includePendingTabs = reevaluateAll;
    reevaluateAll = false;
    controller.reevaluateAllTabs({ includePending: includePendingTabs });
  }, 200);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (KEYS.training in changes) controller.invalidateModel();

  if (KEYS.settings in changes && llmChanged(changes[KEYS.settings])) wakeLlm();

  const policyChanged = KEYS.settings in changes || KEYS.overrides in changes;
  const sitesChanged = KEYS.sites in changes;
  if (!policyChanged && !sitesChanged) return;
  controller.invalidateContext();

  // New rules and marks apply to every open tab right away. A newly learned site
  // type applies to settled tabs; tabs still being judged keep their request.
  if (policyChanged) {
    scheduleReevaluation({ includePending: true });
  } else if (siteTypes(changes[KEYS.sites].oldValue) !== siteTypes(changes[KEYS.sites].newValue)) {
    scheduleReevaluation({ includePending: false });
  }
});

// --- Lifecycle -----------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  await store.remove(LEGACY_KEYS);
  const data = await chrome.storage.local.get(KEYS.stats);
  const stats = data[KEYS.stats];
  if (stats && !("days" in stats)) {
    // FocusGuard 3.x stats: keep the all-time total.
    await store.set({ [KEYS.stats]: { total: Number(stats.totalBlocked) || 0, days: {} } });
  }
  await store.set({ [KEYS.settings]: await store.getSettings() });
  await controller.reevaluateAllTabs();
  wakeLlm();
});

// Load the model as soon as the browser opens (and when you pick another one),
// so the first page you visit is judged at full speed. This also wakes a
// sleeping Hugging Face Space.
chrome.runtime.onStartup.addListener(() => wakeLlm());

async function wakeLlm() {
  try {
    await warmUp((await store.getSettings()).llm);
  } catch {
    // not reachable yet; the first real request will report it
  }
}

// --- Messages ------------------------------------------------------------------

function isExtensionPage(sender) {
  return sender.id === chrome.runtime.id && (sender.url || "").startsWith(chrome.runtime.getURL(""));
}

// "Test a page" in Settings: the full pipeline for any URL, without touching a tab.
async function testUrl(url) {
  const parsed = parseUrl(url);
  if (!parsed || !/^https?:$/.test(parsed.protocol)) return { ok: false, error: "Enter a full http(s) URL." };
  const ctx = await store.readPolicyContext();
  const decision = {
    key: contentKey(parsed),
    kind: youtubeVideoId(parsed) ? "youtube" : "page",
    host: normalizeHost(parsed.hostname)
  };
  const meta = await controller.gatherMetadata(decision, parsed.href);
  const model = buildModel(await store.get(KEYS.training, []));
  const offline = offlineVerdict(meta, model);
  let llm;
  const started = Date.now();
  try {
    llm = { ok: true, ...(await askLlm(meta, ctx.settings.llm)), ms: Date.now() - started };
  } catch (error) {
    llm = { ok: false, error: error.message };
  }
  const { site, ...pageMeta } = meta;
  return { ok: true, meta: pageMeta, site, youtube: isYouTubeHost(decision.host), offline, llm };
}

const handlers = {
  // From the content script on every page.
  "ff:hello": {
    public: true,
    run: (_msg, sender) =>
      sender.tab && sender.frameId === 0
        ? controller.stateForContent(sender.tab.id, sender.url || sender.tab.url)
        : { state: "allowed", version: 0 }
  },
  // Links the page shows (visible videos, the link under the mouse): judge them early.
  "ff:prefetch": {
    public: true,
    run: (msg, sender) =>
      sender.tab && sender.frameId === 0 ? controller.prefetch(msg.urls, msg.reason) : { queued: 0 }
  },
  // From extension pages only.
  "ff:mark-study": { run: msg => actions.markStudy(msg) },
  "ff:mark-distraction": { run: msg => actions.markDistraction(msg) },
  "ff:remove-mark": { run: msg => actions.removeMark(msg) },
  "ff:forget-site": { run: msg => actions.forgetSite(msg) },
  "ff:reset-learning": { run: () => actions.resetLearning() },
  "ff:test-url": { run: msg => testUrl(String(msg.url || "").trim()) },
  "ff:list-models": {
    run: async msg => {
      try {
        return { ok: true, models: await listModels(store.normalizeLlm(msg.llm)) };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    }
  }
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = msg && handlers[msg.type];
  if (!handler) return false;
  if (!handler.public && !isExtensionPage(sender)) return false;

  Promise.resolve()
    .then(() => handler.run(msg, sender))
    .then(sendResponse, error => sendResponse({ ok: false, error: error.message }));
  return true;
});

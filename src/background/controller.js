// The tab controller: the single place where navigations are judged.
//
//   navigation ─▶ decide() ─┬─ allow ─────────────────────────────▶ page opens
//                           ├─ block ─────────────────────────────▶ blocked page
//                           └─ check ─▶ page held ("pending", media paused, covered)
//                                     ─▶ remembered verdict?
//                                     ─▶ metadata (page DOM + YouTube/site info from the net)
//                                     ─▶ local AI ──▶ site review + hashed verdict cache
//                                         └─ unavailable ─▶ offline model (strict: unsure = block)
//                                     ─▶ allow | block
//
// Content scripts never decide anything; they mirror the state we push and
// hand over page metadata when asked.

import { LIMITS } from "../shared/defaults.js";
import { buildModel, fastVerdict, offlineVerdict } from "../shared/offline.js";
import { decide, recordSitePage, siteReview } from "../shared/policy.js";
import { contentKey, isWebUrl, isYouTubeHost, normalizeHost, parseUrl, youtubeVideoId } from "../shared/rules.js";
import { privateUrl, publicUrl, sanitizeMetadata, protectedMeta, storageKey, PRIVACY_REASON } from "../shared/privacy.js";
import { appendHistory, recordBlock } from "../shared/stats.js";
import * as store from "../shared/store.js";
import { KEYS } from "../shared/store.js";
import { askLlm } from "./llm.js";
import { pageFromNet, siteProfileFromNet, youtubeFromNet } from "./metadata.js";

const tabs = new Map(); // tabId -> { url, state: "checking"|"pending"|"allowed"|"blocked", version }
// A worker can restart while the content script is still alive. Its new state
// must be newer than the version previously sent to that document.
let stateVersion = Date.now();
let contextPromise = null;
let modelPromise = null;
let cachePromise = null;
let writeQueue = Promise.resolve();
let lastLlmStatus = null;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Cached state (invalidated from index.js when storage changes)

export function invalidateContext() {
  contextPromise = null;
}

export function invalidateModel() {
  modelPromise = null;
}

function getContext() {
  if (!contextPromise) {
    contextPromise = store.readPolicyContext().catch(error => {
      contextPromise = null;
      throw error;
    });
  }
  return contextPromise;
}

function getModel() {
  if (!modelPromise) modelPromise = store.get(KEYS.training, []).then(buildModel);
  return modelPromise;
}

function getVerdictCache() {
  if (!cachePromise) cachePromise = store.get(KEYS.verdictCache, {});
  return cachePromise;
}

export function resetVerdictCache() {
  cachePromise = Promise.resolve({});
}

// Serialize read-modify-write storage updates so parallel tabs don't lose writes.
export function queueWrite(task) {
  writeQueue = writeQueue.then(task).catch(error => console.error("[FocusFlow] storage write failed", error));
  return writeQueue;
}

function llmFingerprint(llm) {
  return ["hard-v4.0.3-private-metadata", llm.enabled ? "ai" : "lightweight", llm.baseUrl, llm.model].join("|");
}

async function cachedVerdict(key, llm) {
  const entry = (await getVerdictCache())[await storageKey(key)];
  if (!entry || entry.fp !== llmFingerprint(llm) || Date.now() - entry.at > LIMITS.verdictCacheTtlMs) return null;
  return entry;
}

export function forgetVerdict(key) {
  return queueWrite(async () => {
    key = await storageKey(key);
    const cache = await store.get(KEYS.verdictCache, {});
    delete cache[key];
    cachePromise = Promise.resolve(cache);
    await store.set({ [KEYS.verdictCache]: cache });
  });
}

// ---------------------------------------------------------------------------
// Tab state

function stripHash(url) {
  const i = String(url).indexOf("#");
  return i === -1 ? url : url.slice(0, i);
}

function isCurrent(tabId, entry) {
  return tabs.get(tabId) === entry;
}

function setState(tabId, entry, state) {
  if (!isCurrent(tabId, entry)) return;
  entry.state = state;
  entry.version = ++stateVersion;
  chrome.tabs
    .sendMessage(tabId, { type: "ff:state", state, version: entry.version, url: entry.url }, { frameId: 0 })
    .catch(() => {}); // no content script yet: it will ask with ff:hello
}

export function forgetTab(tabId) {
  tabs.delete(tabId);
}

/**
 * Judge `url` for `tabId`. Repeated events for the URL we're already handling
 * are ignored unless `force` is set (new navigation, reload, settings change).
 */
export function evaluateTab(tabId, url, { force = false } = {}) {
  if (typeof tabId !== "number" || tabId < 0) return Promise.resolve();
  if (!isWebUrl(url)) {
    tabs.delete(tabId);
    return Promise.resolve();
  }
  const existing = tabs.get(tabId);
  if (!force && existing && stripHash(existing.url) === stripHash(url)) return existing.done;

  const entry = { url, state: "checking", version: ++stateVersion };
  tabs.set(tabId, entry);
  entry.done = run(tabId, entry).catch(error => {
    console.error("[FocusFlow] evaluation failed"); // never log raw URLs/errors from private pages
    // Strict mode: if our own pipeline breaks, block rather than let it through.
    return blockTab(tabId, entry, { kind: "content", source: "error", reason: "Could not verify this page" });
  });
  return entry.done;
}

/**
 * Judge every open tab again (rules, marks or learned sites changed).
 * With `includePending: false`, tabs still waiting for a verdict are left alone
 * so a slow LLM request isn't thrown away and asked again.
 */
export async function reevaluateAllTabs({ includePending = true } = {}) {
  const all = await chrome.tabs.query({});
  await Promise.all(
    all
      // A tab that is still loading reports its old URL in `url` and the new one in `pendingUrl`.
      .map(t => ({ id: t.id, url: t.pendingUrl || t.url }))
      .filter(t => isWebUrl(t.url))
      .filter(t => includePending || !["checking", "pending"].includes((tabs.get(t.id) || {}).state))
      .map(t => evaluateTab(t.id, t.url, { force: true }))
  );
}

// Content script asked "what is my state?" (it may have missed our pushes).
export function stateForContent(tabId, url) {
  const entry = tabs.get(tabId);
  if (!entry || stripHash(entry.url) !== stripHash(url)) evaluateTab(tabId, url);
  const current = tabs.get(tabId);
  if (!current) return { state: "allowed", version: stateVersion };
  return { state: current.state === "allowed" ? "allowed" : "pending", version: current.version, url: current.url };
}

// ---------------------------------------------------------------------------
// Evaluation

const BLOCK_REASONS = {
  privacy: () => PRIVACY_REASON,
  hard: d => d.detail,
  marked: () => "You marked this page as a distraction",
  rule: d => `${d.pattern} is on your block list`,
  site: (d, ctx) => {
    const blocked = (ctx.sites[d.host] || {}).blocked || 0;
    return `FocusFlow learned that ${d.host} is a distraction site (${blocked} pages blocked, none were study)`;
  }
};

async function run(tabId, entry) {
  const ctx = await getContext();
  if (!isCurrent(tabId, entry)) return;

  const decision = decide(entry.url, ctx);
  if (decision.reason !== "privacy" && decision.reason !== "hard" && decision.reason !== "not-web" && decision.reason !== "local" && decision.reason !== "browser-safety") {
    const mark = ctx.overrides[await storageKey(contentKey(entry.url))];
    if (!isCurrent(tabId, entry)) return;
    if (mark?.verdict === "block") {
      await blockTab(tabId, entry, { kind: "marked", source: "marked", reason: BLOCK_REASONS.marked() });
      return;
    }
  }
  if (decision.action === "allow") {
    setState(tabId, entry, "allowed");
    return;
  }
  if (decision.action === "block") {
    await blockTab(tabId, entry, {
      kind: decision.reason,
      source: ["site", "hard", "privacy"].includes(decision.reason) ? decision.reason : "rule",
      reason: BLOCK_REASONS[decision.reason](decision, ctx)
    });
    return;
  }

  setState(tabId, entry, "pending");
  // Only the latest check of a tab acts on the verdict, but the work (reading the
  // page, asking the AI) is worth finishing as long as the tab is on this page:
  // a re-check of the same page simply joins it.
  const stillWanted = () => isCurrent(tabId, entry);
  const onThisPage = () => {
    const current = tabs.get(tabId);
    return Boolean(current) && stripHash(current.url) === stripHash(entry.url);
  };
  let verdict = await cachedVerdict(decision.key, ctx.settings.llm);
  let livePage = null;
  const needsSiteReview = ctx.settings.llm.enabled && !isYouTubeHost(decision.host) && !siteReview(ctx.sites[decision.host]);
  if (!verdict && !ctx.settings.llm.enabled && stillWanted()) {
    // AI-disabled fallback: one DOM snapshot and the tiny bundled model.
    // No AI, network metadata, speculative prefetch, or self-training.
    const page = await metadataFromTab(tabId, entry.url, stillWanted);
    if (!stillWanted()) return;
    if (page?.privacyProtected) return blockTab(tabId, entry, { kind: "privacy", source: "privacy", reason: PRIVACY_REASON });
    const meta = { ...(page || {}), url: entry.url, host: decision.host, kind: decision.kind };
    const model = await getModel();
    verdict = fastVerdict(meta, model) || { ...offlineVerdict(meta, model), title: meta.title || "" };
  }
  if (!verdict && ctx.settings.fastMode && stillWanted()) {
    // Mixed/reviewed sites and YouTube use the cheap page check. A new site's
    // first allowed page goes to AI once to review its purpose, not a fixed list.
    const page = await metadataFromTab(tabId, entry.url, stillWanted);
    if (page && stillWanted()) {
      if (page.privacyProtected) return blockTab(tabId, entry, { kind: "privacy", source: "privacy", reason: PRIVACY_REASON });
      livePage = page;
      const local = fastVerdict({ ...page, url: entry.url, host: decision.host, kind: decision.kind }, await getModel());
      if (local?.verdict === "block" || !needsSiteReview) verdict = local;
    }
  }
  for (let attempt = 0; !verdict && attempt < 2 && stillWanted(); attempt++) {
    verdict = await verdictFor(decision, ctx, {
      wanted: onThisPage,
      getMeta: wanted => gatherMetadata(decision, entry.url, { tabId, stillWanted: wanted, pageMeta: livePage })
    });
  }
  if (!verdict || !stillWanted()) return;

  if (verdict.verdict === "block") {
    await blockTab(tabId, entry, {
      kind: verdict.source === "privacy" ? "privacy" : "content",
      key: decision.key,
      title: verdict.title,
      reason: verdict.reason,
      source: verdict.source
    });
  } else {
    setState(tabId, entry, "allowed");
  }
}

// ---------------------------------------------------------------------------
// Kept for old content scripts. Hovering/scrolling must not start inference or
// fetch unused pages: local AI is reserved for the page actually being opened.
export async function prefetch() {
  return { queued: 0 };
}

/**
 * Collect everything we know about the content at `url`.
 * With a tab, page metadata comes from the live DOM; without one (Settings
 * "test a page"), from the network.
 */
export async function gatherMetadata(decision, url, { tabId = null, stillWanted = () => true, pageMeta: collectedPage = null } = {}) {
  if (privateUrl(url)) return protectedMeta(url);
  const base = { url, host: decision.host, kind: decision.kind };
  const ctx = await getContext();
  if (!ctx.settings.llm.enabled) {
    // A manual Settings test may fetch just the requested page. Browsing reads
    // its existing DOM, with no additional homepage or video requests.
    const page = tabId === null ? await pageFromNet(url) : await metadataFromTab(tabId, url, stillWanted);
    return sanitizeMetadata({ ...base, ...(page || {}) }, url);
  }

  // Read the DOM privacy marker before auxiliary website requests, including
  // when the fast classifier is disabled. A marker must never trigger fallback.
  const live = collectedPage || (tabId === null ? null : await metadataFromTab(tabId, url, stillWanted));
  if (live?.privacyProtected) return protectedMeta(url);

  if (decision.kind === "youtube") {
    const fromNet = await youtubeFromNet(youtubeVideoId(url));
    if (fromNet) return sanitizeMetadata({ ...base, ...fromNet }, url);
  }

  // The site profile helps but must not slow the answer down: if it isn't known
  // yet, wait briefly and let it finish in the background for next time.
  const profile = isYouTubeHost(decision.host) ? null : siteProfile(decision.host);
  const [page, site] = await Promise.all([
    live || (tabId === null ? pageFromNet(url) : null),
    profile && Promise.race([profile, sleep(LIMITS.siteProfileWaitMs).then(() => null)])
  ]);
  let pageMeta = page;
  if (!pageMeta && tabId !== null && stillWanted()) pageMeta = await pageFromNet(url);
  if (pageMeta?.privacyProtected) return protectedMeta(url);
  const meta = { ...base, ...(pageMeta || {}), url, site };
  if (decision.kind === "youtube") meta.title = String(meta.title || "").replace(/\s*-\s*YouTube$/i, "");
  return sanitizeMetadata(meta, url);
}

// Ask the content script for the page's metadata; it answers once the DOM is ready.
async function metadataFromTab(tabId, url, stillWanted) {
  const deadline = Date.now() + LIMITS.metadataWaitMs;
  while (stillWanted() && Date.now() < deadline) {
    try {
      const meta = await Promise.race([
        chrome.tabs.sendMessage(tabId, { type: "ff:collect", url }, { frameId: 0 }),
        sleep(Math.max(0, deadline - Date.now())).then(() => null)
      ]);
      // A different URL means the old document answered; the new one will be ready soon.
      if (meta && stripHash(meta.url) === stripHash(url)) return sanitizeMetadata(meta, url);
    } catch {
      // content script not injected yet
    }
    await sleep(200);
  }
  return null;
}

async function siteProfile(host) {
  const ctx = await getContext();
  const known = ctx.sites[host];
  if (known && known.profile && Date.now() - (known.profileAt || 0) < LIMITS.siteProfileTtlMs) return known.profile;

  const profile = await siteProfileFromNet(host);
  if (profile) {
    queueWrite(async () => {
      const sites = await store.get(KEYS.sites, {});
      sites[host] = { ...(sites[host] || {}), profile, profileAt: Date.now() };
      await store.set({ [KEYS.sites]: pruneSites(sites) });
    });
  }
  return profile;
}

function pruneSites(sites) {
  const hosts = Object.keys(sites);
  if (hosts.length <= LIMITS.learnedSites) return sites;
  const stamp = h => Math.max(sites[h].at || 0, sites[h].profileAt || 0);
  hosts.sort((a, b) => stamp(a) - stamp(b)).slice(0, hosts.length - LIMITS.learnedSites).forEach(h => delete sites[h]);
  return sites;
}

// ---------------------------------------------------------------------------
// The LLM scheduler
//
// Optional AI runs one request at a time to limit local inference load.
// There are no speculative background inference jobs.

const MAX_PARALLEL = 1;
const waiting = []; // foreground jobs: { run, wanted, resolve, reject }
const jobs = new Map(); // content key + model -> job (so the same page is never asked twice)
let running = 0;

function pump() {
  while (running < MAX_PARALLEL && waiting.length) {
    const job = waiting.shift();
    if (!job.wanted()) {
      job.resolve(null);
      continue;
    }
    running++;
    Promise.resolve()
      .then(job.run)
      .then(job.resolve, job.reject)
      .finally(() => {
        running--;
        pump();
      });
  }
}

function schedule(job) {
  return new Promise((resolve, reject) => {
    Object.assign(job, { resolve, reject });
    waiting.push(job);
    pump();
  });
}

/**
 * The verdict for one piece of content: remembered, already being worked on
 * (then we join that request), or freshly judged.
 */
async function verdictFor(decision, ctx, { getMeta, wanted = () => true }) {
  const llm = ctx.settings.llm;
  const cached = await cachedVerdict(decision.key, llm);
  if (cached) return cached;

  const id = `${decision.key}|${llmFingerprint(llm)}`;
  const existing = jobs.get(id);
  if (existing) {
    // Join an existing request for this exact page.
    existing.wantedBy.push(wanted);
    pump();
    return existing.promise;
  }

  const job = { wantedBy: [wanted] };
  job.wanted = () => job.wantedBy.some(w => w());
  job.promise = (async () => {
    const meta = await getMeta(job.wanted);
    if (!job.wanted()) return null;
    return judge(meta, decision, ctx, { job });
  })().finally(() => jobs.delete(id));
  jobs.set(id, job);
  return job.promise;
}

/**
 * Ask local AI; if it can't be reached, the offline model decides.
 * Remembers safe decisions unless `learn` is false (Settings → Test a page).
 */
export async function judge(meta, decision, ctx, { job = null, learn = true } = {}) {
  meta = sanitizeMetadata(meta);
  if (meta.privacyProtected) return { verdict: "block", source: "privacy", reason: PRIVACY_REASON, title: "" };
  const llm = ctx.settings.llm;
  if (!llm.enabled) return { ...offlineVerdict(meta, await getModel()), title: meta.title || "" };
  const task = job || { wanted: () => true };
  let llmError = null;

  try {
    const answer = await schedule(Object.assign(task, { run: () => askLlm(meta, llm) }));
    if (!answer) return null; // nobody wants this any more
    reportLlmStatus({ ok: true, model: answer.model || llm.model });
    const verdict = {
      verdict: answer.verdict,
      source: "llm",
      reason: answer.verdict === "allow" ? "Study/tech content" : "Not verified as study/tech content",
      site: answer.site || "",
      wholeSiteStudy: answer.wholeSiteStudy === true,
      title: meta.title || ""
    };
    if (learn) learnFrom(meta, decision, verdict, llm);
    return verdict;
  } catch (error) {
    llmError = error;
    reportLlmStatus({ ok: false, error: error.message, kind: error.kind || "error", model: llm.model });
  }

  const offline = offlineVerdict(meta, await getModel());
  return {
    ...offline,
    title: meta.title || "",
    reason: `${offline.reason} · LLM unavailable`,
    llmError: llmError.message
  };
}

function learnFrom(meta, decision, verdict, llm) {
  const now = Date.now();
  const { title: _title, ...safeVerdict } = verdict;
  const cached = { ...safeVerdict, fp: llmFingerprint(llm), at: now };
  // Visible to the next queued LLM request right away, before storage catches up.
  cachePromise = Promise.all([getVerdictCache(), storageKey(decision.key)]).then(([cache, key]) => ({ ...cache, [key]: cached }));

  queueWrite(async () => {
    const data = await chrome.storage.local.get([KEYS.verdictCache, KEYS.sites]);

    // 1. Remember the verdict for this exact page/video.
    const cache = data[KEYS.verdictCache] || {};
    cache[await storageKey(decision.key)] = cached;
    const keys = Object.keys(cache);
    if (keys.length > LIMITS.verdictCacheEntries) {
      keys.sort((a, b) => cache[a].at - cache[b].at)
        .slice(0, keys.length - LIMITS.verdictCacheEntries)
        .forEach(k => delete cache[k]);
    }
    cachePromise = Promise.resolve(cache);

    // Do not retain raw metadata as training examples. The bundled model and
    // hashed verdict/site cache still provide the fast path.

    // 3. Collect evidence about the whole site (see siteType() for when it counts).
    const sites = data[KEYS.sites] || {};
    const host = decision.host;
    if (!isYouTubeHost(host)) {
      sites[host] = recordSitePage(sites[host], { verdict: verdict.verdict, vote: verdict.site, reason: verdict.reason }, now);
      if (verdict.site) {
        // Trust only an explicit whole-site AI verdict backed by its homepage.
        // Never infer domain-wide trust from our own fast classifier guesses.
        const reviewedStudy = verdict.verdict === "allow" && verdict.site === "study" &&
          verdict.wholeSiteStudy === true && Boolean(meta.site?.title || meta.site?.description);
        sites[host].review = {
          source: "llm", version: 1, at: now,
          type: reviewedStudy ? "study" : verdict.site === "distraction" ? "distraction" : "mixed",
          reason: verdict.reason
        };
      }
    }

    await store.set({
      [KEYS.verdictCache]: cache,
      [KEYS.sites]: pruneSites(sites)
    });
  });
}

export function trimTraining(training) {
  if (training.length <= LIMITS.trainingExamples) return training;
  // Keep every user correction; drop the oldest LLM-labelled examples first.
  const user = training.filter(e => e.source === "user");
  const llm = training.filter(e => e.source !== "user");
  return [...user, ...llm.slice(-(LIMITS.trainingExamples - user.length))];
}

function reportLlmStatus(status) {
  if (status.error) status = { ...status, error: "Local AI unavailable. Check the Ollama server/model and extension-origin settings." };
  const signature = JSON.stringify(status);
  if (signature === lastLlmStatus) return;
  lastLlmStatus = signature;
  queueWrite(() => store.set({ [KEYS.llmStatus]: { ...status, at: Date.now() } }));
}

// ---------------------------------------------------------------------------
// Blocking

export function blockedPageUrl(info) {
  const isPrivate = info.kind === "privacy" || privateUrl(info.url);
  const params = new URLSearchParams({
    url: publicUrl(info.url, { originOnly: isPrivate }),
    kind: info.kind || "content",
    reason: info.reason || "",
    source: info.source || "",
    title: isPrivate ? "" : sanitizeMetadata({ title: info.title }, info.url).title || ""
  });
  return `${chrome.runtime.getURL("src/pages/blocked/blocked.html")}?${params}`;
}

async function blockTab(tabId, entry, info) {
  if (!isCurrent(tabId, entry)) return;
  // A slow verdict or a late redirect event must not replace a newer page.
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!isCurrent(tabId, entry)) return;
    if (stripHash(tab.pendingUrl || tab.url) !== stripHash(entry.url)) {
      tabs.delete(tabId); // let the committed document's next hello re-evaluate
      return;
    }
  } catch { return; }
  entry.state = "blocked";
  try {
    await chrome.tabs.update(tabId, { url: blockedPageUrl({ ...info, url: entry.url }) });
  } catch {
    return; // tab was closed
  }
  const now = Date.now();
  const parsed = parseUrl(entry.url);
  queueWrite(async () => {
    const data = await chrome.storage.local.get([KEYS.stats, KEYS.history]);
    // A privacy block stores a count only: no private URL, host, title or reason.
    const isPrivate = info.kind === "privacy" || privateUrl(entry.url);
    await store.set({
      [KEYS.stats]: recordBlock(data[KEYS.stats], now),
      [KEYS.history]: isPrivate ? data[KEYS.history] || [] : appendHistory(data[KEYS.history], {
        at: now,
        url: publicUrl(entry.url, { originOnly: true }),
        host: parsed ? normalizeHost(parsed.hostname) : "",
        title: parsed ? normalizeHost(parsed.hostname) : "",
        kind: info.kind,
        reason: info.reason || "",
        source: info.source || ""
      })
    });
  });
}

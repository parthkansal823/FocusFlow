// The tab controller: the single place where navigations are judged.
//
//   navigation ─▶ decide() ─┬─ allow ─────────────────────────────▶ page opens
//                           ├─ block ─────────────────────────────▶ blocked page
//                           └─ check ─▶ page held ("pending", media paused, covered)
//                                     ─▶ remembered verdict?
//                                     ─▶ metadata (page DOM + YouTube/site info from the net)
//                                     ─▶ local LLM (thinking)  ──▶ site evidence + trains offline model
//                                         └─ unavailable ─▶ offline model (strict: unsure = block)
//                                     ─▶ allow | block
//
// Content scripts never decide anything; they mirror the state we push and
// hand over page metadata when asked.

import { LIMITS } from "../shared/defaults.js";
import { buildModel, metadataText, offlineVerdict } from "../shared/offline.js";
import { decide, recordSitePage } from "../shared/policy.js";
import { isWebUrl, isYouTubeHost, normalizeHost, parseUrl, youtubeVideoId } from "../shared/rules.js";
import { appendHistory, recordBlock } from "../shared/stats.js";
import * as store from "../shared/store.js";
import { KEYS } from "../shared/store.js";
import { askLlm } from "./llm.js";
import { pageFromNet, siteProfileFromNet, youtubeFromNet } from "./metadata.js";

const tabs = new Map(); // tabId -> { url, state: "checking"|"pending"|"allowed"|"blocked", version }
let stateVersion = 0;
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
  return [llm.baseUrl, llm.model].join("|");
}

async function cachedVerdict(key, llm) {
  const entry = (await getVerdictCache())[key];
  if (!entry || entry.fp !== llmFingerprint(llm) || Date.now() - entry.at > LIMITS.verdictCacheTtlMs) return null;
  return entry;
}

export function forgetVerdict(key) {
  return queueWrite(async () => {
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
    .sendMessage(tabId, { type: "ff:state", state, version: entry.version }, { frameId: 0 })
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
    console.error("[FocusFlow] evaluation failed", url, error);
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
  return { state: current.state === "allowed" ? "allowed" : "pending", version: current.version };
}

// ---------------------------------------------------------------------------
// Evaluation

const BLOCK_REASONS = {
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
  if (decision.action === "allow") {
    setState(tabId, entry, "allowed");
    return;
  }
  if (decision.action === "block") {
    await blockTab(tabId, entry, {
      kind: decision.reason,
      source: decision.reason === "site" ? "site" : "rule",
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
  let verdict = null;
  for (let attempt = 0; !verdict && attempt < 2 && stillWanted(); attempt++) {
    verdict = await verdictFor(decision, ctx, {
      priority: PRIORITY.now,
      wanted: onThisPage,
      getMeta: wanted => gatherMetadata(decision, entry.url, { tabId, stillWanted: wanted })
    });
  }
  if (!verdict || !stillWanted()) return;

  if (verdict.verdict === "block") {
    await blockTab(tabId, entry, {
      kind: "content",
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
// Pre-judging: links you are likely to open (videos on screen, the link under
// the mouse) are judged in the background, so the click is instant.

export async function prefetch(urls, reason) {
  const ctx = await getContext();
  if (Date.now() - lastLlmFailureAt < 60_000) return { queued: 0 }; // server down: don't pile up
  const priority = reason === "hover" ? PRIORITY.hover : PRIORITY.visible;
  let queued = 0;
  for (const url of (Array.isArray(urls) ? urls : []).slice(0, 8)) {
    if (!isWebUrl(url)) continue;
    const decision = decide(url, ctx);
    if (decision.action !== "check") continue;
    queued++;
    verdictFor(decision, ctx, {
      priority,
      prefetch: true,
      getMeta: () => gatherMetadata(decision, url)
    }).catch(() => {});
  }
  return { queued };
}

/**
 * Collect everything we know about the content at `url`.
 * With a tab, page metadata comes from the live DOM; without one (Settings
 * "test a page"), from the network.
 */
export async function gatherMetadata(decision, url, { tabId = null, stillWanted = () => true } = {}) {
  const base = { url, host: decision.host, kind: decision.kind };

  if (decision.kind === "youtube") {
    const fromNet = await youtubeFromNet(youtubeVideoId(url));
    if (fromNet) return { ...base, ...fromNet };
  }

  // The site profile helps but must not slow the answer down: if it isn't known
  // yet, wait briefly and let it finish in the background for next time.
  const profile = isYouTubeHost(decision.host) ? null : siteProfile(decision.host);
  const [page, site] = await Promise.all([
    tabId === null ? pageFromNet(url) : metadataFromTab(tabId, url, stillWanted),
    profile && Promise.race([profile, sleep(LIMITS.siteProfileWaitMs).then(() => null)])
  ]);
  let pageMeta = page;
  if (!pageMeta && tabId !== null && stillWanted()) pageMeta = await pageFromNet(url);
  const meta = { ...base, ...(pageMeta || {}), url, site };
  if (decision.kind === "youtube") meta.title = String(meta.title || "").replace(/\s*-\s*YouTube$/i, "");
  return meta;
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
      if (meta && stripHash(meta.url) === stripHash(url)) return meta;
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
// Two requests run at once. What you are opening right now always goes first;
// pre-judging uses at most one slot, so it never makes you wait.

const PRIORITY = { now: 0, hover: 1, visible: 2 };
const MAX_PARALLEL = 2;
const MAX_PREFETCH_WAITING = 12;
const waiting = []; // jobs: { run, priority, seq, wanted, resolve, reject }
const jobs = new Map(); // content key + model -> job (so the same page is never asked twice)
let running = 0;
let runningPrefetch = 0;
let jobSeq = 0;
let lastLlmFailureAt = 0;

function pump() {
  waiting.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
  while (running < MAX_PARALLEL && waiting.length) {
    const job = waiting[0];
    const background = job.priority > PRIORITY.now;
    if (background && runningPrefetch >= 1) break;
    waiting.shift();
    if (!job.wanted()) {
      job.resolve(null);
      continue;
    }
    running++;
    if (background) runningPrefetch++;
    Promise.resolve()
      .then(job.run)
      .then(job.resolve, job.reject)
      .finally(() => {
        running--;
        if (background) runningPrefetch--;
        pump();
      });
  }
}

function schedule(job) {
  return new Promise((resolve, reject) => {
    Object.assign(job, { resolve, reject, seq: ++jobSeq });
    waiting.push(job);
    const queued = waiting.filter(j => j.priority > PRIORITY.now);
    if (queued.length > MAX_PREFETCH_WAITING) {
      // Drop the oldest, least likely pre-judgement.
      queued.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
      const dropped = queued[0];
      waiting.splice(waiting.indexOf(dropped), 1);
      dropped.resolve(null);
    }
    pump();
  });
}

/**
 * The verdict for one piece of content: remembered, already being worked on
 * (then we join that request), or freshly judged.
 */
async function verdictFor(decision, ctx, { priority, getMeta, wanted = () => true, prefetch = false }) {
  const llm = ctx.settings.llm;
  const cached = await cachedVerdict(decision.key, llm);
  if (cached) return cached;

  const id = `${decision.key}|${llmFingerprint(llm)}`;
  const existing = jobs.get(id);
  if (existing) {
    // Someone else started this one; take it over at our (higher) priority.
    existing.priority = Math.min(existing.priority, priority);
    existing.wantedBy.push(wanted);
    if (!prefetch) existing.prefetch = false;
    pump();
    return existing.promise;
  }

  const job = { priority, prefetch, wantedBy: [wanted] };
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
 * Ask the thinking LLM; if it can't be reached, the offline model decides.
 * Learns from every LLM answer unless `learn` is false (Settings → Test a page).
 */
export async function judge(meta, decision, ctx, { job = null, learn = true } = {}) {
  const llm = ctx.settings.llm;
  const task = job || { priority: PRIORITY.now, prefetch: false, wanted: () => true };
  let llmError = null;

  try {
    const answer = await schedule(Object.assign(task, { run: () => askLlm(meta, llm) }));
    if (!answer) return null; // nobody wants this any more
    reportLlmStatus({ ok: true, model: answer.model || llm.model });
    const verdict = {
      verdict: answer.verdict,
      source: "llm",
      reason: answer.reason || (answer.verdict === "allow" ? "Study/tech content" : "Not study/tech content"),
      site: answer.site || "",
      title: meta.title || ""
    };
    if (learn) learnFrom(meta, decision, verdict, llm);
    return verdict;
  } catch (error) {
    llmError = error;
    if (error.kind === "unreachable" || error.kind === "timeout") lastLlmFailureAt = Date.now();
    reportLlmStatus({ ok: false, error: error.message, kind: error.kind || "error", model: llm.model });
  }

  // Only someone actually waiting on this page needs the offline answer.
  if (task.prefetch) return null;
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
  const cached = { ...verdict, fp: llmFingerprint(llm), at: now };
  // Visible to the next queued LLM request right away, before storage catches up.
  cachePromise = getVerdictCache().then(cache => ({ ...cache, [decision.key]: cached }));

  queueWrite(async () => {
    const data = await chrome.storage.local.get([KEYS.verdictCache, KEYS.training, KEYS.sites]);

    // 1. Remember the verdict for this exact page/video.
    const cache = data[KEYS.verdictCache] || {};
    cache[decision.key] = cached;
    const keys = Object.keys(cache);
    if (keys.length > LIMITS.verdictCacheEntries) {
      keys.sort((a, b) => cache[a].at - cache[b].at)
        .slice(0, keys.length - LIMITS.verdictCacheEntries)
        .forEach(k => delete cache[k]);
    }
    cachePromise = Promise.resolve(cache);

    // 2. Teach the offline model.
    const training = (data[KEYS.training] || []).filter(e => e.key !== decision.key);
    training.push({
      key: decision.key,
      text: metadataText(meta),
      label: verdict.verdict === "allow" ? "study" : "distraction",
      source: "llm",
      at: now
    });

    // 3. Collect evidence about the whole site (see siteType() for when it counts).
    const sites = data[KEYS.sites] || {};
    const host = decision.host;
    if (!isYouTubeHost(host)) {
      sites[host] = recordSitePage(sites[host], { verdict: verdict.verdict, vote: verdict.site, reason: verdict.reason }, now);
    }

    await store.set({
      [KEYS.verdictCache]: cache,
      [KEYS.training]: trimTraining(training),
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
  const signature = JSON.stringify(status);
  if (signature === lastLlmStatus) return;
  lastLlmStatus = signature;
  queueWrite(() => store.set({ [KEYS.llmStatus]: { ...status, at: Date.now() } }));
}

// ---------------------------------------------------------------------------
// Blocking

export function blockedPageUrl(info) {
  const params = new URLSearchParams({
    url: info.url,
    kind: info.kind || "content",
    reason: info.reason || "",
    source: info.source || "",
    title: info.title || "",
    key: info.key || ""
  });
  return `${chrome.runtime.getURL("src/pages/blocked/blocked.html")}?${params}`;
}

async function blockTab(tabId, entry, info) {
  if (!isCurrent(tabId, entry)) return;
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
    await store.set({
      [KEYS.stats]: recordBlock(data[KEYS.stats], now),
      [KEYS.history]: appendHistory(data[KEYS.history], {
        at: now,
        url: entry.url,
        host: parsed ? normalizeHost(parsed.hostname) : "",
        title: info.title || "",
        kind: info.kind,
        reason: info.reason || "",
        source: info.source || ""
      })
    });
  });
}

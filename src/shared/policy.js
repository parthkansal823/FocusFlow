// The decision engine: given a URL, what should happen right now?
// Pure and synchronous so it is easy to test. Anything that needs a content
// judgement comes back as { action: "check" } and is handled by the background
// controller (metadata -> local LLM -> offline model).
//
// Order of precedence:
//   1. page you marked as a distraction         -> block
//   2. your own site rules (most specific wins)  -> allow / block
//   3. page you marked as study content          -> allow
//   4. learned site, on evidence (never YouTube) -> study: allow, distraction: block
//   5. everything else                           -> check this page's content

import { contentKey, findRule, isLocalHost, isWebUrl, isYouTubeHost, normalizeHost, parseUrl, youtubeVideoId } from "./rules.js";
import { localDateKey } from "./stats.js";

/**
 * @param {string} url
 * @param {{settings: object, overrides: object, sites: object}} ctx
 * @returns {{action: "allow", reason: string}
 *         | {action: "block", reason: "rule"|"marked"|"site", pattern?: string, key?: string, host?: string}
 *         | {action: "check", key: string, kind: "youtube"|"page", host: string}}
 */
export function decide(url, ctx) {
  const parsed = parseUrl(url);
  if (!parsed || !isWebUrl(parsed.href)) return { action: "allow", reason: "not-web" };
  if (isLocalHost(parsed.hostname)) return { action: "allow", reason: "local" };

  const host = normalizeHost(parsed.hostname);
  const key = contentKey(parsed);
  const mark = ctx.overrides && ctx.overrides[key];
  if (mark && mark.verdict === "block") return { action: "block", reason: "marked", key };

  const rule = findRule(ctx.settings.rules, parsed);
  if (rule && rule.action === "allow") return { action: "allow", reason: "rule" };
  if (rule && rule.action === "block") return { action: "block", reason: "rule", pattern: rule.pattern };

  if (mark && mark.verdict === "allow") return { action: "allow", reason: "marked" };

  const kind = youtubeVideoId(parsed) ? "youtube" : "page";
  const type = isYouTubeHost(host) ? "mixed" : siteType(ctx.sites && ctx.sites[host]);
  if (type === "study") return { action: "allow", reason: "site" };
  if (type === "distraction") return { action: "block", reason: "site", host };
  return { action: "check", key, kind, host };
}

// ---------------------------------------------------------------------------
// Learned sites
//
// A whole site is only ever opened or blocked on evidence, never on one guess:
// it needs SITE_EVIDENCE pages judged the same way, *no* page judged the other
// way, and the AI must agree about what kind of site it is. One study page on
// a site (judged by the AI or marked by you) makes it "mixed" for good, so
// platforms like YouTube, Reddit or Medium are always judged page by page.

export const SITE_EVIDENCE = 3;

function topVote(votes) {
  let best = "";
  let count = 0;
  for (const [type, n] of Object.entries(votes || {})) {
    if (n > count) [best, count] = [type, n];
  }
  return best;
}

/** "study" | "distraction" | "mixed" | "" (still learning) */
export function siteType(record) {
  if (!record) return "";
  const allowed = record.allowed || 0;
  const blocked = record.blocked || 0;
  if (allowed > 0 && blocked > 0) return "mixed";
  const vote = topVote(record.votes);
  if (vote === "distraction" && blocked >= SITE_EVIDENCE && allowed === 0) return "distraction";
  if (vote === "study" && allowed >= SITE_EVIDENCE && blocked === 0) return "study";
  if (vote === "mixed") return "mixed";
  return "";
}

/** Records one judged page of `host` (verdict "allow"/"block", optional AI site vote). */
export function recordSitePage(record, { verdict, vote = "", reason = "" }, now) {
  const next = { ...(record || {}) };
  next.votes = { ...(next.votes || {}) };
  if (vote) next.votes[vote] = (next.votes[vote] || 0) + 1;
  if (verdict === "allow") next.allowed = (next.allowed || 0) + 1;
  else next.blocked = (next.blocked || 0) + 1;
  if (reason) next.reason = reason;
  next.at = now;
  return next;
}

// Keeps the fetched home-page profile, drops everything that was learned.
export function forgetSiteRecord(record) {
  const next = { ...(record || {}) };
  for (const key of ["votes", "allowed", "blocked", "reason", "at", "type"]) delete next[key];
  return next;
}

// How many "this is study content" marks were used today (they are limited per day).
export function studyMarksToday(overrides, now = Date.now()) {
  const today = localDateKey(now);
  return Object.values(overrides || {}).filter(m => m.verdict === "allow" && localDateKey(m.at) === today).length;
}

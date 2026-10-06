// The decision engine: given a URL, what should happen right now?
// Pure and synchronous so it is easy to test. Anything that needs a content
// judgement comes back as { action: "check" } and is handled by the background
// controller (metadata -> local LLM -> offline model).
//
// Order of precedence:
//   1. privacy guard / hard-mode surfaces        -> block
//   2. distraction marks and your block rules     -> block
//   3. old study marks / allow rules              -> ignored
//   4. AI-reviewed study site (never YouTube)     -> allow without scanning
//   5. learned site, on evidence (never YouTube) -> study: allow, distraction: block
//   6. everything else                           -> check this page's content

import { contentKey, findRule, isLocalHost, isWebUrl, isYouTubeHost, normalizeHost, parseUrl, youtubeVideoId } from "./rules.js";
import { localDateKey } from "./stats.js";
import { hardBlockReason } from "./hard-mode.js";
import { LIMITS } from "./defaults.js";
import { privateUrl, PRIVACY_REASON } from "./privacy.js";

/**
 * @param {string} url
 * @param {{settings: object, overrides: object, sites: object}} ctx
 * @returns {{action: "allow", reason: string}
 *         | {action: "block", reason: "privacy"|"hard"|"rule"|"marked"|"site", detail?: string, pattern?: string, key?: string, host?: string}
 *         | {action: "check", key: string, kind: "youtube"|"page", host: string}}
 */
export function decide(url, ctx) {
  const parsed = parseUrl(url);
  if (!parsed || !isWebUrl(parsed.href)) return { action: "allow", reason: "not-web" };
  if (isLocalHost(parsed.hostname)) return { action: "allow", reason: "local" };
  // Leave the browser's own parental-control notice visible. This does not
  // allow the original website or alter any browser/OS restriction.
  if (parsed.hostname === "sdx.microsoft.com" && parsed.pathname === "/family/restricted-web") {
    return { action: "allow", reason: "browser-safety" };
  }
  // Privacy wins even over an AI-trusted domain. Never use sensitive URL values
  // to infer an educational purpose or allow them via a saved site verdict.
  if (privateUrl(parsed.href)) return { action: "block", reason: "privacy", detail: PRIVACY_REASON };
  const hardReason = hardBlockReason(parsed);
  if (hardReason) return { action: "block", reason: "hard", detail: hardReason };

  const host = normalizeHost(parsed.hostname);
  const key = contentKey(parsed);
  const mark = ctx.overrides && ctx.overrides[key];
  if (mark && mark.verdict === "block") return { action: "block", reason: "marked", key };

  const rule = findRule(ctx.settings.rules, parsed);
  if (rule && rule.action === "block") return { action: "block", reason: "rule", pattern: rule.pattern };

  const kind = youtubeVideoId(parsed) ? "youtube" : "page";
  const type = isYouTubeHost(host) ? "mixed" : siteType(ctx.sites && ctx.sites[host]);
  if (type === "study") return { action: "allow", reason: "site" };
  if (type === "distraction") return { action: "block", reason: "site", host };
  return { action: "check", key, kind, host };
}

// ---------------------------------------------------------------------------
// Learned sites
//
// Dedicated-study trust requires an explicit AI homepage + page review, and
// expires in 7 days. Legacy study evidence and whole-site distraction blocking
// require 3 agreeing pages. A conflicting page removes whole-site study trust.
// YouTube always remains page-by-page, irrespective of stored site reviews.

export const SITE_EVIDENCE = 3;

export function siteReview(record, now = Date.now()) {
  const review = record?.review;
  return review?.source === "llm" && review.version === 1 &&
    ["study", "mixed", "distraction"].includes(review.type) &&
    Number.isFinite(review.at) && review.at <= now && now - review.at < LIMITS.siteReviewTtlMs
    ? review : null;
}

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
  const review = siteReview(record);
  if (review?.type === "study" && allowed > 0 && blocked === 0) return "study";
  if (review?.type === "mixed") return "mixed";
  const vote = topVote(record.votes);
  if (vote === "distraction" && blocked >= SITE_EVIDENCE && allowed === 0) return "distraction";
  if (!record.review && vote === "study" && allowed >= SITE_EVIDENCE && blocked === 0) return "study";
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
  for (const key of ["votes", "allowed", "blocked", "reason", "at", "type", "review"]) delete next[key];
  return next;
}

// How many "this is study content" marks were used today (they are limited per day).
export function studyMarksToday(overrides, now = Date.now()) {
  const today = localDateKey(now);
  return Object.values(overrides || {}).filter(m => m.verdict === "allow" && localDateKey(m.at) === today).length;
}

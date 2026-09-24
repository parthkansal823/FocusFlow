// URL helpers and site-rule matching. Pure functions, no browser APIs.

import { RULE_ACTIONS } from "./defaults.js";

const YOUTUBE_HOSTS = new Set(["youtube.com", "m.youtube.com", "music.youtube.com"]);

export function isWebUrl(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

// Your own dev servers are never checked.
export function isLocalHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "[::1]";
}

export function isYouTubeHost(host) {
  return YOUTUBE_HOSTS.has(normalizeHost(host));
}

export function parseUrl(url) {
  if (url instanceof URL) return url;
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

export function normalizeHost(hostname) {
  return String(hostname || "")
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^www\./, "");
}

function normalizePath(pathname) {
  const path = String(pathname || "").toLowerCase().replace(/\/+$/, "");
  return path === "/" ? "" : path;
}

// Turns user input like "https://www.Reddit.com/r/LeetCode/" or "*.twitch.tv"
// into { host: "reddit.com", path: "/r/leetcode" }. Returns null for junk.
export function parsePattern(raw) {
  let text = String(raw || "").trim().toLowerCase();
  if (!text) return null;
  text = text.replace(/^[a-z]+:\/\//, "").replace(/^\*\./, "").replace(/[?#].*$/, "");
  const slash = text.indexOf("/");
  const host = normalizeHost(slash === -1 ? text : text.slice(0, slash));
  const path = slash === -1 ? "" : normalizePath(text.slice(slash));
  if (!/^[a-z0-9.-]+(:\d+)?$/.test(host)) return null;
  if (!host.includes(".") && !host.startsWith("localhost")) return null;
  return { host, path };
}

export function formatPattern({ host, path }) {
  return host + (path || "");
}

export function normalizeRules(rules) {
  const byPattern = new Map();
  for (const rule of Array.isArray(rules) ? rules : []) {
    const parsed = parsePattern(rule && rule.pattern);
    if (!parsed || !RULE_ACTIONS.includes(rule.action)) continue;
    const pattern = formatPattern(parsed);
    byPattern.delete(pattern); // later entries win and move to the end
    byPattern.set(pattern, { pattern, action: rule.action });
  }
  return [...byPattern.values()];
}

function hostMatches(host, ruleHost) {
  return host === ruleHost || host.endsWith("." + ruleHost);
}

function pathMatches(path, rulePath) {
  return !rulePath || path === rulePath || path.startsWith(rulePath + "/");
}

// The most specific rule wins: longer host first, then longer path.
export function findRule(rules, url) {
  const parsedUrl = parseUrl(url);
  if (!parsedUrl) return null;
  const host = normalizeHost(parsedUrl.hostname);
  const path = normalizePath(parsedUrl.pathname);

  let best = null;
  let bestScore = -1;
  for (const rule of rules || []) {
    const parsed = parsePattern(rule.pattern);
    if (!parsed || !hostMatches(host, parsed.host) || !pathMatches(path, parsed.path)) continue;
    const score = parsed.host.length * 1000 + parsed.path.length;
    if (score >= bestScore) {
      best = rule;
      bestScore = score;
    }
  }
  return best;
}

export function youtubeVideoId(url) {
  const u = parseUrl(url);
  if (!u) return null;
  const host = normalizeHost(u.hostname);
  if (host === "youtu.be") return cleanVideoId(u.pathname.slice(1));
  if (!YOUTUBE_HOSTS.has(host)) return null;
  if (u.pathname === "/watch") return cleanVideoId(u.searchParams.get("v"));
  const live = u.pathname.match(/^\/live\/([^/]+)/);
  return live ? cleanVideoId(live[1]) : null;
}

function cleanVideoId(id) {
  return id && /^[A-Za-z0-9_-]{6,20}$/.test(id) ? id : null;
}

// Tracking/position parameters that don't change what a page is about.
const IGNORED_PARAMS = /^(utm_\w+|fbclid|gclid|igshid|si|feature|ref|ref_src|source|t|start|pp|ab_channel)$/i;

// Stable identity for a piece of content: one YouTube video, or one page.
// The query is kept (a Google search for "dp" is not a search for "movies").
export function contentKey(url) {
  const videoId = youtubeVideoId(url);
  if (videoId) return `yt:${videoId}`;
  const u = parseUrl(url);
  if (!u) return null;
  const params = [...u.searchParams]
    .filter(([name]) => !IGNORED_PARAMS.test(name))
    .map(([name, value]) => `${name.toLowerCase()}=${value.trim().toLowerCase()}`)
    .sort();
  return `page:${normalizeHost(u.hostname)}${normalizePath(u.pathname)}${params.length ? `?${params.join("&")}` : ""}`;
}

// "/r/leetcode/comments/abc/how_to_learn_dp/" -> "r leetcode comments abc how to learn dp"
export function urlWords(url) {
  const u = parseUrl(url);
  if (!u) return "";
  let path = u.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    // keep the raw path
  }
  return path.replace(/[/_\-+.]+/g, " ").trim();
}

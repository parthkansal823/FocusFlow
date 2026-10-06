// Hard mode is always on. These distraction surfaces are blocked without AI;
// individual articles, tutorials, search results and lectures are still judged.
export function hardBlockReason(url) {
  const host = url.hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  let decodedPath = url.pathname;
  try { decodedPath = decodeURIComponent(decodedPath); } catch { /* Keep invalid encoding unchanged. */ }
  const path = decodedPath.replace(/\/{2,}/g, "/").replace(/\/+$/, "").toLowerCase() || "/";
  const belongs = domain => host === domain || host.endsWith(`.${domain}`);
  if (belongs("youtube.com")) {
    if (/^\/shorts(?:\/|$)/.test(path) || /\/@[^/]+\/shorts$/.test(path)) return "Hard mode: YouTube Shorts are blocked";
    if (["/", "/feed/trending", "/feed/subscriptions", "/feed/explore", "/gaming"].includes(path)) return "Hard mode: recommendation feeds are blocked; use a study search or lecture link";
  }
  if (belongs("tiktok.com")) return "Hard mode: short-video feeds are blocked";
  const feeds = {
    "instagram.com": /^\/(?:$|reels?(?:\/|$)|stories(?:\/|$)|explore(?:\/|$))/, 
    "facebook.com": /^\/(?:$|watch(?:\/|$)|reels?(?:\/|$)|stories(?:\/|$))/, 
    "x.com": /^\/(?:$|home$|explore(?:\/|$)|i\/bookmarks$)/,
    "twitter.com": /^\/(?:$|home$|explore(?:\/|$)|i\/bookmarks$)/,
    "reddit.com": /^\/(?:$|r\/(?:all|popular)(?:\/|$))/, 
    "linkedin.com": /^\/feed(?:\/|$)/,
    "snapchat.com": /^\/spotlight(?:\/|$)/
  };
  for (const [domain, pattern] of Object.entries(feeds)) {
    if (belongs(domain) && pattern.test(path)) return "Hard mode: social feeds, Reels and Stories are blocked";
  }
  return "";
}

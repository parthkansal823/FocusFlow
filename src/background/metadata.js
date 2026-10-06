// Where FocusFlow gets its facts from:
//   - the page itself (the content script reads title, description, OpenGraph, JSON-LD, h1)
//   - the network: YouTube's watch page for a video id (category, description, tags),
//     and a site's home page to learn what the site is about.

import { LIMITS } from "../shared/defaults.js";
import { parseHtmlMeta, parseYouTubeWatch } from "./html-meta.js";
import { privateNetwork, privateUrl, publicUrl, sanitizeMetadata, protectedMeta } from "../shared/privacy.js";

const safeRequest = url => {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && !privateNetwork(u.hostname) && !privateUrl(url) && (!u.port || u.port === "443");
  } catch { return false; }
};

// Bounded reads also prevent large responses from consuming unlimited RAM.
async function boundedText(res) {
  if (!res.body?.getReader) return (await res.text()).slice(0, LIMITS.maxHtmlChars);
  const reader = res.body.getReader(), decoder = new TextDecoder();
  let bytes = 0, text = "";
  try {
    while (bytes < LIMITS.maxHtmlChars) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const part = chunk.value.subarray(0, LIMITS.maxHtmlChars - bytes);
      bytes += part.byteLength;
      text += decoder.decode(part, { stream: true });
    }
    return text + decoder.decode();
  } finally { await reader.cancel().catch(() => {}); }
}

async function fetchHtml(url, { fetchImpl = fetch, timeoutMs = LIMITS.fetchTimeoutMs } = {}) {
  if (!safeRequest(url)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(publicUrl(url), {
      credentials: "omit",
      redirect: "error",
      signal: controller.signal,
      headers: { Accept: "text/html,application/xhtml+xml", "Accept-Language": "en-US,en;q=0.8" }
    });
    if (!res.ok) return null;
    const type = (res.headers && res.headers.get("content-type")) || "";
    if (type && !/html/i.test(type)) return null;
    return await boundedText(res);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, { fetchImpl = fetch, timeoutMs = LIMITS.fetchTimeoutMs } = {}) {
  if (!safeRequest(url)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { credentials: "omit", redirect: "error", signal: controller.signal });
    return res.ok ? JSON.parse(await boundedText(res)) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Full metadata of one YouTube video, straight from YouTube (not the possibly stale tab). */
export async function youtubeFromNet(videoId, options) {
  const id = encodeURIComponent(videoId);
  const html = await fetchHtml(`https://www.youtube.com/watch?v=${id}&hl=en`, options);
  if (html) {
    const meta = parseYouTubeWatch(html);
    if (meta.title) return sanitizeMetadata({ ...meta, kind: "youtube" }, `https://www.youtube.com/watch?v=${id}`);
  }
  const watchUrl = `https://www.youtube.com/watch?v=${id}`;
  const oembed = await fetchJson(
    `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watchUrl)}`,
    options
  );
  if (oembed && typeof oembed.title === "string") {
    return sanitizeMetadata({ title: oembed.title, channel: oembed.author_name || "", siteName: "YouTube", type: "video", kind: "youtube" }, watchUrl);
  }
  return null;
}

/** Metadata of any page, fetched without cookies. */
export async function pageFromNet(url, options) {
  if (privateUrl(url)) return protectedMeta(url);
  const html = await fetchHtml(url, options);
  if (!html) return null;
  if (/<input\b[^>]*\btype\s*=\s*["']?password\b|\bcontenteditable\s*=|<meta\b[^>]*\bcontent\s*=\s*["'][^"']*noindex/i.test(html)) return protectedMeta(url);
  const headEnd = html.search(/<\/head>/i);
  // Generic classification uses the head only, never paragraphs or message DOM.
  const meta = sanitizeMetadata(parseHtmlMeta(headEnd >= 0 ? html.slice(0, headEnd) : html.slice(0, 64_000)), url);
  if (meta.privacyProtected) return meta;
  return meta.title || meta.description ? meta : null;
}

/** What a website says about itself on its home page. */
export async function siteProfileFromNet(host, options) {
  const meta = await pageFromNet(`https://${host}/`, options);
  if (!meta || meta.privacyProtected) return null;
  return {
    title: meta.title.slice(0, 160),
    description: meta.description.slice(0, 300),
    siteName: meta.siteName.slice(0, 80)
  };
}
